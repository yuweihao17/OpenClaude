import { Tray, Menu, nativeImage, type BrowserWindow } from "electron";

/**
 * 系统托盘。迁移自 OpenCodex launcher tray。
 * 提供：打开窗口、显示状态、重启网关、退出。创建失败时静默跳过。
 */

export interface TrayController {
  setStatus(label: string): void;
  destroy(): void;
}

export function createTray(options: {
  window: BrowserWindow;
  onRestart: () => void;
  onQuit: () => void;
  initialStatus?: string;
}): TrayController | null {
  let tray: Tray | null = null;
  try {
    const icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    );
    tray = new Tray(icon);
  } catch {
    return null;
  }
  if (!tray) return null;

  let status = options.initialStatus || "running";
  const buildMenu = () =>
    Menu.buildFromTemplate([
      { label: `OpenClaude — ${status}`, enabled: false },
      { type: "separator" },
      { label: "Open window", click: () => { options.window.show(); } },
      { label: "Restart gateway", click: () => options.onRestart() },
      { type: "separator" },
      { label: "Quit", click: () => options.onQuit() },
    ]);

  tray.setToolTip("OpenClaude");
  tray.setContextMenu(buildMenu());
  tray.on("click", () => { options.window.show(); });

  return {
    setStatus(label: string) {
      status = label;
      try { tray?.setContextMenu(buildMenu()); tray?.setToolTip(`OpenClaude — ${label}`); } catch { /* ignore */ }
    },
    destroy() {
      try { tray?.destroy(); } catch { /* ignore */ }
      tray = null;
    },
  };
}
