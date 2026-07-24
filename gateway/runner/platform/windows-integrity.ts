import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { diagnosticLog, diagnosticWarn } from "../../runtime/core/diagnostics.js";

const nodeRequire = createRequire(import.meta.url);

function asarHeaderSha256(asarPath: string): string {
  const asar = nodeRequire("@electron/asar") as {
    getRawHeader(p: string): { headerString: string };
  };
  const { headerString } = asar.getRawHeader(asarPath);
  return crypto.createHash("sha256").update(headerString).digest("hex");
}

interface Resedit {
  NtExecutable: {
    from(data: Buffer, opts: { ignoreCert: boolean }): NtExe;
  };
  NtExecutableResource: {
    from(exe: NtExe): NtRes;
  };
}

interface NtExe {
  generate(): ArrayBuffer;
}

interface NtRes {
  entries: Array<{ type: string; id: string; lang: number }>;
  replaceResourceEntryFromString(type: string, id: string, lang: number, value: string): void;
  outputResource(exe: NtExe): void;
}

function loadResedit(): Resedit {
  try {
    return nodeRequire("resedit") as Resedit;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `resedit is required to patch Windows ASAR integrity. Run: pnpm add resedit. Details: ${msg}`
    );
  }
}

function isIntegrityEntry(entry: { type: string; id: string }): boolean {
  return (
    String(entry.type).toUpperCase() === "INTEGRITY" &&
    String(entry.id).toUpperCase() === "ELECTRONASAR"
  );
}

function assertSafeTarget(opts: {
  runnerRootDir: string;
  runnerExecutablePath: string;
  sourceExecutablePath: string;
}): void {
  const { runnerRootDir, runnerExecutablePath, sourceExecutablePath } = opts;
  const rel = path.relative(runnerRootDir, runnerExecutablePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to patch executable outside runner root: ${runnerExecutablePath}`
    );
  }
  const srcReal = realSafe(sourceExecutablePath).toLowerCase();
  const dstReal = realSafe(runnerExecutablePath).toLowerCase();
  if (srcReal && srcReal === dstReal) {
    throw new Error(
      `Refusing to patch the official Claude Desktop executable: ${runnerExecutablePath}`
    );
  }
}

function realSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export interface AsarIntegrityPatchOptions {
  runnerRootDir: string;
  runnerExecutablePath: string;
  sourceExecutablePath: string;
  runnerAsarPath: string;
}

/**
 * Patches the ElectronAsar INTEGRITY PE resource in the copied Claude.exe so
 * Electron will accept our gateway app.asar. Only runs on win32; no-op elsewhere.
 */
export function patchWindowsAsarIntegrity(opts: AsarIntegrityPatchOptions): void {
  if (process.platform !== "win32") return;
  assertSafeTarget(opts);

  const { runnerExecutablePath, runnerAsarPath } = opts;
  const { NtExecutable, NtExecutableResource } = loadResedit();
  const headerHash = asarHeaderSha256(runnerAsarPath);
  const resourceValue = JSON.stringify([
    { file: "resources\\app.asar", alg: "sha256", value: headerHash },
  ]);

  const exeData = fs.readFileSync(runnerExecutablePath);
  const exe = NtExecutable.from(exeData, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const existing = res.entries.filter(isIntegrityEntry);
  const lang = existing.length > 0 ? existing[0].lang : 1033;
  // Remove old entries first so we don't leave a stale INTEGRITY/ELECTRONASAR alongside the new one.
  res.entries = res.entries.filter((e) => !isIntegrityEntry(e));
  res.replaceResourceEntryFromString("INTEGRITY", "ELECTRONASAR", lang, resourceValue);
  res.outputResource(exe);
  fs.writeFileSync(runnerExecutablePath, Buffer.from(exe.generate()));

  diagnosticLog("windows-runner", "asar_integrity_patched", {
    executablePath: runnerExecutablePath,
    asarPath: runnerAsarPath,
    headerSha256: headerHash,
    lang,
  });
}

export function tryPatchWindowsAsarIntegrity(opts: AsarIntegrityPatchOptions): void {
  try {
    patchWindowsAsarIntegrity(opts);
  } catch (err) {
    diagnosticWarn("windows-runner", "asar_integrity_patch_failed", {
      error: err instanceof Error ? err.message : String(err),
      executablePath: opts.runnerExecutablePath,
    });
    throw err;
  }
}
