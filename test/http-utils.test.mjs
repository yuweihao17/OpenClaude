import assert from "node:assert/strict";
import test from "node:test";
import { headerValue, readBody, RequestBodyTooLargeError, safeParseUrl } from "../dist/gateway/runtime/http/http-utils.js";

test("headerValue is case-insensitive", () => {
  assert.equal(headerValue({ "X-Test": "a" }, "x-test"), "a");
  assert.equal(headerValue({ "X-Test": "a" }, "X-TEST"), "a");
  assert.equal(headerValue({}, "missing"), "");
  assert.equal(headerValue(undefined, "x"), "");
});

test("headerValue joins array headers except set-cookie", () => {
  assert.equal(headerValue({ "X-Multi": ["a", "b"] }, "x-multi"), "a, b");
  assert.deepEqual(headerValue({ "Set-Cookie": ["a=1", "b=2"] }, "set-cookie"), ["a=1", "b=2"]);
});

test("readBody returns the full body as string", async () => {
  const { Readable } = await import("node:stream");
  const stream = Readable.from([Buffer.from("hello"), Buffer.from(" world")]);
  stream.headers = {};
  const body = await readBody(stream);
  assert.equal(body, "hello world");
});

test("readBody rejects with RequestBodyTooLargeError when exceeding maxBytes", async () => {
  const { Readable } = await import("node:stream");
  const stream = Readable.from([Buffer.alloc(100)]);
  stream.headers = {};
  await assert.rejects(
    () => readBody(stream, { maxBytes: 10 }),
    (err) => err instanceof RequestBodyTooLargeError,
  );
});

test("safeParseUrl returns null for invalid input", () => {
  assert.ok(safeParseUrl("/api/health") instanceof URL);
  assert.ok(safeParseUrl("http://localhost/api/health") instanceof URL);
  // 真正无法解析的 URL：包含非法 host 字符
  assert.equal(safeParseUrl("http://[invalid/path"), null);
});
