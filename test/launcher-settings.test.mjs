import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  resolveLauncherSettings,
  resolveConfiguredClaudePath,
} from "../dist/launcher/settings.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaude-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf-8").digest("hex");
}

// 捕获 console.* 输出，用于断言日志中不含明文密码。
function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return lines;
}

function appEnvFor(userDataDir) {
  return { userDataDir, isPackaged: false, resourcesPath: "", appPath: "" };
}

test("loopback mode requires no auth and sets passwordSource=none", (t) => {
  const root = tempDir(t);
  const settings = resolveLauncherSettings(
    { OPENCLAUDE_HOST: "127.0.0.1", OPENCLAUDE_RUNTIME_DIR: root },
    appEnvFor(root),
  );
  assert.equal(settings.lanMode, false);
  assert.equal(settings.authRequired, false);
  assert.equal(settings.passwordSource, "none");
  assert.equal(settings.generatedPassword, "");
});

test("env password has highest priority: hash written, no plaintext in config or logs", (t) => {
  const root = tempDir(t);
  const configPath = path.join(root, "config.yaml");
  const plaintext = "my-secret-12345";

  const logs = captureConsole(() => {
    resolveLauncherSettings(
      {
        OPENCLAUDE_HOST: "0.0.0.0",
        OPENCLAUDE_ACCESS_PASSWORD: plaintext,
        OPENCLAUDE_CONFIG_PATH: configPath,
        OPENCLAUDE_RUNTIME_DIR: root,
      },
      appEnvFor(root),
    );
  });

  const settings = resolveLauncherSettings(
    {
      OPENCLAUDE_HOST: "0.0.0.0",
      OPENCLAUDE_ACCESS_PASSWORD: plaintext,
      OPENCLAUDE_CONFIG_PATH: configPath,
      OPENCLAUDE_RUNTIME_DIR: root,
    },
    appEnvFor(root),
  );

  assert.equal(settings.lanMode, true);
  assert.equal(settings.authRequired, true);
  assert.equal(settings.passwordSource, "env");
  assert.equal(settings.generatedPassword, "");

  // config.yaml 只存 hash，不含明文。
  const raw = fs.readFileSync(configPath, "utf-8");
  assert.ok(raw.includes("sha256-v1:"));
  assert.ok(!raw.includes(plaintext), "config.yaml must not contain plaintext password");

  // 日志中绝不能出现明文密码。
  for (const line of logs) {
    assert.ok(!line.includes(plaintext), `console log leaked plaintext: ${line}`);
  }
});

test("existing config hash is reused (source=config), no generation, no plaintext", (t) => {
  const root = tempDir(t);
  const configPath = path.join(root, "config.yaml");
  const existingHash = sha256Hex("previously-set");
  fs.writeFileSync(configPath, `# OpenClaude gateway config.\nauth:\n  password: "sha256-v1:${existingHash}"\n`, "utf-8");

  const logs = captureConsole(() => {
    const settings = resolveLauncherSettings(
      { OPENCLAUDE_HOST: "0.0.0.0", OPENCLAUDE_CONFIG_PATH: configPath, OPENCLAUDE_RUNTIME_DIR: root },
      appEnvFor(root),
    );
    assert.equal(settings.passwordSource, "config");
    assert.equal(settings.generatedPassword, "");
  });

  // config.yaml 不被改写为明文，仍是 hash。
  const raw = fs.readFileSync(configPath, "utf-8");
  assert.ok(raw.includes(`sha256-v1:${existingHash}`));
});

test("auto-generated password writes only hash to config; plaintext only in generatedPassword", (t) => {
  const root = tempDir(t);
  const configPath = path.join(root, "config.yaml");

  let settings;
  const logs = captureConsole(() => {
    settings = resolveLauncherSettings(
      { OPENCLAUDE_HOST: "0.0.0.0", OPENCLAUDE_CONFIG_PATH: configPath, OPENCLAUDE_RUNTIME_DIR: root },
      appEnvFor(root),
    );
  });

  assert.equal(settings.passwordSource, "generated");
  assert.ok(settings.generatedPassword.length >= 16, "generated plaintext must be available for UI display");

  // config.yaml 只存 hash，不含明文。
  const raw = fs.readFileSync(configPath, "utf-8");
  assert.ok(raw.includes("sha256-v1:"));
  assert.ok(!raw.includes(settings.generatedPassword), "config.yaml must not contain the generated plaintext");

  // 日志中绝不能出现明文密码。
  for (const line of logs) {
    assert.ok(
      !line.includes(settings.generatedPassword),
      `console log leaked generated plaintext: ${line}`,
    );
  }

  // hash 与明文对应（验证登录链路一致）。
  assert.ok(raw.includes(sha256Hex(settings.generatedPassword)));
});

test("resolveConfiguredClaudePath prefers OPENCLAUDE_CLAUDE_PATH over legacy alias", () => {
  assert.equal(resolveConfiguredClaudePath({ OPENCLAUDE_CLAUDE_PATH: "C:\\new", OPENCLAUDE_CLAUDE_INSTALL_PATH: "C:\\old" }), "C:\\new");
  assert.equal(resolveConfiguredClaudePath({ OPENCLAUDE_CLAUDE_INSTALL_PATH: "C:\\old" }), "C:\\old");
  assert.equal(resolveConfiguredClaudePath({}), "");
});
