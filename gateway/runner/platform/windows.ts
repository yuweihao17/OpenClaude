import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { diagnosticLog } from "../../runtime/core/diagnostics.js";
import type { DesktopScanResult } from "../types.js";
import { writeGatewayAsar } from "./runner-asar.js";
import { tryPatchWindowsAsarIntegrity } from "./windows-integrity.js";

export interface WindowsRunnerLayout {
  runtimeRoot: string;
  appRoot: string;
  asarPath: string;
  executablePath: string;
}

export interface WindowsRunnerResult {
  /** Path to the copied Claude.exe in the runner directory. */
  executablePath: string;
  /** Root of the runner directory (the copied Electron runtime). */
  runnerRootDir: string;
  /** Path to our gateway app.asar inside the runner. */
  runnerAsarPath: string;
  /** Original Claude Desktop install root. */
  officialAppRoot: string;
  /** Original app.asar path in the Claude Desktop install. */
  officialAsarPath: string;
}

const CLAUDE_EXE_CANDIDATES = ["Claude.exe", "claude.exe", "Anthropic Claude.exe"];

function resolveClaudeExecutable(installPath: string): string {
  // Check both root and app subdirectory
  const searchDirs = [installPath, path.join(installPath, "app")];
  for (const dir of searchDirs) {
    for (const name of CLAUDE_EXE_CANDIDATES) {
      const p = path.join(dir, name);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  // Fall back to AppxManifest.xml for Windows Store installs.
  const manifestExe = readExecutableFromAppxManifest(installPath);
  if (manifestExe) return path.join(installPath, manifestExe);
  return path.join(installPath, "Claude.exe");
}

function readExecutableFromAppxManifest(installPath: string): string {
  const manifestPath = path.join(installPath, "AppxManifest.xml");
  try {
    const text = fs.readFileSync(manifestPath, "utf-8");
    // <Application Executable="Claude.exe" ...>
    const m = text.match(/<Application[^>]+Executable="([^"]+\.exe)"/i);
    if (m) return path.basename(m[1]);
  } catch {}
  return "";
}

export function layoutFromScan(scan: DesktopScanResult): WindowsRunnerLayout {
  const executablePath = resolveClaudeExecutable(scan.installPath);

  // If executable is in app/ subdirectory, runtime files are there too
  const exeDir = path.dirname(executablePath);
  const runtimeRoot = exeDir !== scan.installPath ? exeDir : scan.installPath;

  // Look for resources/app.asar in both runtime root and install root
  let asarPath = path.join(runtimeRoot, "resources", "app.asar");
  if (!fs.existsSync(asarPath)) {
    asarPath = path.join(scan.installPath, "resources", "app.asar");
  }

  return {
    runtimeRoot,
    appRoot: scan.installPath,
    asarPath,
    executablePath,
  };
}

interface RuntimeFingerprint {
  platform: string;
  arch: string;
  runtimeRoot: string;
  executableSize: number;
  executableMtime: number;
  asarSize: number;
  asarMtime: number;
}

function buildFingerprint(layout: WindowsRunnerLayout): RuntimeFingerprint {
  function stat(p: string) {
    try {
      const s = fs.statSync(p);
      return { size: s.size, mtime: Math.trunc(s.mtimeMs) };
    } catch {
      return { size: 0, mtime: 0 };
    }
  }
  const exe = stat(layout.executablePath);
  const asar = stat(layout.asarPath);
  return {
    platform: process.platform,
    arch: process.arch,
    runtimeRoot: layout.runtimeRoot,
    executableSize: exe.size,
    executableMtime: exe.mtime,
    asarSize: asar.size,
    asarMtime: asar.mtime,
  };
}

function readJsonSafe(p: string): unknown {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function shouldSkipEntry(entryName: string, entryPath: string, layout: WindowsRunnerLayout): boolean {
  const lower = entryName.toLowerCase();
  // Never copy the official resources/ directory — we write our own.
  if (lower === "resources") return true;
  // Skip the official asar and its unpacked companion.
  const asarReal = tryRealpath(layout.asarPath);
  if (tryRealpath(entryPath) === asarReal) return true;
  if (tryRealpath(entryPath) === tryRealpath(layout.asarPath + ".unpacked")) return true;
  return false;
}

function tryRealpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function copyFileOrDir(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      copyFileOrDir(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else if (stat.isFile()) {
    const content = fs.readFileSync(src);
    fs.writeFileSync(dest, content);
  } else if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    fs.symlinkSync(target, dest);
  }
}

function copyRuntimeFiles(layout: WindowsRunnerLayout, destDir: string): void {
  const entries = fs.readdirSync(layout.runtimeRoot, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(layout.runtimeRoot, entry.name);
    if (shouldSkipEntry(entry.name, src, layout)) continue;
    const dest = path.join(destDir, entry.name);
    copyFileOrDir(src, dest);
  }
  // Copy the executable separately
  const destExe = path.join(destDir, path.basename(layout.executablePath));
  const content = fs.readFileSync(layout.executablePath);
  fs.writeFileSync(destExe, content);
}

export interface CreateWindowsRunnerOptions {
  /** Directory where the runner state is cached across launches. */
  runtimeDir?: string;
}

/**
 * Prepares the Windows runner directory: copies Claude Desktop's Electron
 * runtime, writes our gateway app.asar, and patches ASAR integrity in the exe.
 * Returns paths needed to spawn the runner process.
 */
export async function createWindowsRunner(
  scan: DesktopScanResult,
  options: CreateWindowsRunnerOptions = {}
): Promise<WindowsRunnerResult> {
  if (!scan.found) {
    throw new Error("Claude Desktop not found; cannot create Windows runner.");
  }

  const runtimeDir =
    options.runtimeDir ||
    path.join(os.homedir(), "AppData", "Local", "openclaude", "runner");

  const layout = layoutFromScan(scan);
  const runnerRootDir = path.join(runtimeDir, `${process.platform}-${process.arch}`);
  const runnerResourcesDir = path.join(runnerRootDir, "resources");
  const runnerExecutablePath = path.join(runnerRootDir, path.basename(layout.executablePath));
  const markerPath = path.join(runtimeDir, `manifest-${process.platform}-${process.arch}.json`);
  const workDir = path.join(runtimeDir, "work");

  const nextFingerprint = buildFingerprint(layout);
  const cached = readJsonSafe(markerPath) as { fingerprint?: RuntimeFingerprint } | null;
  const hit =
    cached &&
    JSON.stringify(cached.fingerprint) === JSON.stringify(nextFingerprint) &&
    isDirectory(runnerRootDir) &&
    isFile(runnerExecutablePath);

  if (!hit) {
    diagnosticLog("windows-runner", "runtime_copy_start", { runtimeRoot: layout.runtimeRoot, dest: runnerRootDir });
    try {
      fs.rmSync(runnerRootDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore errors if directory doesn't exist or is locked
    }
    fs.mkdirSync(runnerRootDir, { recursive: true });
    copyRuntimeFiles(layout, runnerRootDir);
    writeManifest(markerPath, nextFingerprint);
    diagnosticLog("windows-runner", "runtime_copy_done", { dest: runnerRootDir });
  } else {
    diagnosticLog("windows-runner", "runtime_copy_cache_hit", { dest: runnerRootDir });
  }

  // Always regenerate the gateway asar so it reflects the current build.
  try {
    fs.rmSync(runnerResourcesDir, { recursive: true, force: true });
  } catch (err) {
    // Ignore errors if directory doesn't exist or is locked
  }
  fs.mkdirSync(runnerResourcesDir, { recursive: true });
  const runnerAsarPath = await writeGatewayAsar({ runnerResourcesDir, workDir });

  tryPatchWindowsAsarIntegrity({
    runnerRootDir,
    runnerExecutablePath,
    sourceExecutablePath: layout.executablePath,
    runnerAsarPath,
  });

  diagnosticLog("windows-runner", "runner_ready", {
    executablePath: runnerExecutablePath,
    asarPath: runnerAsarPath,
    officialAsarPath: layout.asarPath,
  });

  return {
    executablePath: runnerExecutablePath,
    runnerRootDir,
    runnerAsarPath,
    officialAppRoot: layout.appRoot,
    officialAsarPath: layout.asarPath,
  };
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function writeManifest(markerPath: string, fingerprint: RuntimeFingerprint): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ fingerprint, copiedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8"
  );
}

/**
 * Spawns the runner process with the given gateway entry and isolated profile.
 * Returns the spawned ChildProcess.
 */
export function spawnWindowsRunner(opts: {
  runnerResult: WindowsRunnerResult;
  gatewayEntryPath: string;
  userDataDir: string;
  officialAsarPath: string;
}): ChildProcess {
  const { runnerResult, gatewayEntryPath, userDataDir, officialAsarPath } = opts;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAUDE_GATEWAY_ENTRY: gatewayEntryPath,
    OPENCLAUDE_RUNNER_USER_DATA_DIR: userDataDir,
    OPENCLAUDE_OFFICIAL_ASAR_PATH: officialAsarPath,
    OPENCLAUDE_OFFICIAL_APP_ROOT: runnerResult.officialAppRoot,
    ELECTRON_RUN_AS_NODE: "0",
  };
  return nodeSpawn(runnerResult.executablePath, ["--no-sandbox"], {
    env,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
