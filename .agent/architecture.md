# Architecture Notes

OpenClaude has four boundaries:

1. Electron main process: owns the local gateway lifecycle and desktop integration.
2. Gateway: authenticates HTTP/WebSocket clients and translates protocol messages.
3. Claude Desktop connector: the only module allowed to know the desktop adapter details.
4. Renderer/mobile web shell: presents sessions and streams events without Node access.

The initial connector is intentionally unavailable. It prevents the network layer from pretending that Claude Desktop has a stable public remote-control API before that behavior is verified against the installed version.

## OpenCodex Reference Map

- `launcher/` maps to desktop lifecycle, LAN settings, logs, tray, and gateway restart behavior.
- `gateway/` maps to authentication, WebSocket relay, runtime compatibility, and diagnostics.
- `web-shell/` maps to the phone browser experience and mobile-specific behavior.
- `gateway/runtime/ipc/official-runtime.cjs` is a design reference for isolating version-specific desktop hooks, not code to rename mechanically.
