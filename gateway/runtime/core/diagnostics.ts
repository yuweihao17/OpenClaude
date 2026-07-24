import { DEBUG_LOGS } from "./config.js";

/**
 * 结构化诊断日志。迁移自 OpenCodex diagnostics。
 *
 * 脱敏规则：
 * - 不记录密码明文、token、cookie、会话内容。
 * - clientKey 在限速日志里只输出 sha256 前 12 位。
 * - 路径中可能含用户名的部分由调用方负责遮蔽。
 */

function timestamp(): string {
  return new Date().toISOString();
}

function format(scope: string, event: string, details: unknown): string {
  const detailStr = details && typeof details === "object" ? JSON.stringify(details) : String(details ?? "");
  return `[${timestamp()}] [${scope}] ${event} ${detailStr}`;
}

export function diagnosticLog(scope: string, event: string, details: unknown = ""): void {
  console.log(format(scope, event, details));
}

export function diagnosticWarn(scope: string, event: string, details: unknown = ""): void {
  console.warn(format(scope, event, details));
}

export function diagnosticError(scope: string, event: string, details: unknown = ""): void {
  console.error(format(scope, event, details));
}

export function diagnosticDebug(scope: string, event: string, details: unknown = ""): void {
  if (!DEBUG_LOGS) return;
  console.log(format(scope, event, details));
}

/** 短 ID：取随机 ID 前 8 位，用于日志里区分客户端但不泄露完整 ID。 */
export function shortId(value: string): string {
  return String(value || "").slice(0, 8);
}
