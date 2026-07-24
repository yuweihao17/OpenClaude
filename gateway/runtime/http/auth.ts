import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import {
  AUTH_CONFIG_PATH,
  AUTH_TOKEN_TTL_MS,
  COOKIE_NAME,
  LAUNCHER_TOKEN,
  LOGIN_BODY_MAX_BYTES,
  PASSWORD_HASH_PREFIX,
  exists,
  readText,
} from "../core/config.js";
import { createAuthRateLimiter } from "./auth-rate-limit.js";
import {
  type Headers,
  headerValue,
  isRequestBodyTooLargeError,
  readBody,
  sendJson,
} from "./http-utils.js";

// 迁移自 OpenCodex auth.cjs。
// 访问密码只在配置文件里短暂出现，启动后会改写为 sha256-v1 hash；登录比较前端提交的 sha256。
// token 只放内存：泄露面小、不写磁盘、网关重启后全部失效。

export interface AuthResult {
  authRequired: boolean;
  authenticated: boolean;
  token: string;
  expiresAtMs: number | null;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function isPrefixedPasswordHash(value: string): boolean {
  return new RegExp(`^${PASSWORD_HASH_PREFIX}[a-f0-9]{64}$`, "i").test(String(value || "").trim());
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
    if (!value.endsWith('"')) throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    try { return JSON.parse(value); } catch { throw new Error("[gateway] invalid quoted auth.password in config.yaml"); }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error("[gateway] invalid quoted auth.password in config.yaml");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function leadingIndent(line: string): number {
  const match = String(line || "").match(/^(\s*)/);
  return match ? match[1].length : 0;
}

interface AuthPasswordScalar { lineIndex: number; value: string; }

function findAuthPasswordScalar(rawConfig: string): AuthPasswordScalar | null {
  const lines = String(rawConfig || "").split(/\r?\n/);
  let inAuth = false;
  let authIndent = 0;
  let authChildIndent: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const logicalLine = stripYamlComment(line);
    if (!logicalLine.trim()) continue;
    const indent = leadingIndent(line);
    if (inAuth && indent <= authIndent) { inAuth = false; authChildIndent = null; }
    if (!inAuth && indent === 0) {
      const authMatch = logicalLine.trim().match(/^auth\s*:\s*(.*)$/);
      if (authMatch) {
        if (authMatch[1].trim()) throw new Error("[gateway] unsupported inline auth config in config.yaml; use block form auth.password");
        inAuth = true;
        authIndent = indent;
        authChildIndent = null;
        continue;
      }
    }
    if (!inAuth || indent <= authIndent) continue;
    if (authChildIndent == null) authChildIndent = indent;
    if (indent !== authChildIndent) continue;
    const passwordMatch = line.match(/^(\s*)password\s*:\s*(.*)$/);
    if (!passwordMatch) continue;
    return { lineIndex: i, value: parseYamlStringScalar(passwordMatch[2]) };
  }
  return null;
}

function rewriteAuthPasswordHash(rawConfig: string, lineIndex: number, passwordHash: string): string {
  const hasFinalNewline = /\r?\n$/.test(rawConfig);
  const normalizedConfig = hasFinalNewline ? String(rawConfig || "").replace(/\r?\n$/, "") : String(rawConfig || "");
  const lines = normalizedConfig.split(/\r?\n/);
  const line = lines[lineIndex] || "";
  const match = line.match(/^(\s*password\s*:\s*).*/);
  if (!match) throw new Error("[gateway] auth.password line was not found while rewriting config.yaml");
  lines[lineIndex] = `${match[1]}"${PASSWORD_HASH_PREFIX}${passwordHash}"`;
  return lines.join("\n") + (hasFinalNewline ? "\n" : "");
}

function loadAuthPasswordHashFromConfig(configPath: string): string {
  if (!exists(configPath)) return "";
  let rawConfig = "";
  try {
    rawConfig = readText(configPath);
  } catch (error) {
    throw new Error(`[gateway] failed to read config.yaml: ${(error as Error).message || error}`);
  }
  const authPassword = findAuthPasswordScalar(rawConfig);
  if (!authPassword || String(authPassword.value || "").length === 0) return "";
  const passwordValue = String(authPassword.value);
  const trimmedPasswordValue = passwordValue.trim();
  if (isPrefixedPasswordHash(trimmedPasswordValue)) {
    return trimmedPasswordValue.slice(PASSWORD_HASH_PREFIX.length).toLowerCase();
  }
  const passwordHash = sha256Hex(passwordValue);
  const nextConfig = rewriteAuthPasswordHash(rawConfig, authPassword.lineIndex, passwordHash);
  try {
    fs.writeFileSync(configPath, nextConfig, "utf-8");
  } catch (error) {
    throw new Error(`[gateway] failed to rewrite config.yaml auth.password as hash: ${(error as Error).message || error}`);
  }
  return passwordHash;
}

function makeAuthStore(tokenTtlMs: number) {
  const tokens = new Map<string, { expiresAtMs: number }>();
  const hashToken = (token: string): string =>
    crypto.createHash("sha256").update(String(token)).digest("base64url");
  const prune = (): void => {
    const now = Date.now();
    for (const [hash, entry] of tokens) {
      if (!entry || entry.expiresAtMs <= now) tokens.delete(hash);
    }
  };
  return {
    issue(): { token: string; expiresAtMs: number } {
      prune();
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAtMs = Date.now() + tokenTtlMs;
      tokens.set(hashToken(token), { expiresAtMs });
      return { token, expiresAtMs };
    },
    validate(token: string): { expiresAtMs: number } | null {
      if (!token) return null;
      const hash = hashToken(token);
      const entry = tokens.get(hash);
      if (!entry) return null;
      if (entry.expiresAtMs <= Date.now()) { tokens.delete(hash); return null; }
      entry.expiresAtMs = Date.now() + tokenTtlMs;
      return entry;
    },
    revoke(token: string): void {
      if (token) tokens.delete(hashToken(token));
    },
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    try { crypto.timingSafeEqual(Buffer.alloc(rightBuffer.length), rightBuffer); } catch { /* ignore */ }
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = String(raw || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export interface AuthServiceOptions {
  configPath?: string;
  launcherToken?: string;
  tokenTtlMs?: number;
  rateLimiter?: ReturnType<typeof createAuthRateLimiter>;
}

export function createAuthService(options: AuthServiceOptions = {}) {
  const configPath = options.configPath || AUTH_CONFIG_PATH;
  const launcherToken = options.launcherToken ?? LAUNCHER_TOKEN;
  const tokenTtlMs = options.tokenTtlMs ?? AUTH_TOKEN_TTL_MS;
  const passwordHash = loadAuthPasswordHashFromConfig(configPath);
  const authStore = makeAuthStore(tokenTtlMs);
  const rateLimiter = options.rateLimiter || createAuthRateLimiter();

  function authTokenFromRequest(req: IncomingMessage, url: URL | null): string {
    const headerToken = String(headerValue(req.headers as Headers, "x-openclaude-token") || "").trim();
    if (headerToken) return headerToken;
    const authorizationToken = bearerToken(headerValue(req.headers as Headers, "authorization"));
    if (authorizationToken) return authorizationToken;
    const queryToken = url && url.searchParams ? String(url.searchParams.get("token") || "").trim() : "";
    if (queryToken) return queryToken;
    const cookies = parseCookies(req.headers.cookie);
    return String(cookies[COOKIE_NAME] || "").trim();
  }

  function authResultForRequest(req: IncomingMessage, url: URL | null = null): AuthResult {
    if (!passwordHash) {
      return { authRequired: false, authenticated: true, token: "", expiresAtMs: null };
    }
    const token = authTokenFromRequest(req, url);
    const entry = authStore.validate(token);
    return {
      authRequired: true,
      authenticated: !!entry,
      token,
      expiresAtMs: entry ? entry.expiresAtMs : null,
    };
  }

  function isAuthed(req: IncomingMessage, url: URL | null = null): boolean {
    return authResultForRequest(req, url).authenticated;
  }

  function isLauncherRequest(req: IncomingMessage): boolean {
    if (!launcherToken) return false;
    const value = headerValue(req.headers as Headers, "x-openclaude-launcher-token");
    return typeof value === "string" && value === launcherToken;
  }

  function authCookieHeader(token: string): string {
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`;
  }

  function clearAuthCookieHeader(): string[] {
    const expired = "Thu, 01 Jan 1970 00:00:00 GMT";
    return [
      `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Expires=${expired}`,
      `${COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0; Expires=${expired}`,
    ];
  }

  function authRefreshHeaders(auth: AuthResult): Record<string, string> {
    if (!auth || !auth.authenticated || !auth.token || !auth.expiresAtMs) return {};
    return { "set-cookie": authCookieHeader(auth.token) };
  }

  function isValidPasswordHash(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
  }

  function readPasswordHashFromBody(rawBody: string, contentType: string | string[] | undefined): string {
    if (String(contentType || "").includes("application/json")) {
      try {
        const parsed = JSON.parse(rawBody || "{}");
        return typeof parsed.passwordHash === "string" ? parsed.passwordHash : "";
      } catch { return ""; }
    }
    const params = new URLSearchParams(rawBody || "");
    return params.get("passwordHash") || "";
  }

  function retryAfterSeconds(retryAfterMsValue: number): string {
    return String(Math.max(1, Math.ceil((Number(retryAfterMsValue) || 0) / 1000)));
  }

  function sendTooManyLoginAttempts(res: ServerResponse, decision: { retryAfterMs: number }): void {
    const retryMs = Math.max(1, Math.ceil(Number(decision && decision.retryAfterMs) || 1));
    sendJson(
      res,
      429,
      { ok: false, authRequired: true, authenticated: false, error: "Too many login attempts", retryAfterMs: retryMs },
      { "cache-control": "no-store", "retry-after": retryAfterSeconds(retryMs) },
    );
  }

  async function handleAuthLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" }, { "cache-control": "no-store" });
      return;
    }
    if (!passwordHash) {
      sendJson(res, 200, { ok: true, authRequired: false, authenticated: true, token: "", expiresAtMs: null, ttlMs: null }, { "cache-control": "no-store" });
      return;
    }
    const limitBeforeBody = rateLimiter.check(req);
    if (!limitBeforeBody.allowed) { sendTooManyLoginAttempts(res, limitBeforeBody); return; }

    let rawBody = "";
    try {
      rawBody = await readBody(req, { maxBytes: LOGIN_BODY_MAX_BYTES });
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        sendJson(res, 413, { ok: false, authRequired: true, authenticated: false, error: "Request body too large" }, { "cache-control": "no-store" });
        return;
      }
      throw error;
    }
    const limitAfterBody = rateLimiter.check(req);
    if (!limitAfterBody.allowed) { sendTooManyLoginAttempts(res, limitAfterBody); return; }

    const submittedHash = readPasswordHashFromBody(rawBody, headerValue(req.headers as Headers, "content-type")).trim().toLowerCase();
    if (!isValidPasswordHash(submittedHash) || !timingSafeEqualString(submittedHash, passwordHash)) {
      const failure = rateLimiter.recordFailure(req);
      if (failure.limited) { sendTooManyLoginAttempts(res, failure); return; }
      sendJson(res, 401, { ok: false, authRequired: true, authenticated: false, error: "Invalid password" }, { "cache-control": "no-store" });
      return;
    }
    rateLimiter.recordSuccess(req);
    const issued = authStore.issue();
    sendJson(res, 200, { ok: true, authRequired: true, authenticated: true, token: issued.token, expiresAtMs: issued.expiresAtMs, ttlMs: tokenTtlMs }, { "cache-control": "no-store", "set-cookie": authCookieHeader(issued.token) });
  }

  function handleAuthStatus(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const auth = authResultForRequest(req, url);
    sendJson(res, 200, { ok: true, authRequired: !!passwordHash, authenticated: auth.authenticated, expiresAtMs: auth.expiresAtMs, ttlMs: passwordHash ? tokenTtlMs : null }, { "cache-control": "no-store", ...authRefreshHeaders(auth) });
  }

  function handleAuthLogout(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const auth = authResultForRequest(req, url);
    if (auth.token) authStore.revoke(auth.token);
    sendJson(res, 200, { ok: true }, { "cache-control": "no-store", "set-cookie": clearAuthCookieHeader() });
  }

  function sendUnauthorized(res: ServerResponse): void {
    sendJson(res, 401, { ok: false, error: "Unauthorized" }, { "cache-control": "no-store", "www-authenticate": "Bearer" });
  }

  return {
    authRequired: !!passwordHash,
    authResultForRequest,
    authRefreshHeaders,
    handleAuthLogin,
    handleAuthLogout,
    handleAuthStatus,
    isAuthed,
    isLauncherRequest,
    sendUnauthorized,
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
