import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const tmp = os.tmpdir();

function runScript(scriptPath, env = {}) {
  return execFileSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

test("probe:claude script runs and reports unavailable on non-Windows", () => {
  const stdout = runScript(path.join(projectRoot, "scripts", "probe-claude-desktop.mjs"), {
    OPENCLAUDE_PROBE_ON_HOST: "",
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.platform, process.platform);
  assert.equal(payload.status, "unavailable");
  assert.equal(payload.scan.found, false);
  assert.ok(Array.isArray(payload.routes));
  assert.equal(payload.routes.length, 4);
});

test("probe:claude respects OPENCLAUDE_CLAUDE_PATH override (points at a fixture)", (t) => {
  // 构造一个最小 fixture 安装目录，让 configuredPath 命中并 found=true。
  const fixture = fs.mkdtempSync(path.join(tmp, "openclaude-probe-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "resources"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "resources", "app.asar"), "asar-bytes");
  fs.writeFileSync(path.join(fixture, "version"), "42.7.0");

  const stdout = runScript(path.join(projectRoot, "scripts", "probe-claude-desktop.mjs"), {
    OPENCLAUDE_CLAUDE_PATH: fixture,
    OPENCLAUDE_PROBE_ON_HOST: "",
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.scan.found, true);
  assert.equal(payload.scan.source, "configured");
  // allowOnHostProbe=false 时整体状态仍被钳制为 unavailable。
  assert.equal(payload.status, "unavailable");
  assert.equal(payload.scan.electronVersion, "42.7.0");
});

test("sync:version script writes shared/app-version.ts matching package.json", () => {
  const outPath = path.join(projectRoot, "shared", "app-version.ts");
  const before = fs.readFileSync(outPath, "utf-8");
  runScript(path.join(projectRoot, "scripts", "sync-version.mjs"));
  const after = fs.readFileSync(outPath, "utf-8");
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
  assert.ok(after.includes(`OPENCLAUDE_VERSION = ${JSON.stringify(pkg.version)}`));
  // 恢复原内容以避免污染工作树（脚本本身是幂等的，这里只是保持测试干净）。
  assert.equal(before, after, "sync:version should be idempotent for an unchanged package.json");
});

test("probe:claude legacy alias OPENCLAUDE_CLAUDE_INSTALL_PATH still works", (t) => {
  const fixture = fs.mkdtempSync(path.join(tmp, "openclaude-probe-legacy-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, "resources"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "resources", "app.asar"), "asar-bytes");

  const stdout = runScript(path.join(projectRoot, "scripts", "probe-claude-desktop.mjs"), {
    OPENCLAUDE_CLAUDE_INSTALL_PATH: fixture,
    OPENCLAUDE_CLAUDE_PATH: "",
  });
  const payload = JSON.parse(stdout);
  assert.equal(payload.scan.found, true);
  assert.equal(payload.scan.source, "configured");
});
