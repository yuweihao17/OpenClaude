import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createGateway } from "../dist/gateway/runtime/gateway.js";
import { MockClaudeDesktopConnector } from "../dist/src/connector/mock-connector.js";
import { UnavailableClaudeDesktopConnector } from "../dist/src/connector/unavailable-connector.js";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function tempWebShell(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaude-web-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body>OpenClaude</body></html>");
  return dir;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  return { status: res.status, json };
}

function wsSend(ws, message) {
  ws.send(JSON.stringify(message));
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(msg);
        }
      } catch {
        // ignore non-JSON
      }
    };
    ws.on("message", handler);
  });
}

test("gateway health endpoint reports connector without auth on loopback", async (t) => {
  const port = await freePort();
  const connector = new UnavailableClaudeDesktopConnector({
    scanResult: {
      found: false, installPath: "", source: "default-candidates", packageName: "",
      packageVersion: "", electronVersion: "", mainEntry: "",
      components: { appAsar: false, coworkSvc: false, chromeNativeHost: false, mcpRuntime: false, wsDependency: false },
      scannedAt: "2026-01-01T00:00:00.000Z", notes: [],
    },
  });
  const gateway = createGateway({ host: "127.0.0.1", port, connector, webShellDir: tempWebShell(t) });
  t.after(() => gateway.close());
  await gateway.listen();
  const { status, json } = await fetchJson(`http://127.0.0.1:${port}/api/health`);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.connector.status, "unavailable");
});

test("gateway serves web-shell index at root", async (t) => {
  const port = await freePort();
  const connector = new MockClaudeDesktopConnector();
  const gateway = createGateway({ host: "127.0.0.1", port, connector, webShellDir: tempWebShell(t) });
  t.after(() => gateway.close());
  await gateway.listen();
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(text.includes("OpenClaude"));
});

test("WebSocket hello -> hello-ack with connector status, then session.list", async (t) => {
  const port = await freePort();
  const connector = new MockClaudeDesktopConnector();
  const gateway = createGateway({ host: "127.0.0.1", port, connector, webShellDir: tempWebShell(t) });
  t.after(() => gateway.close());
  await gateway.listen();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  wsSend(ws, { type: "hello" });
  const ack = await waitForMessage(ws, (m) => m.type === "hello-ack");
  assert.equal(ack.connector, "degraded");
  assert.equal(ack.connectorName, "claude-desktop-mock");
  assert.ok(ack.clientId.length > 0);

  wsSend(ws, { type: "session.list", requestId: "r1" });
  const listResult = await waitForMessage(ws, (m) => m.type === "session.list.result" && m.requestId === "r1");
  assert.ok(listResult.sessions.length >= 1);
});

test("WebSocket rejects messages before hello", async (t) => {
  const port = await freePort();
  const connector = new MockClaudeDesktopConnector();
  const gateway = createGateway({ host: "127.0.0.1", port, connector, webShellDir: tempWebShell(t) });
  t.after(() => gateway.close());
  await gateway.listen();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  wsSend(ws, { type: "session.list", requestId: "r1" });
  const errorMsg = await waitForMessage(ws, (m) => m.type === "error" && m.code === "hello_required");
  assert.equal(errorMsg.code, "hello_required");
});

test("gateway restart closes and re-listens", async (t) => {
  const port = await freePort();
  const connector = new MockClaudeDesktopConnector();
  const gateway = createGateway({ host: "127.0.0.1", port, connector, webShellDir: tempWebShell(t) });
  t.after(() => gateway.close());
  await gateway.listen();
  await gateway.restart();
  // restart 后 health 仍可访问
  const { status, json } = await fetchJson(`http://127.0.0.1:${port}/api/health`);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});
