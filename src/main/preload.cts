import { contextBridge, ipcRenderer } from "electron";

// 仅桌面端窗口可用；手机端浏览器没有 preload，因此这些 API 天然只在本机生效。
// initialPassword 是 LAN 首次自动生成密码的「一次性」展示通道：主进程发送一次后即清空，
// 不写日志/URL/配置。回调收到字符串后由 UI 自行渲染并提示用户保存。
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
