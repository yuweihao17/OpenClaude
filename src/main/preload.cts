import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("openclaude", {
  version: "0.1.0",
});
