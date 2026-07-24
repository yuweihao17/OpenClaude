import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { diagnosticLog, diagnosticWarn } from "../gateway/runtime/core/diagnostics.js";

const nodeRequire = createRequire(import.meta.url);

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
  passwordSource: PasswordSource;
  generatedPassword: string;
  lanUrls: string[];
}

export interface AppEnvInfo {
  userDataDir: string;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}

const PASSWORD_HASH_PREFIX = "sha256-v1:";

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
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
      writeConfigWithPasswordHash(configPath, sha256Hex(envPassword));
      passwordSource = "env";
      diagnosticLog("launcher", "lan_password_from_env", {});
    } else {
      const existing = readAuthPasswordValue(configPath);
      if (existing && isPrefixedPasswordHash(existing)) {
        passwordSource = "config";
        diagnosticLog("launcher", "lan_password_from_config", {});
      } else {
        generatedPassword = generatePassword();
        writeConfigWithPasswordHash(configPath, sha256Hex(generatedPassword));
        passwordSource = "generated";
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

function resolveAppEnvInfo(env: NodeJS.ProcessEnv): AppEnvInfo {
  const fallbackUserData = env.OPENCLAUDE_USER_DATA || path.join(os.homedir(), ".openclaude");
  try {
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
  } catch { /* electron not available, use fallback */ }
  return {
    userDataDir: fallbackUserData,
    isPackaged: false,
    resourcesPath: "",
    appPath: "",
  };
}

export { isLanHost, localLanAddresses };
