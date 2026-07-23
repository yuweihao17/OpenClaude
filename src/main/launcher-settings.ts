import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { diagnosticLog, diagnosticWarn } from "../../gateway/runtime/core/diagnostics.js";

/**
 * Launcher 设置与配置持久化。迁移自 OpenCodex launcher settings。
 *
 * - 运行目录收敛到 userData 下，避免污染项目源码目录。
 * - LAN 模式（host != 127.0.0.1）必须开启鉴权；若无密码则生成随机密码并写 config.yaml。
 * - 密码以 sha256-v1 hash 形式存储，明文仅在首次生成时记录到日志一次（本机可见）。
 */

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
  generatedPassword: string;
  lanUrls: string[];
}

function userDataDir(): string {
  try { return app.getPath("userData"); } catch {
    return process.env.OPENCLAUDE_USER_DATA || path.join(os.homedir(), ".openclaude");
  }
}

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

function writeConfigWithPassword(configPath: string, password: string): void {
  const hash = crypto.createHash("sha256").update(password, "utf-8").digest("hex");
  const content = `# OpenClaude gateway config. DO NOT COMMIT.\nauth:\n  password: "sha256-v1:${hash}"\n`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content, "utf-8");
  } catch (error) {
    diagnosticWarn("launcher", "config_write_failed", { error: String(error) });
  }
}

export function resolveLauncherSettings(env: NodeJS.ProcessEnv = process.env): ResolvedSettings {
  const runtimeDir = env.OPENCLAUDE_RUNTIME_DIR || path.join(userDataDir(), "runtime");
  const logDir = env.OPENCLAUDE_LOG_DIR || path.join(userDataDir(), "logs");
  const logPath = path.join(logDir, "gateway.log");
  const configPath = env.OPENCLAUDE_CONFIG_PATH || path.join(runtimeDir, "config.yaml");

  const host = env.OPENCLAUDE_HOST || env.HOST || "127.0.0.1";
  const port = Number(env.OPENCLAUDE_PORT || env.PORT || 21300);
  const lanMode = isLanHost(host);

  let webShellDir = env.OPENCLAUDE_WEB_SHELL_DIR || "";
  if (!webShellDir) {
    const devPath = path.join(projectRoot(), "web-shell");
    try {
      if (app.isPackaged) {
        webShellDir = path.join(process.resourcesPath, "web-shell");
        if (!fs.existsSync(webShellDir)) webShellDir = path.join(app.getAppPath(), "web-shell");
      } else {
        webShellDir = devPath;
      }
    } catch { webShellDir = devPath; }
  }

  let generatedPassword = "";
  let authRequired = false;

  if (lanMode) {
    authRequired = true;
    let needGenerate = true;
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, "utf-8");
        if (/password\s*:\s*\S+/.test(raw)) needGenerate = false;
      }
    } catch { /* ignore */ }
    if (needGenerate) {
      generatedPassword = generatePassword();
      writeConfigWithPassword(configPath, generatedPassword);
      diagnosticLog("launcher", "lan_password_generated", { configPath });
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
    generatedPassword, lanUrls,
  };
}

export { isLanHost, localLanAddresses };
