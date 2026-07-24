# Architecture Notes

OpenClaude has four boundaries:

1. **Electron main process** (`src/main/`): owns the local gateway lifecycle and desktop integration. Resolves launcher settings (loopback / LAN, port, log dir, web-shell dir), creates the connector, starts the gateway, opens the desktop window, and manages the tray. Captures stdout/stderr into a bounded, rotating log file when packaged.
2. **Gateway** (`gateway/runtime/`): authenticates HTTP/WebSocket clients and translates protocol messages. Serves the static web-shell, exposes `/api/health`, `/api/auth/*`, `/api/status`, `/api/diagnostics`, and relays WebSocket session events. Default loopback; LAN mode requires authentication.
3. **Claude Desktop connector** (`src/connector/`): the only module allowed to know the desktop adapter details. The default implementation (`UnavailableConnector`) truthfully reports `unavailable` and emits error events for all session operations. The `MockConnector` simulates sessions for local demos. A real adapter is not implemented until a route is verified on a Windows host.
4. **Web-shell** (`web-shell/`): vanilla HTML/CSS/JS mobile-first UI served by the gateway. Presents sessions, streams events, and shows real connection/connector status without Node access. Never fakes "connected" or "available".

The initial connector is intentionally unavailable. It prevents the network layer from pretending that Claude Desktop has a stable public remote-control API before that behavior is verified against the installed version.

## OpenCodex Reference Map

- `launcher/` maps to `src/main/` (desktop lifecycle, LAN settings, logs, tray, gateway restart behavior).
- `gateway/` maps to `gateway/runtime/` (authentication, WebSocket relay, runtime compatibility, diagnostics).
- `web-shell/` maps to `web-shell/` (phone browser experience and mobile-specific behavior).
- `gateway/runtime/ipc/official-runtime.cjs` is a design reference for isolating version-specific desktop hooks, not code to rename mechanically. OpenClaude's equivalent would live in a future `src/connector/official-runtime-connector.ts` once a route is verified.

## Key invariants

- **No fake state**: the connector status is `unavailable` by default and only upgrades to `degraded`/`supported` with real evidence. The web-shell reflects this verbatim.
- **Loopback by default**: `OPENCLAUDE_HOST` defaults to `127.0.0.1`. LAN mode (`0.0.0.0`) requires authentication; the launcher auto-generates a password and stores its sha256 hash in `config.yaml`.
- **Credentials never in source**: passwords live in `config.yaml` (gitignored) as `sha256-v1:` hashes. Tokens are in-memory only and invalidated on gateway restart.
- **No proprietary redistribution**: the scanner only reads `app.asar` package.json metadata from the user's installed package; it never copies binaries or reads session/credential data.
