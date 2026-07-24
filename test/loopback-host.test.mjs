import assert from "node:assert/strict";
import test from "node:test";
import {
  hostnameFromHostHeader,
  isLoopbackHostname,
  isLoopbackHostHeader,
} from "../dist/gateway/runtime/core/loopback-host.js";

test("loopbackHostname recognizes loopback variants", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isLoopbackHostname("192.168.1.1"), false);
  assert.equal(isLoopbackHostname(""), false);
});

test("hostnameFromHostHeader strips ports and brackets", () => {
  assert.equal(hostnameFromHostHeader("127.0.0.1:8080"), "127.0.0.1");
  assert.equal(hostnameFromHostHeader("localhost:3000"), "localhost");
  assert.equal(hostnameFromHostHeader("[::1]:8080"), "::1");
  assert.equal(hostnameFromHostHeader("example.com"), "example.com");
  assert.equal(hostnameFromHostHeader(""), "");
});

test("isLoopbackHostHeader is true for loopback hosts", () => {
  assert.equal(isLoopbackHostHeader("127.0.0.1:21300"), true);
  assert.equal(isLoopbackHostHeader("localhost:21300"), true);
  assert.equal(isLoopbackHostHeader("[::1]:21300"), true);
  assert.equal(isLoopbackHostHeader("192.168.1.5:21300"), false);
  assert.equal(isLoopbackHostHeader(""), false);
});
