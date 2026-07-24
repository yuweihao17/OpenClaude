import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DesktopScanResult } from "./types.js";

const nodeRequire = createRequire(import.meta.url);

export interface AsarReader {
  extractFile(asarPath: string, filePath: string): Buffer | string;
  extractJson(asarPath: string): unknown;
}

export interface ScanOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configuredPath?: string;
  candidates?: string[];
  fileSystem?: typeof fs;
  asarReader?: AsarReader | null;
  allowLoadAsar?: boolean;
}

const DEFAULT_COMPONENT_FILENAMES = {
  coworkSvc: ["cowork-svc.exe"],
  chromeNativeHost: ["chrome-native-host.exe"],
  mcpRuntime: ["mcp", "resources/mcp", "mcp-runtime"],
};

function loadAsarReader(allow: boolean): AsarReader | null {
  if (!allow) return null;
  try {
    const mod = nodeRequire("@electron/asar") as {
      extractFile: (asarPath: string, filePath: string) => Buffer;
      extractJson: (asarPath: string) => unknown;
    };
    return { extractFile: mod.extractFile, extractJson: mod.extractJson };
  } catch {
    return null;
  }
}

export function defaultWindowsCandidates(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Roaming");
  const programFiles = env.PROGRAMFILES || "C:\\Program Files";
  const candidates = [
    path.join(localAppData, "AnthropicClaude"),
    path.join(localAppData, "Anthropic", "Claude"),
    path.join(programFiles, "AnthropicClaude"),
    path.join(programFiles, "Anthropic", "Claude"),
    path.join(programFiles, "Claude"),
  ];
  const windowsApps = env.OPENCLAUDE_WINDOWS_APPS_DIR || path.join(programFiles, "WindowsApps");
  for (const sub of expandClaudeAppxDirs(fs, windowsApps)) candidates.push(sub);
  return candidates;
}

export function expandClaudeAppxDirs(fileSystem: typeof fs, windowsAppsDir: string): string[] {
  const result: string[] = [];
  let entries: string[] = [];
  try {
    entries = fileSystem.readdirSync(windowsAppsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return result;
  }
  for (const name of entries) {
    if (/^Claude[_-]/i.test(name)) {
      const full = path.join(windowsAppsDir, name);
      try {
        if (fileSystem.statSync(full).isDirectory()) result.push(full);
      } catch { /* ignore */ }
    }
  }
  return result;
}

function findFirstExisting(fileSystem: typeof fs, candidates: string[]): string {
  for (const candidate of candidates) {
    try { if (fileSystem.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return "";
}

function findComponent(
  fileSystem: typeof fs,
  installPath: string,
  filenames: string[],
  extraSubdirs: string[] = ["", "resources", "resources/app"],
): { found: boolean; path: string } {
  for (const subdir of extraSubdirs) {
    for (const name of filenames) {
      const candidate = path.join(installPath, subdir, name);
      try { if (fileSystem.existsSync(candidate)) return { found: true, path: candidate }; } catch { /* ignore */ }
    }
  }
  return { found: false, path: "" };
}

function isSafeMainEntry(main: unknown): boolean {
  if (typeof main !== "string" || !main.trim()) return false;
  if (path.isAbsolute(main)) return false;
  const normalized = path.normalize(main).replace(/\\/g, "/");
  if (normalized.startsWith("..")) return false;
  return true;
}

interface AppPackageInfo {
  name?: string;
  version?: string;
  main?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readAppPackageInfo(asarReader: AsarReader | null, asarPath: string): { info: AppPackageInfo | null; error: string } {
  if (!asarReader) return { info: null, error: "asar-reader-unavailable" };
  try {
    const info = asarReader.extractJson(asarPath) as AppPackageInfo;
    if (info && typeof info === "object") return { info, error: "" };
    return { info: null, error: "package-json-not-object" };
  } catch {
    try {
      const raw = asarReader.extractFile(asarPath, "package.json");
      const info = JSON.parse(String(raw)) as AppPackageInfo;
      if (info && typeof info === "object") return { info, error: "" };
      return { info: null, error: "package-json-not-object" };
    } catch (innerError) {
      return { info: null, error: (innerError as Error).message || String(innerError) };
    }
  }
}

function detectElectronVersion(fileSystem: typeof fs, installPath: string): string {
  const candidates = [
    path.join(installPath, "version"),
    path.join(installPath, "resources", "version"),
    path.join(installPath, "electron-version"),
  ];
  for (const candidate of candidates) {
    try {
      if (fileSystem.existsSync(candidate)) {
        const text = fileSystem.readFileSync(candidate, "utf-8").trim();
        if (/^\d+\.\d+\.\d+/.test(text)) return text;
      }
    } catch { /* ignore */ }
  }
  return "";
}

export function scanClaudeDesktop(options: ScanOptions = {}): DesktopScanResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const fileSystem = options.fileSystem ?? fs;
  const notes: string[] = [];
  const scannedAt = new Date().toISOString();

  const candidates: string[] = [];
  if (options.configuredPath) candidates.push(options.configuredPath);
  if (options.candidates && options.candidates.length > 0) {
    candidates.push(...options.candidates);
  } else if (platform === "win32") {
    candidates.push(...defaultWindowsCandidates(env, homeDir));
  }

  const installPath = findFirstExisting(fileSystem, candidates);
  if (!installPath) {
    notes.push(
      platform === "win32"
        ? "Claude Desktop install not found in default Windows locations."
        : `Claude Desktop scan skipped on platform ${platform}; inject candidates or run on Windows host.`,
    );
    return {
      found: false,
      installPath: "",
      source: options.configuredPath ? "configured" : "default-candidates",
      packageName: "",
      packageVersion: "",
      electronVersion: "",
      mainEntry: "",
      components: { appAsar: false, coworkSvc: false, chromeNativeHost: false, mcpRuntime: false, wsDependency: false },
      scannedAt,
      notes,
    };
  }

  const asarPath = path.join(installPath, "resources", "app.asar");
  const appAsarExists = (() => { try { return fileSystem.existsSync(asarPath); } catch { return false; } })();

  const asarReader = options.asarReader !== undefined ? options.asarReader : loadAsarReader(options.allowLoadAsar !== false);
  let packageName = "";
  let packageVersion = "";
  let mainEntry = "";
  let wsDependency = false;

  if (appAsarExists) {
    const { info, error } = readAppPackageInfo(asarReader, asarPath);
    if (info) {
      packageName = typeof info.name === "string" ? info.name : "";
      packageVersion = typeof info.version === "string" ? info.version : "";
      if (isSafeMainEntry(info.main)) mainEntry = info.main as string;
      wsDependency = Boolean((info.dependencies && info.dependencies.ws) || (info.devDependencies && info.devDependencies.ws));
      if (!asarReader) notes.push("app.asar found but @electron/asar is not installed; package metadata read skipped.");
    } else if (error === "asar-reader-unavailable") {
      notes.push("app.asar found but @electron/asar is not installed; package metadata read skipped.");
    } else {
      notes.push(`Failed to read package.json from app.asar: ${error}`);
    }
  } else {
    notes.push("app.asar not found under resources/.");
  }

  const electronVersion = detectElectronVersion(fileSystem, installPath);
  if (!electronVersion) notes.push("Electron runtime version could not be determined from install directory; verify on host.");

  const cowork = findComponent(fileSystem, installPath, DEFAULT_COMPONENT_FILENAMES.coworkSvc);
  const nativeHost = findComponent(fileSystem, installPath, DEFAULT_COMPONENT_FILENAMES.chromeNativeHost);
  const mcp = findComponent(fileSystem, installPath, DEFAULT_COMPONENT_FILENAMES.mcpRuntime);

  return {
    found: true,
    installPath,
    source: options.configuredPath ? "configured" : "default-candidates",
    packageName,
    packageVersion,
    electronVersion,
    mainEntry,
    components: {
      appAsar: appAsarExists,
      coworkSvc: cowork.found,
      chromeNativeHost: nativeHost.found,
      mcpRuntime: mcp.found,
      wsDependency,
    },
    scannedAt,
    notes,
  };
}
