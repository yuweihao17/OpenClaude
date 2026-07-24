import { contextBridge, ipcRenderer } from "electron";

// Desktop window only; phone browsers have no preload, so these APIs are local-only by design.
// initialPassword is the one-shot display channel for LAN auto-generated passwords:
// the main process sends it once then clears it, never writes to logs/URL/config.
contextBridge.exposeInMainWorld("openclaude", {
  version: "0.2.0",
  onInitialPassword: (callback: (password: string) => void) => {
    if (typeof callback !== "function") return;
    const handler = (_event: unknown, password: string): void => {
      try { callback(String(password || "")); } catch { /* ignore */ }
    };
    ipcRenderer.on("openclaude:initial-password", handler);
  },
});
