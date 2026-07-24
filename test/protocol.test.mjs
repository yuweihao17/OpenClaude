import assert from "node:assert/strict";
import test from "node:test";
import { clientMessageSchema, MAX_PROMPT_TEXT, MAX_WS_MESSAGE_BYTES } from "../dist/shared/protocol.js";

test("accepts hello, ping and session commands with requestId", () => {
  assert.equal(clientMessageSchema.parse({ type: "hello" }).type, "hello");
  assert.equal(clientMessageSchema.parse({ type: "hello", requestId: "r0" }).type, "hello");
  assert.equal(clientMessageSchema.parse({ type: "ping", requestId: "r1" }).type, "ping");
  assert.equal(clientMessageSchema.parse({ type: "session.list", requestId: "r2" }).type, "session.list");
  assert.equal(
    clientMessageSchema.parse({ type: "session.send", requestId: "r3", sessionId: "s1", text: "hello" }).type,
    "session.send",
  );
  assert.equal(
    clientMessageSchema.parse({ type: "session.cancel", requestId: "r4", sessionId: "s1" }).type,
    "session.cancel",
  );
});

test("rejects session.send without sessionId, empty or oversized text", () => {
  assert.equal(
    clientMessageSchema.safeParse({ type: "session.send", requestId: "r1", text: "hello" }).success,
    false,
  );
  assert.equal(
    clientMessageSchema.safeParse({ type: "session.send", requestId: "r1", sessionId: "s1", text: "" }).success,
    false,
  );
  assert.equal(
    clientMessageSchema.safeParse({
      type: "session.send",
      requestId: "r1",
      sessionId: "s1",
      text: "x".repeat(MAX_PROMPT_TEXT + 1),
    }).success,
    false,
  );
});

test("rejects non-hello hello requestId and missing clientId", () => {
  // hello 的 requestId 可选；其它消息必须带 requestId 和必要字段
  assert.equal(clientMessageSchema.safeParse({ type: "ping" }).success, false);
  assert.equal(clientMessageSchema.safeParse({ type: "session.list" }).success, false);
  assert.equal(clientMessageSchema.safeParse({ type: "session.cancel", requestId: "r1" }).success, false);
});

test("exports bounded message and text size constants", () => {
  assert.ok(typeof MAX_PROMPT_TEXT === "number" && MAX_PROMPT_TEXT > 0);
  assert.ok(typeof MAX_WS_MESSAGE_BYTES === "number" && MAX_WS_MESSAGE_BYTES > 0);
});
