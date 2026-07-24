import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { createConnector } from "../connector/index.js";
import { createGateway, type GatewayHandle } from "../../gateway/runtime/gateway.js";
import { resolveLauncherSettings, type ResolvedSettings } from "./launcher-settings.js";
import { createBoundedLogWriter, resolveLogMaxBytes } from "./log-writer.js";
import { createTray, type TrayController } from "./tray.js";
import { diagnosticLog, diagnosticWarn, diagnosticError } from "../../gateway/runtime/core/diagnostics.js";
import { OPENCLAUDE_VERSION_LABEL } from "../../shared/app-version.js";

/**
 * OpenClaude Electron Launcher（主进程）。迁移自 OpenCodex launcher。
 *
 * 职责：
 * - 解析运行设置（loopback / LAN、端口、日志目录、web-shell 目录）。
 * - 创建 Claude Desktop 连接器（默认 unavailable，绝不伪造连接）。
 * - 创建并监听 Gateway；监听失败（端口占用）时尝试一次 +1 重试。
 * - 打开桌面窗口加载 web-shell（与手机端共用同一 UI）。
 * - 系统托盘：状态、重启、退出。
 * - 打包模式下把 stdout/stderr 写入有界日志文件。
 * - 优雅退出：关闭窗口 -> 关闭网关 -> 关闭连接器。
 */

let gateway: GatewayHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: TrayController | null = null;
let settings: ResolvedSettings | null = null;
let logWriter: ReturnType<typeof createBoundedLogWriter> | null = null;
let isQuitting = false;

function installLogCapture(): void {
  if (!settings) return;
  logWriter = createBoundedLogWriter({ maxBytes: resolveLogMaxBytes(process.env) });
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    origLog(...args);
    logWriter?.append(settings!.logPath, `${args.join(" ")}\n`);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    logWriter?.append(settings!.logPath, `${args.join(" ")}\n`, { urgent: true });
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    logWriter?.append(settings!.logPath, `${args.join(" ")}\n`, { urgent: true });
  };
}

async function startGateway(): Promise<void> {
  if (!settings) throw new Error("settings not resolved");
  const connector = createConnector();
  let attemptHost = settings.host;
  let attemptPort = settings.port;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    gateway = createGateway({
      host: attemptHost,
      port: attemptPort,
      connector,
      configPath: settings.configPath,
      webShellDir: settings.webShellDir,
    });
    try {
      await gateway.listen();
      if (attempt > 0) {
        diagnosticWarn("launcher", "port_relocated", { original: settings.port, actual: attemptPort });
      }
      return;
    } catch (error) {
      lastError = error;
      diagnosticError("launcher", "listen_failed", { attempt, host: attemptHost, port: attemptPort, error: String(error) });
      try { await gateway.close(); } catch { /* ignore */ }
      gateway = null;
      attemptPort = attemptPort + 1;
    }
  }
  throw new Error(`Gateway failed to listen: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function createWindow(): Promise<void> {
  if (!gateway || !settings) return;
  const url = `http://${gateway.host === "0.0.0.0" ? "127.0.0.1" : gateway.host}:${gateway.port}/`;
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "OpenClaude",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  try {
    await mainWindow.loadURL(url);
  } catch (error) {
    diagnosticError("launcher", "window_load_failed", { url, error: String(error) });
  }
  mainWindow.on("close", (event) => {
    if (!isQuitting) { event.preventDefault(); mainWindow?.hide(); }
  });
}

function setupTray(): void {
  if (!gateway || !mainWindow) return;
  tray = createTray({
    window: mainWindow,
    onRestart: async () => {
      try {
        await gateway?.restart();
        tray?.setStatus(`running @ ${gateway?.host}:${gateway?.port}`);
        diagnosticLog("launcher", "tray_restart_done", {});
      } catch (error) {
        diagnosticError("launcher", "tray_restart_failed", { error: String(error) });
      }
    },
    onQuit: () => { isQuitting = true; app.quit(); },
    initialStatus: `running @ ${gateway.host}:${gateway.port}`,
  });
}

function printStartupBanner(): void {
  if (!settings || !gateway) return;
  // 绝不记录明文密码。LAN 模式下只记录密码来源（env/config/generated），不记录值。
  diagnosticLog("launcher", "started", {
    version: OPENCLAUDE_VERSION_LABEL,
    host: gateway.host,
    port: gateway.port,
    lanMode: settings.lanMode,
    authRequired: gateway.authRequired,
    passwordSource: settings.passwordSource,
    webShell: settings.webShellDir,
  });
  if (settings.lanMode) {
    for (const url of settings.lanUrls) diagnosticLog("launcher", "lan_url", { url });
  } else {
    diagnosticLog("launcher", "loopback_url", { url: `http://127.0.0.1:${gateway.port}/` });
  }
}

/**
 * 自动生成的 LAN 密码只能通过本地窗口一次性展示。
 * 若窗口不可用（headless/加载失败），启动失败并提示用户显式设置 OPENCLAUDE_ACCESS_PASSWORD。
 * 明文绝不写日志、URL 或配置文件。
 */
async function presentGeneratedPassword(): Promise<void> {
  if (!settings || !mainWindow) return;
  if (settings.passwordSource !== "generated" || !settings.generatedPassword) return;
  const password = settings.generatedPassword;
  // 立即从主进程内存清除；窗口渲染进程拿到一次性 IPC 后自行渲染。
  settings.generatedPassword = "";
  const wc = mainWindow.webContents;
  const sendOnce = (): void => {
    try {
      wc.send("openclaude:initial-password", password);
      diagnosticLog("launcher", "lan_password_presented", {});
    } catch (error) {
      diagnosticError("launcher", "lan_password_present_failed", { error: String(error) });
    }
  };
  if (wc.isLoading()) {
    wc.once("did-finish-load", () => sendOnce());
  } else {
    sendOnce();
  }
}

app.whenReady().then(async () => {
  try {
    settings = resolveLauncherSettings();
    if (app.isPackaged) installLogCapture();
    await startGateway();
    await createWindow();
    // 自动生成密码必须能通过窗口展示，否则 LAN 模式用户无法登录 -> 明确失败。
    if (settings.passwordSource === "generated" && !mainWindow) {
      throw new Error(
        "LAN mode auto-generated a password but no desktop window is available to display it. " +
          "Set OPENCLAUDE_ACCESS_PASSWORD explicitly, or pre-populate config.yaml with a sha256-v1 hash.",
      );
    }
    await presentGeneratedPassword();
    setupTray();
    printStartupBanner();
  } catch (error) {
    diagnosticError("launcher", "startup_failed", { error: String(error) });
    app.quit();
    return;
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    else mainWindow?.show();
  });
});

app.on("window-all-closed", () => {
  // 不退出：托盘常驻，网关继续为手机端服务。
  if (process.platform === "darwin") return;
});

app.on("before-quit", async (event) => {
  if (!gateway) return;
  event.preventDefault();
  try { await gateway.close(); } catch (error) {
    diagnosticError("launcher", "gateway_close_failed", { error: String(error) });
  }
  gateway = null;
  tray?.destroy();
  logWriter?.close();
  app.exit(0);
});
