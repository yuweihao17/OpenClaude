import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { gatewayRunnerMainSource } from "./runner-source.js";

const nodeRequire = createRequire(import.meta.url);

function loadAsar() {
  try {
    return nodeRequire("@electron/asar") as {
      createPackage(src: string, dest: string): Promise<void>;
    };
  } catch {
    throw new Error("@electron/asar is required to write the gateway asar. Run: pnpm install");
  }
}

/** Writes the gateway app.asar into runnerResourcesDir and returns its path. */
export async function writeGatewayAsar(opts: {
  runnerResourcesDir: string;
  workDir: string;
}): Promise<string> {
  const { runnerResourcesDir, workDir } = opts;
  const sourceDir = path.join(workDir, "app-src");
  // Remove any previous unpacked app directory — Windows ASAR integrity rejects directory-form entries.
  fs.rmSync(path.join(runnerResourcesDir, "app"), { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  fs.writeFileSync(
    path.join(sourceDir, "package.json"),
    JSON.stringify({ name: "openclaude-gateway-runner", main: "main.cjs" }, null, 2) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(sourceDir, "main.cjs"), gatewayRunnerMainSource(), "utf8");

  const asarPath = path.join(runnerResourcesDir, "app.asar");
  // Remove previous asar so the packer starts clean.
  try { fs.rmSync(asarPath, { force: true }); } catch {}

  const asar = loadAsar();
  await asar.createPackage(sourceDir, asarPath);
  return asarPath;
}
