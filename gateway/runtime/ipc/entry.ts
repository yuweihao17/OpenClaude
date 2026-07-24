import path from "node:path";
import { createRequire } from "node:module";
import { alignClaudeEnvironment, installElectronHooks, loadClaudeBootstrap, setIpcBroadcaster } from "./claude-bridge.js";
import { IpcBridgeConnector } from "./ipc-bridge-connector.js";
import { createGateway } from "../gateway.js";
import { diagnosticLog, diagnosticWarn, diagnosticError } from "../core/diagnostics.js";

const nodeRequire = createRequire(import.meta.url);

interface AsarReader {
  extractFile(asarPath: string, filePath: string): Buffer | string;
}

function loadAsarReader(): AsarReader | null {
  try {
    const mod = nodeRequire("@electron/asar") as {
      extractFile: (asarPath: string, filePath: string) => Buffer;
    };
    return { extractFile: mod.extractFile };
  } catch (error) {
    diagnosticWarn("gateway-entry", "asar_reader_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function readPackageJsonFromAsar(asarPath: string): { main?: string } | null {
  const asarReader = loadAsarReader();
  if (!asarReader) {
    diagnosticWarn("gateway-entry", "cannot_read_asar_without_reader", { asarPath });
    return null;
  }

  try {
    const raw = asarReader.extractFile(asarPath, "package.json");
    const pkg = JSON.parse(String(raw)) as { main?: string };
    return pkg;
  } catch (error) {
    diagnosticWarn("gateway-entry", "read_package_json_failed", {
      asarPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function resolveBootstrapPath(asarPath: string, mainEntry: string): string {
  // In Electron, asar files can be required directly via path like "/path/to/app.asar/main.js"
  // Normalize the main entry to remove leading ./ and ensure proper path joining
  const normalizedMain = mainEntry.replace(/^\.\//, "");
  return path.join(asarPath, normalizedMain);
}

async function main(): Promise<void> {
  diagnosticLog("gateway-entry", "starting", {});

  // Read environment variables
  const asarPath = process.env.OPENCLAUDE_OFFICIAL_ASAR_PATH;
  const userDataDir = process.env.OPENCLAUDE_RUNNER_USER_DATA_DIR;
  const installPath = process.env.OPENCLAUDE_OFFICIAL_APP_ROOT;

  if (!asarPath) {
    diagnosticError("gateway-entry", "missing_asar_path", {
      message: "OPENCLAUDE_OFFICIAL_ASAR_PATH is required",
    });
    throw new Error("OPENCLAUDE_OFFICIAL_ASAR_PATH environment variable is required");
  }

  if (!userDataDir) {
    diagnosticError("gateway-entry", "missing_user_data_dir", {
      message: "OPENCLAUDE_RUNNER_USER_DATA_DIR is required",
    });
    throw new Error("OPENCLAUDE_RUNNER_USER_DATA_DIR environment variable is required");
  }

  if (!installPath) {
    diagnosticError("gateway-entry", "missing_install_path", {
      message: "OPENCLAUDE_OFFICIAL_APP_ROOT is required",
    });
    throw new Error("OPENCLAUDE_OFFICIAL_APP_ROOT environment variable is required");
  }

  // Read package.json from asar to get the main entry
  const pkg = readPackageJsonFromAsar(asarPath);
  const mainEntry = pkg?.main || "main.js";
  const bootstrapPath = resolveBootstrapPath(asarPath, mainEntry);

  diagnosticLog("gateway-entry", "configuration", {
    asarPath,
    userDataDir,
    installPath,
    mainEntry,
    bootstrapPath,
  });

  // Step 1: Align Claude environment
  alignClaudeEnvironment({ asarPath, installPath, userDataDir });

  // Step 2: Install Electron hooks
  installElectronHooks();

  // Step 3: Create the IPC bridge connector
  const connector = new IpcBridgeConnector();

  // Step 4: Set up the broadcaster to route webContents.send to connector listeners
  setIpcBroadcaster((channel: string, payload: unknown, _args: unknown[]) => {
    // For now, just log unknown IPC messages for channel discovery
    diagnosticLog("ipc-broadcast", "unknown_channel", {
      channel,
      payloadType: typeof payload,
    });

    // Future: parse payload and emit SessionEvent through connector.emitEvent()
    // For now, this is a placeholder for channel discovery
  });

  // Step 5: Create and start the gateway
  const gateway = createGateway({ connector });

  try {
    await gateway.listen();
    diagnosticLog("gateway-entry", "gateway_listening", {
      host: gateway.host,
      port: gateway.port,
      authRequired: gateway.authRequired,
    });
  } catch (error) {
    diagnosticError("gateway-entry", "gateway_listen_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // Step 6: Load Claude Desktop's official bootstrap
  // This must happen AFTER the gateway is listening so that when Claude's renderer
  // initializes and registers IPC handlers, we're ready to capture them
  try {
    loadClaudeBootstrap(bootstrapPath);
    diagnosticLog("gateway-entry", "bootstrap_complete", {
      bootstrapPath,
    });
  } catch (error) {
    diagnosticError("gateway-entry", "bootstrap_failed", {
      bootstrapPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  diagnosticLog("gateway-entry", "ready", {
    message: "OpenClaude gateway is ready with Claude Desktop IPC bridge",
  });
}

// Start the gateway
main().catch((error) => {
  diagnosticError("gateway-entry", "fatal_error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
