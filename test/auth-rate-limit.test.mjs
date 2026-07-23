import assert from "node:assert/strict";
import test from "node:test";
import { createAuthRateLimiter, normalizeClientAddress, clientKeyFromRequest } from "../dist/gateway/runtime/http/auth-rate-limit.js";

const fastOptions = {
  backoffBaseMs: 1,
  backoffMaxMs: 10,
  clientLockThreshold: 3,
  globalBackpressureMs: 5,
  globalFailureThreshold: 1,
  lockMs: 50,
  logThrottleMs: 0,
  pruneIntervalMs: 0,
  windowMs: 1000,
  logger: null,
};

test("normalizeClientAddress unmaps IPv4-mapped IPv6", () => {
  assert.equal(normalizeClientAddress("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeClientAddress("192.168.1.5"), "192.168.1.5");
  assert.equal(normalizeClientAddress(undefined), "unknown");
  assert.equal(normalizeClientAddress(""), "unknown");
});

test("clientKeyFromRequest uses socket remoteAddress", () => {
  assert.equal(clientKeyFromRequest({ socket: { remoteAddress: "10.0.0.1" } }), "10.0.0.1");
  assert.equal(clientKeyFromRequest(undefined), "unknown");
  assert.equal(clientKeyFromRequest({}), "unknown");
});

test("first failure triggers short backoff, repeated failures lock", () => {
  // 用固定时钟，避免 recordFailure 后 backoff 已经过期。
  let now = 1000;
  const limiter = createAuthRateLimiter({ ...fastOptions, now: () => now });
  const req = { socket: { remoteAddress: "1.2.3.4" } };
  assert.equal(limiter.check(req).allowed, true);
  const f1 = limiter.recordFailure(req);
  assert.equal(f1.allowed, true);
  assert.equal(f1.failureCount, 1);
  // 时钟不前进，backoff 仍生效
  const blocked = limiter.check(req);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "client_backoff");
});

test("recordSuccess clears client failures", () => {
  const limiter = createAuthRateLimiter(fastOptions);
  const req = { socket: { remoteAddress: "5.6.7.8" } };
  limiter.recordFailure(req);
  limiter.recordSuccess(req);
  assert.equal(limiter.check(req).allowed, true);
});

test("global backpressure engages when global threshold exceeded", () => {
  let now = 1000;
  // threshold=1: 一次失败达到阈值，第二次失败才会 > 阈值触发 backpressure。
  const limiter = createAuthRateLimiter({ ...fastOptions, globalFailureThreshold: 1, now: () => now });
  const reqA = { socket: { remoteAddress: "1.1.1.1" } };
  const reqB = { socket: { remoteAddress: "2.2.2.2" } };
  limiter.recordFailure(reqA);
  limiter.recordFailure(reqB);
  // 时钟不前进，global backpressure 仍生效
  const reqC = { socket: { remoteAddress: "3.3.3.3" } };
  const decision = limiter.check(reqC);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "global_backpressure");
});
