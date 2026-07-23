import assert from "node:assert/strict";
import test from "node:test";
import { clientMessageSchema } from "../dist/shared/protocol.js";

test("accepts the supported session commands", () => {
  assert.equal(clientMessageSchema.parse({ type: "session.list", requestId: "request-1" }).type, "session.list");
  assert.equal(
    clientMessageSchema.parse({ type: "session.send", requestId: "request-2", text: "hello" }).type,
    "session.send",
  );
});

test("rejects empty and oversized prompts", () => {
  assert.equal(clientMessageSchema.safeParse({ type: "session.send", requestId: "request-1", text: "" }).success, false);
  assert.equal(
    clientMessageSchema.safeParse({ type: "session.send", requestId: "request-1", text: "x".repeat(200_001) }).success,
    false,
  );
});
