# OpenClaude

OpenClaude is a personal secondary-development project based on [RyensX/OpenCodex](https://github.com/RyensX/OpenCodex). It explores a Windows-first LAN companion for controlling Claude Desktop from a phone.

The launcher/gateway/web-shell boundaries follow the proven shape of OpenCodex, while the Claude-specific connector remains deliberately **unavailable** until the installed desktop version and its supported local integration surface are verified on a Windows host. The UI never fakes "connected" or "available" states.

Current local research baseline: Claude Desktop `1.24012.1` on Windows, Electron `42.7.0`.

## Status

### What is implemented and cloud-verified

- Electron launcher with tray, bounded log capture, and graceful shutdown.
- Gateway runtime: HTTP `/api/health`, `/api/auth/*`, `/api/status`, `/api/diagnostics`, static web-shell serving, and WebSocket `/ws` relay.
- Security model: default loopback binding, authenticated LAN mode with sha256-hashed password in `config.yaml`, in-memory access tokens, login rate limiting, origin checks, request body limits, WS message size limits, heartbeat/timeout.
- Claude Desktop adapter framework: Windows AppX scanner (path + asar + version + component detection), capability probe over 4 routes, `UnavailableConnector` (default, truthfully reports unavailable), `MockConnector` (local demo only).
- Mobile-first web-shell: login, session list, message stream, composer, real connection/connector status, PWA manifest.
- 31 tests pass on Linux CI (protocol, auth rate-limit, http-utils, loopback, gateway lifecycle, scanner, capabilities). Scanner tests use path fixtures that stay Windows-compatible.
- Dev scripts: `sync:version`, `probe:claude`.

### What must be verified on a Windows host

- Real Claude Desktop install scan (`pnpm run probe:claude` on Windows).
- Electron launcher actually starting and serving the web-shell on loopback.
- LAN mode: password generation, phone login, WebSocket auth over LAN.
- Windows packaging (`pnpm run pack:win`).
- None of the 4 connector routes (official-runtime / cowork-svc / mcp-runtime / ui-automation) are verified yet.

### Supported Claude Desktop versions

**None verified.** The connector reports `unavailable` by default. The scanner can detect an install and report `degraded` for routes where components exist, but no route is marked `supported` until the on-host probe confirms a stable protocol on a specific Claude Desktop version.

## Development

Requirements: Node.js 22+, pnpm 10+.

```bash
pnpm install
pnpm run build        # tsc -b
pnpm run lint         # tsc --noEmit
pnpm test             # node --test test/*.test.mjs
```

### Run the launcher (dev)

```bash
pnpm run dev          # builds then launches electron on loopback
```

The launcher opens a desktop window and serves the web-shell at `http://127.0.0.1:21300/`.

### Mock connector (local demo)

```bash
OPENCLAUDE_USE_MOCK_CONNECTOR=1 pnpm run dev
```

The mock connector simulates sessions and streaming replies without touching real Claude Desktop.

### Probe Claude Desktop (Windows only)

```bash
pnpm run probe:claude
# or with on-host route evaluation:
OPENCLAUDE_PROBE_ON_HOST=1 pnpm run probe:claude
```

Outputs sanitized JSON diagnostics to stdout and a human-readable summary to stderr. Never reads cookies, tokens, API keys, or session content.

## Enabling LAN access

LAN mode is **off by default**. The gateway binds to `127.0.0.1` only.

To enable LAN access from a phone on the same network:

1. Set `OPENCLAUDE_HOST=0.0.0.0` (or set it in `.env`).
2. Start the launcher. On first LAN start it auto-generates a random password, writes its sha256 hash to `config.yaml`, and logs the plaintext password **once** to the local gateway log (visible only on the host machine).
3. Note the LAN URL and password from the startup banner / log.
4. Open the LAN URL on your phone and log in with the password.

LAN mode **requires** authentication; the launcher refuses to serve unauthenticated LAN traffic.

### Windows firewall

When LAN mode is enabled, allow inbound TCP on the gateway port (default `21300`) scoped to your active LAN subnet. Example with PowerShell (run as Administrator):

```powershell
New-NetFirewallRule -DisplayName "OpenClaude Gateway" -Direction Inbound -Protocol TCP -LocalPort 21300 -RemoteAddress 192.168.1.0/24 -Action Allow
```

Replace `192.168.1.0/24` with your actual subnet. Do **not** open the port to `Any`.

## Stopping the service

- Desktop window close button hides the window; the gateway keeps running in the system tray.
- Tray menu → **Quit** stops the gateway and exits.
- `Ctrl+C` in the terminal (dev mode) stops the launcher.

## Collecting sanitized diagnostics

```bash
# Gateway diagnostics (structured, no credentials or session content)
curl http://127.0.0.1:21300/api/diagnostics

# Claude Desktop install probe
pnpm run probe:claude > diagnostics.json 2>summary.txt
```

Logs live under `<userData>/logs/gateway.log` (packaged) or `.data/` (dev). The log rotates at 5 MiB, keeping one `.old` backup.

## Configuration

Environment variables are documented in [`.env.example`](./.env.example). Copy it to `.env` and edit as needed. Never commit `.env`.

Access passwords live in `config.yaml` (under the runtime dir) as `sha256-v1:` prefixed hashes, **not** in environment variables. The launcher auto-generates one for LAN mode.

## Project layout

```
gateway/runtime/    Gateway HTTP + WebSocket runtime, auth, static server, config
src/connector/      Claude Desktop adapter framework (scanner, capabilities, connectors)
src/main/           Electron launcher (lifecycle, tray, log capture)
shared/             Protocol schema and version constants
web-shell/          Mobile-first web UI (HTML/CSS/JS), served by the gateway
test/               Focused tests (31 tests, Windows-compatible)
scripts/            sync-version and probe-claude-desktop
```

## License

This project remains under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE). It is derived from [RyensX/OpenCodex](https://github.com/RyensX/OpenCodex); see [NOTICE.md](./NOTICE.md).
