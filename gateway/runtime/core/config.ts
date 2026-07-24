import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 网关运行目录集中在这里定义，其它模块只消费常量，避免散落 process.env 读取。
 *
 * 与 OpenCodex 的差异：
 * - 默认绑定 127.0.0.1（loopback），局域网模式必须显式开启。
 * - 不依赖 CODEX_HOME / 官方 runtime，运行目录收敛到 OPENCLAUDE_RUNTIME_DIR 或 .data/runtime。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, "..", "..", "..");
export const DATA_DIR = path.join(PROJECT_ROOT, ".data");
export const WEB_SHELL_DIR = path.join(PROJECT_ROOT, "web-shell");
export const WEB_SHELL_ASSETS_PREFIX = "/assets/";

const RUNTIME_DIR_ENV = process.env.OPENCLAUDE_RUNTIME_DIR;
export const RUNTIME_DIR = RUNTIME_DIR_ENV
  ? path.resolve(RUNTIME_DIR_ENV)
  : path.join(DATA_DIR, "runtime");

const REPORTS_DIR_ENV = process.env.OPENCLAUDE_REPORTS_DIR;
export const REPORTS_DIR = REPORTS_DIR_ENV
  ? path.resolve(REPORTS_DIR_ENV)
  : RUNTIME_DIR_ENV
    ? path.join(RUNTIME_DIR, "reports")
    : path.join(DATA_DIR, "reports");

export const UNKNOWN_IPC_PATH = path.join(REPORTS_DIR, "unknown-ipc.jsonl");

// 默认 loopback；LAN 模式由 launcher 通过 HOST=0.0.0.0 显式开启。
export const HOST = process.env.OPENCLAUDE_HOST || process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.OPENCLAUDE_PORT || process.env.PORT || 21300);

const AUTH_CONFIG_PATH_ENV = process.env.OPENCLAUDE_CONFIG_PATH;
export const AUTH_CONFIG_PATH = AUTH_CONFIG_PATH_ENV
  ? path.resolve(AUTH_CONFIG_PATH_ENV)
  : RUNTIME_DIR_ENV
    ? path.join(RUNTIME_DIR, "config.yaml")
    : path.join(process.cwd(), "config.yaml");

export const LAUNCHER_TOKEN = process.env.OPENCLAUDE_LAUNCHER_TOKEN || "";
export const PASSWORD_HASH_PREFIX = "sha256-v1:";
export const COOKIE_NAME = "openclaude_auth";
export const AUTH_TOKEN_TTL_MS = Math.max(
  1_000,
  Number(process.env.OPENCLAUDE_AUTH_TOKEN_TTL_MS || 12 * 60 * 60 * 1000),
);

export const DEBUG_LOGS =
  process.env.OPENCLAUDE_DEBUG === "1" || process.env.OPENCLAUDE_DEBUG === "true";

export const IPC_SLOW_LOG_MS = Number(process.env.OPENCLAUDE_SLOW_LOG_MS || 750);

export const MAX_REQUEST_BODY_BYTES = Math.max(
  1024,
  Number(process.env.OPENCLAUDE_MAX_REQUEST_BODY_BYTES || 2 * 1024 * 1024),
);

export const LOGIN_BODY_MAX_BYTES = 8 * 1024;

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

export function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** 判断 candidate 是否位于 root 内部，用真实路径避免 ../ 和符号链接绕过。 */
export function isWithinRoot(candidate: string, root: string): boolean {
  const realpathSafe = (filePath: string): string | null => {
    try {
      return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
    } catch {
      return null;
    }
  };
  const candidateReal = realpathSafe(candidate);
  const rootReal = realpathSafe(root);
  if (!candidateReal || !rootReal) return false;
  const relative = path.relative(rootReal, candidateReal);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 避免引入 mime 依赖，网关只需要覆盖 web-shell 常见静态资源类型。 */
export function mimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}
