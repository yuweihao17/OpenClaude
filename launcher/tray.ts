import { Tray, Menu, nativeImage, type BrowserWindow } from "electron";

export interface TrayController {
  setStatus(label: string): void;
  destroy(): void;
}

export function createTray(options: {
  window: BrowserWindow;
  iconPath: string;
  onRestart: () => void;
  onQuit: () => void;
  initialStatus?: string;
}): TrayController | null {
  let tray: Tray | null = null;
  try {
    const icon = nativeImage.createFromPath(options.iconPath);
    if (icon.isEmpty()) return null;
    tray = new Tray(icon.resize({ width: 32, height: 32, quality: "best" }));
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
