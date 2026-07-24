import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanClaudeDesktop,
  defaultWindowsCandidates,
  expandClaudeAppxDirs,
} from "../dist/src/connector/claude-desktop-scanner.js";

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

test("expandClaudeAppxDirs lists Claude_* directories under WindowsApps", (t) => {
  const windowsApps = tempDir(t);
  // 创建 Claude_* AppX 目录与干扰目录（不应被收录）。
  const appx1 = path.join(windowsApps, "Claude_1.24012.1.0_x64__anthropic");
  const appx2 = path.join(windowsApps, "Claude-2.0.0.0_x64");
  const other = path.join(windowsApps, "SomeOtherApp_1.0");
  fs.mkdirSync(appx1, { recursive: true });
  fs.mkdirSync(appx2, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  const result = expandClaudeAppxDirs(fs, windowsApps);
  assert.equal(result.length, 2);
  assert.ok(result.includes(appx1));
  assert.ok(result.includes(appx2));
  assert.ok(!result.includes(other));
});

test("expandClaudeAppxDirs returns empty when directory is missing or unreadable", () => {
  assert.deepEqual(expandClaudeAppxDirs(fs, path.join(os.tmpdir(), "definitely-missing-xyz")), []);
});

test("defaultWindowsCandidates includes WindowsApps Claude_* when OPENCLAUDE_WINDOWS_APPS_DIR is set", (t) => {
  const windowsApps = tempDir(t);
  const appx = path.join(windowsApps, "Claude_1.24012.1.0_x64__anthropic");
  fs.mkdirSync(appx, { recursive: true });

  const candidates = defaultWindowsCandidates(
    {
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      PROGRAMFILES: "C:\\Program Files",
      OPENCLAUDE_WINDOWS_APPS_DIR: windowsApps,
    },
    "C:\\Users\\me",
  );
  assert.ok(candidates.includes(appx), "WindowsApps Claude_* must be a default candidate");
});

test("scanner discovers install under WindowsApps Claude_* via default candidates", (t) => {
  const windowsApps = tempDir(t);
  const appx = path.join(windowsApps, "Claude_1.24012.1.0_x64__anthropic");
  fs.mkdirSync(appx, { recursive: true });
  // 构造一个最小可识别安装：resources/app.asar + version。
  fs.mkdirSync(path.join(appx, "resources"), { recursive: true });
  fs.writeFileSync(path.join(appx, "resources", "app.asar"), "asar-bytes");
  fs.writeFileSync(path.join(appx, "version"), "42.7.0");

  const asarInfo = { name: "@ant/desktop", version: "1.24012.1", main: ".vite/build/index.pre.js" };
  const result = scanClaudeDesktop({
    platform: "win32",
    configuredPath: undefined,
    candidates: defaultWindowsCandidates(
      { LOCALAPPDATA: "/tmp/none", PROGRAMFILES: "/tmp/none", OPENCLAUDE_WINDOWS_APPS_DIR: windowsApps },
      os.homedir(),
    ),
    asarReader: makeAsarReader(asarInfo),
    allowLoadAsar: false,
  });
  assert.equal(result.found, true);
  assert.equal(result.installPath, appx);
  assert.equal(result.packageVersion, "1.24012.1");
});
