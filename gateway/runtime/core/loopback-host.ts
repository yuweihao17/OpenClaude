/**
 * Loopback host 头检测。迁移自 OpenCodex loopback-host。
 *
 * LAN 模式下，网关用 Host 头判断请求是否来自本机；
 * loopback 来源始终放行，非 loopback 来源必须通过显式 origin 白名单 + 鉴权。
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 从 Host 头中提取 hostname，去掉端口和 IPv6 方括号。 */
export function hostnameFromHostHeader(hostHeader: string): string {
  const raw = String(hostHeader || "").trim().toLowerCase();
  if (!raw) return "";
  // IPv6 形如 [::1]:8080
  const ipv6Match = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (ipv6Match) return ipv6Match[1];
  // 普通 hostname:port
  const colonIndex = raw.lastIndexOf(":");
  if (colonIndex > 0) return raw.slice(0, colonIndex);
  return raw;
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(String(hostname || "").trim().toLowerCase());
}

export function isLoopbackHostHeader(hostHeader: string): boolean {
  return isLoopbackHostname(hostnameFromHostHeader(hostHeader));
}
