/** Returns the CJS source for the gateway asar main script. */
export function gatewayRunnerMainSource(): string {
  return `"use strict";
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const entry = process.env.OPENCLAUDE_GATEWAY_ENTRY;
if (!entry) {
  process.stderr.write("[openclaude-runner] Missing OPENCLAUDE_GATEWAY_ENTRY\\n");
  process.exit(1);
}

// Isolate Chromium profile from the real Claude Desktop to avoid profile lock conflicts.
const userDataPath = process.env.OPENCLAUDE_RUNNER_USER_DATA_DIR || "";
if (userDataPath) {
  try { fs.mkdirSync(userDataPath, { recursive: true }); } catch {}
  try { app.commandLine.appendSwitch("user-data-dir", userDataPath); } catch {}
  try { app.setPath("userData", userDataPath); } catch {}
}

// Keep runner out of the taskbar and Alt+Tab switcher.
try { app.commandLine.appendSwitch("skip-taskbar"); } catch {}
try { app.setAppUserModelId("dev.openclaude.runner"); } catch {}

// On Windows app.requestSingleInstanceLock() must not exit the process —
// the runner needs to coexist with the real Claude Desktop.
const originalLock = app.requestSingleInstanceLock.bind(app);
app.requestSingleInstanceLock = (...args) => {
  try { originalLock(...args); } catch {}
  return true;
};

function toEntryUrl(p) {
  // ESM dynamic import on Windows requires a file:// URL for absolute paths.
  if (/^[a-zA-Z]:[\\\\/]/.test(p)) {
    return "file:///" + p.replace(/\\\\/g, "/");
  }
  return p;
}

process.stdout.write("[openclaude-runner] loading gateway entry: " + entry + "\\n");
import(toEntryUrl(entry)).catch((err) => {
  process.stderr.write("[openclaude-runner] Failed to load gateway entry: " + String(err) + "\\n");
  process.exit(1);
});
`;
}
