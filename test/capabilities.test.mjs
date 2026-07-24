import assert from "node:assert/strict";
import test from "node:test";
import { probeCapabilities, unavailableDiagnostics } from "../dist/src/connector/claude-desktop-capabilities.js";

function makeScan(overrides = {}) {
  return {
    found: false,
    installPath: "",
    source: "default-candidates",
    packageName: "",
    packageVersion: "",
    electronVersion: "",
    mainEntry: "",
    components: { appAsar: false, coworkSvc: false, chromeNativeHost: false, mcpRuntime: false, wsDependency: false },
    scannedAt: "2026-01-01T00:00:00.000Z",
    notes: [],
    ...overrides,
  };
}

test("without on-host probe the overall status is unavailable even when install is found", () => {
  const scan = makeScan({
    found: true,
    installPath: "C:\\Claude",
    packageVersion: "1.24012.1",
    electronVersion: "42.7.0",
    mainEntry: ".vite/build/index.pre.js",
    components: { appAsar: true, coworkSvc: true, chromeNativeHost: true, mcpRuntime: true, wsDependency: true },
  });
  const report = probeCapabilities(scan, { allowOnHostProbe: false, platform: "win32" });
  assert.equal(report.status, "unavailable");
  assert.ok(report.routes.length >= 4);
  // 在云端没有 on-host 探测时，即使组件齐全，整体上限也是 unavailable
  for (const route of report.routes) {
    assert.notEqual(route.status, "supported");
  }
});

test("degraded routes are reported when components present but unverified", () => {
  const scan = makeScan({
    found: true,
    installPath: "C:\\Claude",
    mainEntry: ".vite/build/index.pre.js",
    components: { appAsar: true, coworkSvc: true, chromeNativeHost: false, mcpRuntime: false, wsDependency: true },
  });
  const report = probeCapabilities(scan, { allowOnHostProbe: false, platform: "win32" });
  const official = report.routes.find((r) => r.route === "official-runtime");
  const cowork = report.routes.find((r) => r.route === "cowork-svc");
  assert.equal(official.status, "degraded");
  assert.equal(cowork.status, "degraded");
});

test("unavailable routes when install not found", () => {
  const scan = makeScan({ found: false });
  const report = probeCapabilities(scan, { allowOnHostProbe: false, platform: "win32" });
  assert.equal(report.status, "unavailable");
  for (const route of report.routes) {
    assert.equal(route.status, "unavailable");
  }
});

test("ui-automation route is unavailable on non-win32", () => {
  const scan = makeScan({ found: true });
  const report = probeCapabilities(scan, { allowOnHostProbe: false, platform: "linux" });
  const ui = report.routes.find((r) => r.route === "ui-automation");
  assert.equal(ui.status, "unavailable");
});

test("unavailableDiagnostics returns a fixed unavailable report", () => {
  const diag = unavailableDiagnostics("claude-desktop-unavailable", "not configured");
  assert.equal(diag.status, "unavailable");
  assert.equal(diag.name, "claude-desktop-unavailable");
  assert.equal(diag.routes.length, 0);
});
