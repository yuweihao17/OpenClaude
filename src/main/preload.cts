import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("openclaude", {
  version: "0.2.0",
});
