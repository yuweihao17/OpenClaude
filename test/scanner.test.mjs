import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanClaudeDesktop, defaultWindowsCandidates } from "../dist/src/connector/claude-desktop-scanner.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaude-scan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(filePath, content = "fixture") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeAsarReader(info) {
  return {
    extractJson: () => info,
    extractFile: () => Buffer.from(JSON.stringify(info)),
  };
}

test("returns not-found when no candidates match (non-win32)", () => {
  const result = scanClaudeDesktop({
    platform: "linux",
    candidates: [],
    allowLoadAsar: false,
  });
  assert.equal(result.found, false);
  assert.equal(result.components.appAsar, false);
  assert.ok(result.notes.length > 0);
});

test("scans a fixture install with app.asar and components", (t) => {
  const root = tempDir(t);
  writeFile(path.join(root, "resources", "app.asar"), "asar-bytes");
  writeFile(path.join(root, "resources", "cowork-svc.exe"));
  writeFile(path.join(root, "chrome-native-host.exe"));
  writeFile(path.join(root, "mcp"));
  writeFile(path.join(root, "version"), "42.7.0");

  const asarInfo = {
    name: "@ant/desktop",
    version: "1.24012.1",
    main: ".vite/build/index.pre.js",
    dependencies: { ws: "^8.0.0" },
  };

  const result = scanClaudeDesktop({
    platform: "win32",
    candidates: [root],
    configuredPath: root,
    asarReader: makeAsarReader(asarInfo),
    allowLoadAsar: false,
  });

  assert.equal(result.found, true);
  assert.equal(result.source, "configured");
  assert.equal(result.packageName, "@ant/desktop");
  assert.equal(result.packageVersion, "1.24012.1");
  assert.equal(result.mainEntry, ".vite/build/index.pre.js");
  assert.equal(result.electronVersion, "42.7.0");
  assert.equal(result.components.appAsar, true);
  assert.equal(result.components.coworkSvc, true);
  assert.equal(result.components.chromeNativeHost, true);
  assert.equal(result.components.mcpRuntime, true);
  assert.equal(result.components.wsDependency, true);
});

test("rejects unsafe main entry that escapes asar root", (t) => {
  const root = tempDir(t);
  writeFile(path.join(root, "resources", "app.asar"), "x");
  const asarInfo = { name: "@ant/desktop", version: "1.0.0", main: "../escape.js" };
  const result = scanClaudeDesktop({
    platform: "win32",
    candidates: [root],
    asarReader: makeAsarReader(asarInfo),
    allowLoadAsar: false,
  });
  assert.equal(result.found, true);
  assert.equal(result.mainEntry, "");
});

test("defaultWindowsCandidates uses LOCALAPPDATA and PROGRAMFILES", () => {
  const candidates = defaultWindowsCandidates(
    { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PROGRAMFILES: "C:\\Program Files" },
    "C:\\Users\\me",
  );
  assert.ok(candidates.length >= 4);
  assert.ok(candidates.some((c) => c.includes("AppData")));
  assert.ok(candidates.some((c) => c.includes("Program Files")));
});
