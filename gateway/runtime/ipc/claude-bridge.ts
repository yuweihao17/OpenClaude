import { createRequire } from "node:module";
import { diagnosticLog, diagnosticWarn } from "../core/diagnostics.js";

const nodeRequire = createRequire(import.meta.url);

// Electron APIs loaded via require (runs inside spawned Electron process)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electron: any = nodeRequire("electron");
const { app, ipcMain } = electron;

interface OfficialIpcState {
  handlers: Map<string, (...args: unknown[]) => unknown>;
  listeners: Map<string, Set<(...args: unknown[]) => unknown>>;
  hiddenWindow: unknown;
  hiddenWebContents: unknown;
}

const officialIpc: OfficialIpcState = {
  handlers: new Map(),
  listeners: new Map(),
  hiddenWindow: null,
  hiddenWebContents: null,
};

let broadcaster: ((channel: string, payload: unknown, args: unknown[]) => void) | null = null;

export function setIpcBroadcaster(fn: (channel: string, payload: unknown, args: unknown[]) => void): void {
  broadcaster = fn;
  diagnosticLog("claude-bridge", "broadcaster_registered", {});
}

function payloadFromArgs(args: unknown[]): unknown {
  return args.length <= 1 ? (args[0] ?? null) : args;
}

function routeOfficialWebContentsSend(channel: string, args: unknown[]): void {
  const payload = payloadFromArgs(args);
  if (!broadcaster) {
    diagnosticWarn("claude-bridge", "send_before_broadcaster", { channel });
    return;
  }
  broadcaster(channel, payload, args);
}

function addOfficialListener(channel: string, listener: (...args: unknown[]) => unknown): void {
  const set = officialIpc.listeners.get(channel) || new Set();
  set.add(listener);
  officialIpc.listeners.set(channel, set);
}

function removeOfficialListener(channel: string, listener: (...args: unknown[]) => unknown): void {
  const set = officialIpc.listeners.get(channel);
  if (!set) return;
  set.delete(listener);
  if (set.size === 0) officialIpc.listeners.delete(channel);
}

function listenerCount(): number {
  return Array.from(officialIpc.listeners.values()).reduce((sum, set) => sum + set.size, 0);
}

export function installElectronHooks(): void {
  installIpcMainHooks();
  installBrowserWindowHooks();
  patchOfficialAppSingleton();
  diagnosticLog("claude-bridge", "electron_hooks_installed", {
    handlers: officialIpc.handlers.size,
    listeners: listenerCount(),
  });
}

function installIpcMainHooks(): void {
  if ((ipcMain as { __openclaudeOfficialGatewayPatched?: boolean }).__openclaudeOfficialGatewayPatched) return;
  (ipcMain as { __openclaudeOfficialGatewayPatched?: boolean }).__openclaudeOfficialGatewayPatched = true;

  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = typeof ipcMain.handleOnce === "function" ? ipcMain.handleOnce.bind(ipcMain) : null;
  const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);
  const originalAddListener = typeof ipcMain.addListener === "function" ? ipcMain.addListener.bind(ipcMain) : null;
  const originalOnce = ipcMain.once.bind(ipcMain);
  const originalPrependListener = typeof ipcMain.prependListener === "function" ? ipcMain.prependListener.bind(ipcMain) : null;
  const originalPrependOnceListener = typeof ipcMain.prependOnceListener === "function" ? ipcMain.prependOnceListener.bind(ipcMain) : null;
  const originalRemoveListener = ipcMain.removeListener.bind(ipcMain);
  const originalOff = typeof ipcMain.off === "function" ? ipcMain.off.bind(ipcMain) : null;
  const originalRemoveAllListeners = ipcMain.removeAllListeners.bind(ipcMain);

  ipcMain.handle = (channel: string, listener: (...args: unknown[]) => unknown) => {
    officialIpc.handlers.set(String(channel), listener);
    return originalHandle(channel, listener);
  };

  if (originalHandleOnce) {
    ipcMain.handleOnce = (channel: string, listener: (...args: unknown[]) => unknown) => {
      const wrapped = async (...args: unknown[]) => {
        officialIpc.handlers.delete(String(channel));
        return listener(...args);
      };
      officialIpc.handlers.set(String(channel), wrapped);
      return originalHandleOnce(channel, wrapped);
    };
  }

  ipcMain.removeHandler = (channel: string) => {
    officialIpc.handlers.delete(String(channel));
    return originalRemoveHandler(channel);
  };

  ipcMain.on = (channel: string, listener: (...args: unknown[]) => unknown) => {
    addOfficialListener(String(channel), listener);
    return originalOn(channel, listener);
  };

  if (originalAddListener) {
    ipcMain.addListener = (channel: string, listener: (...args: unknown[]) => unknown) => {
      addOfficialListener(String(channel), listener);
      return originalAddListener(channel, listener);
    };
  }

  ipcMain.once = (channel: string, listener: (...args: unknown[]) => unknown) => {
    const wrapped = (...args: unknown[]) => {
      removeOfficialListener(String(channel), wrapped);
      return listener(...args);
    };
    addOfficialListener(String(channel), wrapped);
    return originalOnce(channel, wrapped);
  };

  if (originalPrependListener) {
    ipcMain.prependListener = (channel: string, listener: (...args: unknown[]) => unknown) => {
      addOfficialListener(String(channel), listener);
      return originalPrependListener(channel, listener);
    };
  }

  if (originalPrependOnceListener) {
    ipcMain.prependOnceListener = (channel: string, listener: (...args: unknown[]) => unknown) => {
      const wrapped = (...args: unknown[]) => {
        removeOfficialListener(String(channel), wrapped);
        return listener(...args);
      };
      addOfficialListener(String(channel), wrapped);
      return originalPrependOnceListener(channel, wrapped);
    };
  }

  ipcMain.removeListener = (channel: string, listener: (...args: unknown[]) => unknown) => {
    removeOfficialListener(String(channel), listener);
    return originalRemoveListener(channel, listener);
  };

  if (originalOff) {
    ipcMain.off = (channel: string, listener: (...args: unknown[]) => unknown) => {
      removeOfficialListener(String(channel), listener);
      return originalOff(channel, listener);
    };
  }

  ipcMain.removeAllListeners = (channel?: string) => {
    if (typeof channel === "string") {
      officialIpc.listeners.delete(channel);
    } else {
      officialIpc.listeners.clear();
    }
    return originalRemoveAllListeners(channel);
  };
}

function hideOfficialWindow(win: { setOpacity?: (v: number) => void; setPosition?: (x: number, y: number, animate: boolean) => void; hide?: () => void; setSkipTaskbar?: (skip: boolean) => void }): void {
  try { win.setOpacity?.(0); } catch { /* ignore */ }
  try { win.setPosition?.(-32000, -32000, false); } catch { /* ignore */ }
  try { win.hide?.(); } catch { /* ignore */ }
  try { win.setSkipTaskbar?.(true); } catch { /* ignore */ }
}

function sameWebContents(left: unknown, right: unknown): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftId = (left as { id?: number }).id;
  const rightId = (right as { id?: number }).id;
  return typeof leftId === "number" && typeof rightId === "number" && leftId === rightId;
}

function isOfficialHiddenWebContents(webContents: unknown): boolean {
  return sameWebContents(webContents, officialIpc.hiddenWebContents);
}

function patchOfficialWebContents(webContents: unknown): void {
  if (!webContents || (webContents as { __openclaudeOfficialGatewayPatched?: boolean }).__openclaudeOfficialGatewayPatched) return;
  (webContents as { __openclaudeOfficialGatewayPatched?: boolean }).__openclaudeOfficialGatewayPatched = true;

  const wc = webContents as {
    send: (channel: string, ...args: unknown[]) => void;
    postMessage?: (channel: string, message: unknown, transfer?: unknown) => void;
    sendToFrame?: (frameId: number, channel: string, ...args: unknown[]) => void;
    mainFrame?: { postMessage?: (channel: string, message: unknown, transfer?: unknown) => void };
  };

  const originalSend = wc.send.bind(webContents);
  wc.send = (channel: string, ...args: unknown[]) => {
    routeOfficialWebContentsSend(String(channel), args);
    return originalSend(channel, ...args);
  };

  if (typeof wc.postMessage === "function") {
    const originalPostMessage = wc.postMessage.bind(webContents);
    wc.postMessage = (channel: string, message: unknown, transfer?: unknown) => {
      routeOfficialWebContentsSend(String(channel), [message]);
      return originalPostMessage(channel, message, transfer);
    };
  }

  if (typeof wc.sendToFrame === "function") {
    const originalSendToFrame = wc.sendToFrame.bind(webContents);
    wc.sendToFrame = (frameId: number, channel: string, ...args: unknown[]) => {
      routeOfficialWebContentsSend(String(channel), args);
      return originalSendToFrame(frameId, channel, ...args);
    };
  }

  if (wc.mainFrame && typeof wc.mainFrame.postMessage === "function") {
    const originalFramePostMessage = wc.mainFrame.postMessage.bind(wc.mainFrame);
    wc.mainFrame.postMessage = (channel: string, message: unknown, transfer?: unknown) => {
      routeOfficialWebContentsSend(String(channel), [message]);
      return originalFramePostMessage(channel, message, transfer);
    };
  }
}

function registerOfficialWindow(win: unknown): void {
  if (!win || (win as { __openclaudeOfficialGatewayRegistered?: boolean }).__openclaudeOfficialGatewayRegistered) return;
  (win as { __openclaudeOfficialGatewayRegistered?: boolean }).__openclaudeOfficialGatewayRegistered = true;

  const window = win as {
    isDestroyed?: () => boolean;
    webContents: unknown;
    on?: (event: string, cb: () => void) => void;
  };

  if (!officialIpc.hiddenWindow || (officialIpc.hiddenWindow as { isDestroyed?: () => boolean }).isDestroyed?.()) {
    officialIpc.hiddenWindow = win;
    officialIpc.hiddenWebContents = window.webContents;
  }

  hideOfficialWindow(win as Parameters<typeof hideOfficialWindow>[0]);
  patchOfficialWebContents(window.webContents);

  window.on?.("show", () => hideOfficialWindow(win as Parameters<typeof hideOfficialWindow>[0]));
  window.on?.("ready-to-show", () => hideOfficialWindow(win as Parameters<typeof hideOfficialWindow>[0]));
  window.on?.("closed", () => {
    if (officialIpc.hiddenWindow === win) {
      officialIpc.hiddenWindow = null;
      officialIpc.hiddenWebContents = null;
    }
  });
}

function installBrowserWindowHooks(): void {
  if ((electron as { __openclaudeOfficialGatewayBrowserWindowPatched?: boolean }).__openclaudeOfficialGatewayBrowserWindowPatched) return;
  (electron as { __openclaudeOfficialGatewayBrowserWindowPatched?: boolean }).__openclaudeOfficialGatewayBrowserWindowPatched = true;

  const NativeBrowserWindow = electron.BrowserWindow;

  function GatewayBrowserWindow(options: unknown = {}) {
    const opts = options as { show?: boolean; opacity?: number; x?: number; y?: number };
    const win = new NativeBrowserWindow({
      ...opts,
      show: false,
      opacity: 0,
      x: -32000,
      y: -32000,
    });
    registerOfficialWindow(win);
    return win;
  }

  if (typeof NativeBrowserWindow.fromWebContents === "function") {
    GatewayBrowserWindow.fromWebContents = (webContents: unknown) => {
      const win = NativeBrowserWindow.fromWebContents(webContents);
      if (win && isOfficialHiddenWebContents(webContents)) {
        (win as { __openclaudeOfficialGatewayRegistered?: boolean }).__openclaudeOfficialGatewayRegistered = true;
      }
      return win;
    };
  }

  Object.setPrototypeOf(GatewayBrowserWindow, NativeBrowserWindow);
  GatewayBrowserWindow.prototype = NativeBrowserWindow.prototype;

  try {
    electron.BrowserWindow = GatewayBrowserWindow;
  } catch (error) {
    diagnosticWarn("claude-bridge", "browser_window_patch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  app.on("browser-window-created", (_event: unknown, win: unknown) => registerOfficialWindow(win));
}

function patchOfficialAppSingleton(): void {
  if ((app as { __openclaudeOfficialGatewaySingletonPatched?: boolean }).__openclaudeOfficialGatewaySingletonPatched) return;
  (app as { __openclaudeOfficialGatewaySingletonPatched?: boolean }).__openclaudeOfficialGatewaySingletonPatched = true;

  const originalRequestSingleInstanceLock = app.requestSingleInstanceLock.bind(app);
  app.requestSingleInstanceLock = (...args: unknown[]) => {
    try {
      originalRequestSingleInstanceLock(...args);
    } catch { /* ignore */ }
    return true;
  };
}

function createOfficialIpcEvent(context: { clientId?: string; ports?: unknown[] } = {}): unknown {
  const sender = officialIpc.hiddenWebContents as { isDestroyed?: () => boolean; mainFrame?: unknown; getOSProcessId?: () => number };
  if (!sender || sender.isDestroyed?.()) {
    throw new Error("Official BrowserWindow is not ready yet");
  }

  return {
    sender,
    senderFrame: sender.mainFrame || null,
    processId: typeof sender.getOSProcessId === "function" ? sender.getOSProcessId() : 0,
    frameId: 0,
    returnValue: undefined,
    reply(channel: string, ...args: unknown[]) {
      routeOfficialWebContentsSend(String(channel), args);
    },
    ports: Array.isArray(context.ports) ? context.ports : [],
  };
}

function normalizeIpcArgs(args: unknown): unknown[] {
  return Array.isArray(args) ? args : [args];
}

async function waitForBridgeReady(timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const sender = officialIpc.hiddenWebContents as { isDestroyed?: () => boolean } | null;
    if (sender && !sender.isDestroyed?.() && (officialIpc.handlers.size > 0 || listenerCount() > 0)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Official IPC bridge was not ready before timeout");
}

export async function invokeClaudeIpc(channel: string, args: unknown[] = [], context: { clientId?: string } = {}): Promise<unknown> {
  await waitForBridgeReady();

  const event = createOfficialIpcEvent(context);
  const invokeArgs = normalizeIpcArgs(args);

  const handler = officialIpc.handlers.get(channel);
  if (handler) {
    return handler(event, ...invokeArgs);
  }

  const listeners = officialIpc.listeners.get(channel);
  if (listeners && listeners.size > 0) {
    for (const listener of [...listeners]) {
      await listener(event, ...invokeArgs);
    }
    const eventWithReturn = event as { returnValue?: unknown };
    return eventWithReturn.returnValue === undefined ? true : eventWithReturn.returnValue;
  }

  diagnosticWarn("claude-bridge", "missing_ipc_handler", {
    channel,
    registeredHandlers: Array.from(officialIpc.handlers.keys()).sort(),
    registeredListeners: Array.from(officialIpc.listeners.keys()).sort(),
  });
  throw new Error(`No official Electron IPC handler for ${channel}`);
}

export function claudeBridgeStatus(): {
  ready: boolean;
  hiddenWebContentsId: number | null;
  handlerCount: number;
  listenerCount: number;
  handlers: string[];
  listeners: string[];
} {
  const sender = officialIpc.hiddenWebContents as { isDestroyed?: () => boolean; id?: number } | null;
  return {
    ready: !!sender && !sender.isDestroyed?.() && officialIpc.handlers.size > 0,
    hiddenWebContentsId: sender?.id ?? null,
    handlerCount: officialIpc.handlers.size,
    listenerCount: listenerCount(),
    handlers: Array.from(officialIpc.handlers.keys()).sort(),
    listeners: Array.from(officialIpc.listeners.keys()).sort(),
  };
}

export function alignClaudeEnvironment(opts: {
  asarPath: string;
  installPath: string;
  userDataDir: string;
}): void {
  const { asarPath, installPath, userDataDir } = opts;

  process.env.NODE_ENV = process.env.NODE_ENV || "production";
  process.env.BUILD_FLAVOR = process.env.BUILD_FLAVOR || "prod";

  try {
    app.setPath("userData", userDataDir);
  } catch (error) {
    diagnosticWarn("claude-bridge", "set_user_data_path_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const resourcesPath = asarPath.replace(/[/\\]app\.asar$/, "");
  try {
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      enumerable: true,
      value: resourcesPath,
    });
  } catch {
    (process as { resourcesPath?: string }).resourcesPath = resourcesPath;
  }

  try {
    app.getAppPath = () => installPath;
  } catch { /* ignore */ }

  try {
    Object.defineProperty(app, "isPackaged", {
      configurable: true,
      get: () => true,
    });
  } catch { /* ignore */ }

  app.setName("Claude");

  diagnosticLog("claude-bridge", "environment_aligned", {
    asarPath,
    installPath,
    userDataDir,
    resourcesPath,
    nodeEnv: process.env.NODE_ENV,
  });
}

export function loadClaudeBootstrap(bootstrapPath: string): void {
  diagnosticLog("claude-bridge", "loading_bootstrap", { bootstrapPath });
  try {
    nodeRequire(bootstrapPath);
    diagnosticLog("claude-bridge", "bootstrap_loaded", { bootstrapPath });
  } catch (error) {
    diagnosticWarn("claude-bridge", "bootstrap_load_failed", {
      bootstrapPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
