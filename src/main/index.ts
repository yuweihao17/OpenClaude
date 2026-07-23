import { app, BrowserWindow } from "electron";
import path from "node:path";
import { UnavailableClaudeDesktopConnector } from "../connector/claude-desktop-connector.js";
import { createGateway } from "./server.js";

const connector = new UnavailableClaudeDesktopConnector();
const gateway = createGateway({
  host: process.env.OPENCLAUDE_HOST || "127.0.0.1",
  port: Number(process.env.OPENCLAUDE_PORT || 21300),
  accessPassword: process.env.OPENCLAUDE_ACCESS_PASSWORD || "change-me",
  connector,
});

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await gateway.listen();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void gateway.close();
  void connector.close();
});
