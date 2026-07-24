import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { diagnosticLog, diagnosticWarn } from "../../gateway/runtime/core/diagnostics.js";

// ESM 下没有全局 require；用 createRequire 才能在运行时按需加载 electron。
const nodeRequire = createRequire(import.meta.url);

/**
 * Launcher 设置与配置持久化。迁移自 OpenCodex launcher settings。
 *
 * LAN 密码流程（安全优先级）：
 * 1. 显式配置：`OPENCLAUDE_ACCESS_PASSWORD` 提供明文密码 -> 计算 sha256 hash 写入 config.yaml。
 *    此分支不需要向 UI 展示密码（用户已知）。
 * 2. 复用既有配置：config.yaml 已存在合法 `sha256-v1:` hash -> 直接复用，无需明文。
 * 3. 自动生成：生成随机密码，只把 hash 写入 config.yaml；明文 **只** 通过本地 Launcher UI
 *    一次性展示（preload IPC），绝不写日志、URL 或配置明文。若运行环境无法展示（无窗口），
 *    resolveLauncherSettings 不会失败本身，但调用方（index.ts）必须检测 generatedPassword 并
 *    通过窗口展示；若无法展示则启动失败并提示用户设置 OPENCLAUDE_ACCESS_PASSWORD。
 *
 * config.yaml 永远只存 `sha256-v1:` 前缀的 hash，不存明文。
 */

export type PasswordSource = "none" | "env" | "config" | "generated";

export interface LauncherSettings {
  host: string;
  port: number;
  lanMode: boolean;
  authRequired: boolean;
  configPath: string;
  runtimeDir: string;
  logDir: string;
  logPath: string;
  webShellDir: string;
}

export interface ResolvedSettings extends LauncherSettings {
  /** 密码来源；generated 表示自动生成且需要 UI 一次性展示明文。 */
  passwordSource: PasswordSource;
  /**
   * 仅当 passwordSource === "generated" 时非空：待展示的明文密码。
   * 调用方必须在展示后立即消费并清空，绝不写日志/URL/配置。
   */
  generatedPassword: string;
  lanUrls: string[];
}

/** Electron 相关信息的可注入抽象，便于在 node --test 下不依赖 electron 运行时。 */
export interface AppEnvInfo {
  userDataDir: string;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

const PASSWORD_HASH_PREFIX = "sha256-v1:";

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

function isLanHost(host: string): boolean {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized !== "127.0.0.1" && normalized !== "localhost" && normalized !== "::1";
}

function localLanAddresses(): string[] {
  const result: string[] = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const list of Object.values(interfaces)) {
      if (!list) continue;
      for (const item of list) {
        if (item.family === "IPv4" && !item.internal) result.push(item.address);
      }
    }
  } catch { /* ignore */ }
  return result;
}

function generatePassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function isPrefixedPasswordHash(value: string): boolean {
  return new RegExp(`^${PASSWORD_HASH_PREFIX}[a-f0-9]{64}$`, "i").test(String(value || "").trim());
}

/**
 * 在 config.yaml 中查找 auth.password 标量并返回其（去注释后）的原始字符串值。
 * 与 gateway/runtime/http/auth.ts 的解析保持一致的语义，但只读不改写。
 */
function readAuthPasswordValue(configPath: string): string {
  if (!fs.existsSync(configPath)) return "";
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    return "";
  }
  const lines = String(raw || "").split(/\r?\n/);
  let inAuth = false;
  let authIndent = 0;
  let authChildIndent: number | null = null;
  for (const line of lines) {
    const stripped = stripYamlComment(line);
    if (!stripped.trim()) continue;
    const indent = leadingIndent(line);
    if (inAuth && indent <= authIndent) { inAuth = false; authChildIndent = null; }
    if (!inAuth && indent === 0 && /^auth\s*:\s*$/.test(stripped.trim())) {
      inAuth = true;
      authIndent = indent;
      continue;
    }
    if (!inAuth || indent <= authIndent) continue;
    if (authChildIndent == null) authChildIndent = indent;
    if (indent !== authChildIndent) continue;
    const match = line.match(/^\s*password\s*:\s*(.*)$/);
    if (match) return parseYamlStringScalar(match[1]);
  }
  return "";
}

function stripYamlComment(value: string): string {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === '"') {
      if (char === "\\") { i += 1; continue; }
      if (char === '"') quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") { i += 1; continue; }
      if (char === "'") quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}

function parseYamlStringScalar(rawValue: string): string {
  const value = stripYamlComment(String(rawValue || "")).trim();
  if (!value || value === "null" || value === "~") return "";
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) return "";
    try { return JSON.parse(value); } catch { return ""; }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) return "";
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function leadingIndent(line: string): number {
  const match = String(line || "").match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function writeConfigWithPasswordHash(configPath: string, passwordHash: string): void {
  const content = `# OpenClaude gateway config. DO NOT COMMIT.\nauth:\n  password: "${PASSWORD_HASH_PREFIX}${passwordHash}"\n`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content, "utf-8");
  } catch (error) {
    diagnosticWarn("launcher", "config_write_failed", { error: String(error) });
  }
}

/** 读取 OPENCLAUDE_CLAUDE_PATH（主）或 OPENCLAUDE_CLAUDE_INSTALL_PATH（兼容别名）。 */
export function resolveConfiguredClaudePath(env: NodeJS.ProcessEnv): string {
  return String(env.OPENCLAUDE_CLAUDE_PATH || env.OPENCLAUDE_CLAUDE_INSTALL_PATH || "").trim();
}

export function resolveLauncherSettings(
  env: NodeJS.ProcessEnv = process.env,
  appEnv?: AppEnvInfo,
): ResolvedSettings {
  const resolvedAppEnv: AppEnvInfo = appEnv ?? resolveAppEnvInfo(env);
  const runtimeDir = env.OPENCLAUDE_RUNTIME_DIR || path.join(resolvedAppEnv.userDataDir, "runtime");
  const logDir = env.OPENCLAUDE_LOG_DIR || path.join(resolvedAppEnv.userDataDir, "logs");
  const logPath = path.join(logDir, "gateway.log");
  const configPath = env.OPENCLAUDE_CONFIG_PATH || path.join(runtimeDir, "config.yaml");

  const host = env.OPENCLAUDE_HOST || env.HOST || "127.0.0.1";
  const port = Number(env.OPENCLAUDE_PORT || env.PORT || 21300);
  const lanMode = isLanHost(host);

  let webShellDir = env.OPENCLAUDE_WEB_SHELL_DIR || "";
  if (!webShellDir) {
    const devPath = path.join(projectRoot(), "web-shell");
    try {
      if (resolvedAppEnv.isPackaged) {
        webShellDir = path.join(resolvedAppEnv.resourcesPath, "web-shell");
        if (!fs.existsSync(webShellDir)) webShellDir = path.join(resolvedAppEnv.appPath, "web-shell");
      } else {
        webShellDir = devPath;
      }
    } catch { webShellDir = devPath; }
  }

  let passwordSource: PasswordSource = "none";
  let generatedPassword = "";
  let authRequired = false;

  if (lanMode) {
    authRequired = true;
    const envPassword = String(env.OPENCLAUDE_ACCESS_PASSWORD || "").trim();
    if (envPassword) {
      // 优先级 1：显式配置密码。写 hash 到 config.yaml，明文不保留、不展示。
      writeConfigWithPasswordHash(configPath, sha256Hex(envPassword));
      passwordSource = "env";
      diagnosticLog("launcher", "lan_password_from_env", {});
    } else {
      // 优先级 2：复用 config.yaml 中已有的合法 hash。
      const existing = readAuthPasswordValue(configPath);
      if (existing && isPrefixedPasswordHash(existing)) {
        passwordSource = "config";
        diagnosticLog("launcher", "lan_password_from_config", {});
      } else {
        // 优先级 3：自动生成。只写 hash，明文交给调用方通过 UI 一次性展示。
        generatedPassword = generatePassword();
        writeConfigWithPasswordHash(configPath, sha256Hex(generatedPassword));
        passwordSource = "generated";
        // 注意：此处不记录明文；调用方负责展示。
        diagnosticLog("launcher", "lan_password_generated", {});
      }
    }
  }

  const lanUrls: string[] = lanMode
    ? localLanAddresses().map((addr) => `http://${addr}:${port}/`)
    : [];

  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
  } catch { /* ignore */ }

  return {
    host, port, lanMode, authRequired, configPath, runtimeDir, logDir, logPath, webShellDir,
    passwordSource, generatedPassword, lanUrls,
  };
}

/** 默认从 electron 读取；测试或无 electron 环境下走 env/默认值。 */
function resolveAppEnvInfo(env: NodeJS.ProcessEnv): AppEnvInfo {
  const fallbackUserData = env.OPENCLAUDE_USER_DATA || path.join(os.homedir(), ".openclaude");
  try {
    // 动态 require electron，避免在 node --test（无 electron 运行时）下顶层 import 失败。
    const electron = nodeRequire("electron") as { app?: { getPath?: (n: string) => string; isPackaged?: boolean; getAppPath?: () => string } } | string;
    const app = typeof electron === "object" && electron ? electron.app : undefined;
    if (app && typeof app.getPath === "function") {
      return {
        userDataDir: app.getPath("userData"),
        isPackaged: Boolean(app.isPackaged),
        resourcesPath: process.resourcesPath || "",
        appPath: typeof app.getAppPath === "function" ? app.getAppPath() : "",
      };
    }
  } catch { /* electron 不可用，走 fallback */ }
  return {
    userDataDir: fallbackUserData,
    isPackaged: false,
    resourcesPath: "",
    appPath: "",
  };
}

export { isLanHost, localLanAddresses };
