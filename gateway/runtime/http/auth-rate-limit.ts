import crypto from "node:crypto";
import type { Headers } from "./http-utils.js";
import { diagnosticWarn } from "../core/diagnostics.js";

// 迁移自 OpenCodex auth-rate-limit.cjs。
// 登录失败限速：按 TCP remoteAddress 做指数退避，超过阈值锁定；全局失败触发短暂退避。

export const DEFAULT_LIMIT_OPTIONS = {
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  clientLockThreshold: 10,
  globalBackpressureMs: 5_000,
  globalFailureThreshold: 80,
  lockMs: 15 * 60 * 1_000,
  logThrottleMs: 10_000,
  maxClients: 512,
  pruneIntervalMs: 60_000,
  windowMs: 10 * 60 * 1_000,
};

export interface LimitOptions extends Partial<typeof DEFAULT_LIMIT_OPTIONS> {
  now?: () => number;
  logger?: ((scope: string, event: string, details: unknown) => void) | null;
}

export interface LimitDecision {
  allowed: boolean;
  clientKey: string;
  failureCount: number;
  reason?: string;
  retryAfterMs: number;
  limited?: boolean;
}

export function normalizeClientAddress(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "unknown";
  const ipv4Mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (ipv4Mapped) return ipv4Mapped[1];
  return raw;
}

export function clientKeyFromRequest(req: { socket?: { remoteAddress?: string } } | undefined): string {
  return normalizeClientAddress(req && req.socket ? req.socket.remoteAddress : "");
}

function shortClientKey(value: string): string {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function retryAfterMs(value: number): number {
  return Math.max(1, Math.ceil(Number(value) || 0));
}

interface ClientState {
  failures: number[];
  lastSeenAtMs: number;
  lockedUntilMs: number;
  nextAllowedAtMs: number;
}

export function createAuthRateLimiter(options: LimitOptions = {}) {
  const config = { ...DEFAULT_LIMIT_OPTIONS, ...options };
  const clients = new Map<string, ClientState>();
  const globalFailures: number[] = [];
  const logThrottle = new Map<string, number>();
  let globalBackpressureUntilMs = 0;
  let lastPruneAtMs = 0;

  const nowMs = (): number =>
    typeof config.now === "function" ? Number(config.now()) || 0 : Date.now();

  function logWarn(event: string, details: Record<string, unknown>, now: number): void {
    if (config.logger === null) return;
    const key = `${event}:${details.client || "global"}`;
    const lastAt = logThrottle.get(key) || 0;
    if (now - lastAt < config.logThrottleMs) return;
    logThrottle.set(key, now);
    const logger = typeof config.logger === "function" ? config.logger : diagnosticWarn;
    logger("auth-rate-limit", event, details);
  }

  function pruneFailureWindow(failures: number[], now: number): number[] {
    const cutoff = now - config.windowMs;
    while (failures.length > 0 && failures[0] <= cutoff) failures.shift();
    return failures;
  }

  function pruneGlobalFailures(now: number): void {
    pruneFailureWindow(globalFailures, now);
    if (globalBackpressureUntilMs <= now && globalFailures.length <= config.globalFailureThreshold) {
      globalBackpressureUntilMs = 0;
    }
  }

  function pruneClients(now: number, force = false): void {
    pruneGlobalFailures(now);
    if (!force && now - lastPruneAtMs < config.pruneIntervalMs && clients.size <= config.maxClients) return;
    lastPruneAtMs = now;
    const inactiveCutoff = now - Math.max(config.windowMs, config.lockMs, config.backoffMaxMs);
    for (const [key, client] of clients.entries()) {
      pruneFailureWindow(client.failures, now);
      if (client.lockedUntilMs <= now) client.lockedUntilMs = 0;
      if (client.nextAllowedAtMs <= now) client.nextAllowedAtMs = 0;
      if (
        client.failures.length === 0 &&
        client.lockedUntilMs === 0 &&
        client.nextAllowedAtMs === 0 &&
        client.lastSeenAtMs <= inactiveCutoff
      ) {
        clients.delete(key);
      }
    }
    if (clients.size <= config.maxClients) return;
    const ordered = Array.from(clients.entries()).sort((left, right) => left[1].lastSeenAtMs - right[1].lastSeenAtMs);
    for (const [key] of ordered) {
      if (clients.size <= config.maxClients) break;
      clients.delete(key);
    }
  }

  function clientForKey(key: string, now: number): ClientState {
    let client = clients.get(key);
    if (!client) {
      client = { failures: [], lastSeenAtMs: now, lockedUntilMs: 0, nextAllowedAtMs: 0 };
      clients.set(key, client);
    }
    client.lastSeenAtMs = now;
    return client;
  }

  function backoffForFailureCount(count: number): number {
    const exponent = Math.max(0, count - 1);
    return Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** exponent);
  }

  function blockedDecision(
    reason: string,
    clientKey: string,
    retryMs: number,
    failureCount: number,
    now: number,
  ): LimitDecision {
    const decision: LimitDecision = {
      allowed: false,
      clientKey,
      failureCount,
      reason,
      retryAfterMs: retryAfterMs(retryMs),
    };
    logWarn(reason, { client: shortClientKey(clientKey), failureCount, retryAfterMs: decision.retryAfterMs }, now);
    return decision;
  }

  function globalBackpressureDecision(clientKey: string, now: number): LimitDecision | null {
    pruneGlobalFailures(now);
    if (globalFailures.length > config.globalFailureThreshold && globalBackpressureUntilMs <= now) {
      globalBackpressureUntilMs = now + config.globalBackpressureMs;
    }
    if (globalBackpressureUntilMs <= now) return null;
    return blockedDecision(
      "global_backpressure",
      clientKey,
      globalBackpressureUntilMs - now,
      globalFailures.length,
      now,
    );
  }

  function check(req: { socket?: { remoteAddress?: string } } | undefined): LimitDecision {
    const now = nowMs();
    pruneClients(now);
    const clientKey = clientKeyFromRequest(req);
    const client = clients.get(clientKey);
    if (client) {
      client.lastSeenAtMs = now;
      pruneFailureWindow(client.failures, now);
      if (client.lockedUntilMs > now) {
        return blockedDecision("client_locked", clientKey, client.lockedUntilMs - now, client.failures.length, now);
      }
      if (client.nextAllowedAtMs > now) {
        return blockedDecision("client_backoff", clientKey, client.nextAllowedAtMs - now, client.failures.length, now);
      }
    }
    const globalDecision = globalBackpressureDecision(clientKey, now);
    if (globalDecision) return globalDecision;
    return { allowed: true, clientKey, retryAfterMs: 0, failureCount: client ? client.failures.length : 0 };
  }

  function recordFailure(req: { socket?: { remoteAddress?: string } } | undefined): LimitDecision {
    const now = nowMs();
    pruneClients(now);
    const clientKey = clientKeyFromRequest(req);
    const client = clientForKey(clientKey, now);
    if (clients.size > config.maxClients) pruneClients(now, true);
    pruneFailureWindow(client.failures, now);
    client.failures.push(now);
    globalFailures.push(now);
    pruneGlobalFailures(now);

    const failureCount = client.failures.length;
    let reason = "client_backoff";
    let retryMs = backoffForFailureCount(failureCount);
    let limited = false;
    if (failureCount >= config.clientLockThreshold) {
      reason = "client_locked";
      retryMs = config.lockMs;
      limited = true;
      client.lockedUntilMs = now + config.lockMs;
      client.nextAllowedAtMs = client.lockedUntilMs;
    } else {
      client.nextAllowedAtMs = now + retryMs;
    }
    if (globalFailures.length > config.globalFailureThreshold) {
      globalBackpressureUntilMs = Math.max(globalBackpressureUntilMs, now + config.globalBackpressureMs);
    }

    logWarn(
      "login_failed",
      { client: shortClientKey(clientKey), failureCount, limited, retryAfterMs: retryMs },
      now,
    );
    return {
      allowed: !limited,
      clientKey,
      failureCount,
      limited,
      reason,
      retryAfterMs: retryAfterMs(retryMs),
    };
  }

  function recordSuccess(req: { socket?: { remoteAddress?: string } } | undefined): { clientKey: string } {
    const clientKey = clientKeyFromRequest(req);
    clients.delete(clientKey);
    return { clientKey };
  }

  function reset(): void {
    clients.clear();
    globalFailures.length = 0;
    logThrottle.clear();
    globalBackpressureUntilMs = 0;
    lastPruneAtMs = 0;
  }

  function snapshot() {
    return {
      clientCount: clients.size,
      globalBackpressureUntilMs,
      globalFailureCount: globalFailures.length,
    };
  }

  return { check, recordFailure, recordSuccess, reset, snapshot };
}

export interface AuthRequestLike {
  socket?: { remoteAddress?: string };
  headers?: Headers;
}
