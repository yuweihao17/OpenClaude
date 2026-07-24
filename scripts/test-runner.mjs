#!/usr/bin/env node
/**
 * Test script to start the Windows runner and observe IPC traffic.
 * Usage: OPENCLAUDE_CLAUDE_PATH="D:/path/to/claude/app" node scripts/test-runner.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPath = path.join(projectRoot, "dist");

async function main() {
  console.log("[test-runner] Loading scanner...");
  const scannerUrl = pathToFileURL(path.join(distPath, "gateway", "runner", "official-layout.js")).href;
  const { scanClaudeDesktop } = await import(scannerUrl);

  const scan = scanClaudeDesktop({
    configuredPath: process.env.OPENCLAUDE_CLAUDE_PATH || "",
    platform: process.platform,
  });

  if (!scan.found) {
    console.error("[test-runner] Claude Desktop not found.");
    console.error("[test-runner] Set OPENCLAUDE_CLAUDE_PATH environment variable.");
    process.exit(1);
  }

  console.log("[test-runner] Claude Desktop found:");
  console.log(`  Version: ${scan.packageVersion}`);
  console.log(`  Electron: ${scan.electronVersion}`);
  console.log(`  Install: ${scan.installPath}`);
  console.log(`  Main entry: ${scan.mainEntry}`);

  console.log("\n[test-runner] Creating Windows runner...");
  const runnerUrl = pathToFileURL(path.join(distPath, "gateway", "runner", "platform", "windows.js")).href;
  const { createWindowsRunner, spawnWindowsRunner } = await import(runnerUrl);

  const runnerResult = await createWindowsRunner(scan, {
    runtimeDir: path.join(projectRoot, ".openclaude-test", "runner-v2"),
  });

  console.log("[test-runner] Runner prepared:");
  console.log(`  Executable: ${runnerResult.executablePath}`);
  console.log(`  Runner asar: ${runnerResult.runnerAsarPath}`);
  console.log(`  Official asar: ${runnerResult.officialAsarPath}`);

  console.log("\n[test-runner] Spawning runner process...");
  const gatewayEntryPath = path.join(distPath, "gateway", "runtime", "ipc", "entry.js");
  const userDataDir = path.join(projectRoot, ".openclaude-test", "user-data");

  // Use a different port to avoid conflicts with real Claude Desktop
  process.env.OPENCLAUDE_PORT = "51700";
  process.env.OPENCLAUDE_HOST = "127.0.0.1";

  const child = spawnWindowsRunner({
    runnerResult,
    gatewayEntryPath,
    userDataDir,
    officialAsarPath: runnerResult.officialAsarPath,
  });

  console.log(`[test-runner] Runner spawned (PID: ${child.pid})`);
  console.log("[test-runner] Watching stdout/stderr...\n");

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[runner-out] ${chunk}`);
  });

  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[runner-err] ${chunk}`);
  });

  child.on("exit", (code, signal) => {
    console.log(`\n[test-runner] Runner exited: code=${code}, signal=${signal}`);
    process.exit(code || 0);
  });

  child.on("error", (err) => {
    console.error(`[test-runner] Runner error: ${err.message}`);
    process.exit(1);
  });

  // Keep the test script running
  process.on("SIGINT", () => {
    console.log("\n[test-runner] Received SIGINT, killing runner...");
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000);
  });

  // Wait a bit then try to connect to the HTTP server
  setTimeout(async () => {
    try {
      const response = await fetch("http://127.0.0.1:51700/api/health");
      const data = await response.json();
      console.log("\n[test-runner] Gateway health check:");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`\n[test-runner] Health check failed: ${err.message}`);
    }
  }, 5000);
}

main().catch((err) => {
  console.error("[test-runner] Fatal error:", err);
  process.exit(1);
});
