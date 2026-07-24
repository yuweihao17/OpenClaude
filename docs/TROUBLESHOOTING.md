# Troubleshooting

## Build / test issues

### `pnpm install` fails with `ERR_PNPM_OUTDATED_LOCKFILE`

The lockfile is out of sync with `package.json`. Run:

```bash
pnpm install --no-frozen-lockfile
```

Then commit the updated `pnpm-lock.yaml`. In CI, use `pnpm install --frozen-lockfile` once the lockfile is committed.

### `tsc` error `Cannot find type definition file for 'node'`

`node_modules` is missing or `@types/node` is not installed. Run `pnpm install`.

### Tests fail with `ReferenceError: __dirname is not defined in ES module scope`

The project is ESM (`"type": "module"`). Any code using `__dirname` must use `path.dirname(fileURLToPath(import.meta.url))` instead. This is already fixed in `gateway/runtime/core/config.ts`, `src/main/launcher-settings.ts`, and `scripts/*.mjs`.

### Tests fail on Windows with path separator mismatches

Scanner tests use `path.join` (which is platform-aware) and fixture paths built with `path.posix`-compatible joins. The `defaultWindowsCandidates` test asserts on substrings (`AppData`, `Program Files`) rather than exact separators. If you add new path tests, use `path.join` and substring assertions, not hardcoded `\` or `/`.

## Launcher issues

### Launcher starts but the window is blank

The gateway may not be serving the web-shell. Check:

1. `OPENCLAUDE_WEB_SHELL_DIR` points to a directory containing `index.html`, or leave it unset so the launcher uses `<projectRoot>/web-shell` (dev) or `process.resourcesPath/web-shell` (packaged).
2. The gateway log shows `listening` with the correct host/port.
3. `http://127.0.0.1:21300/api/health` returns `{"ok":true,...}`.

### Port already in use

The launcher retries `port+1` once on `EADDRINUSE`. If both fail, it exits with `Gateway failed to listen`. Set `OPENCLAUDE_PORT` to a free port, or stop the process holding 21300.

### Tray icon is missing on Linux

The tray uses a 1x1 PNG data URL. On Linux without a tray/appindicator, tray creation fails silently and the launcher keeps running without a tray. Use `Ctrl+C` in the terminal to stop it.

## LAN access issues

### Phone cannot reach the gateway

1. Confirm `OPENCLAUDE_HOST=0.0.0.0` is set (default is `127.0.0.1`, loopback only).
2. Confirm both devices are on the same network.
3. Check the Windows firewall allows inbound TCP on the gateway port (default 21300) scoped to your subnet. See README for the PowerShell command.
4. Use the LAN URL printed in the startup banner (`[launcher] lan_url`), not `127.0.0.1`.

### Login fails with "Invalid password"

1. If you set `OPENCLAUDE_ACCESS_PASSWORD`, use that exact plaintext value.
2. If a password was auto-generated, it was shown **once** in the desktop setup dialog on first LAN start (never written to logs/URL/config). If you closed it without saving, delete `config.yaml` (under the runtime dir) and restart the launcher in LAN mode to regenerate one — the new plaintext will be shown once again in the dialog.
3. The web-shell hashes the password with SHA-256 before sending `passwordHash` to `/api/auth/login`. Do not paste the hash into the login form; paste the plaintext password.

### Launcher exits with "no desktop window is available to display it"

LAN mode auto-generated a password but could not display it (headless / no window). The plaintext is never logged, so there is no way to recover it from logs. Set `OPENCLAUDE_ACCESS_PASSWORD` explicitly in `.env`, or pre-populate `config.yaml` with a `sha256-v1:` hash, then restart.

### Login fails with "Too many login attempts"

The rate limiter locks after repeated failures. Wait for the backoff (default up to 15 minutes after 10 failures) or restart the gateway to reset the in-memory limiter.

### WebSocket connects but immediately disconnects

The WS upgrade requires authentication (when LAN mode is on) and a valid origin. If the phone browser sends an `Origin` header not in the allowed list, the upgrade is rejected. Loopback requests are always allowed. For LAN, ensure the phone loads the page over the LAN URL so the origin matches.

## Connector issues

### The UI shows "Claude Desktop 连接器未配置"

This is the correct, honest state. The default `UnavailableConnector` reports `unavailable` because no Claude Desktop route has been verified. To check if an install is detected:

```bash
pnpm run probe:claude
```

On Linux/CI this always reports `unavailable` (no Windows install). On Windows it scans default install locations and reports component presence, but the overall status stays `unavailable` unless you run with `OPENCLAUDE_PROBE_ON_HOST=1` and a route is actually verified.

### I want to demo the UI without real Claude Desktop

```bash
OPENCLAUDE_USE_MOCK_CONNECTOR=1 pnpm run dev
```

The mock connector simulates sessions and streaming replies. It never connects to real Claude Desktop and is for local demonstration only.

### How do I verify a connector route?

This requires a Windows host with Claude Desktop installed. Run the on-host probe, then implement a real connector in `src/connector/` following the `ClaudeDesktopConnector` interface. Only mark a route `supported` after confirming a stable protocol on a specific Claude Desktop version. Never fake `supported`.

## Diagnostics

### Collecting sanitized diagnostics

```bash
# Gateway diagnostics (structured, no credentials or session content)
curl http://127.0.0.1:21300/api/diagnostics

# Claude Desktop install probe (Windows)
pnpm run probe:claude > diagnostics.json 2>summary.txt
```

### Where are the logs?

- Dev: `.data/runtime/` and `.data/logs/gateway.log` under the project root.
- Packaged: `<userData>/runtime/` and `<userData>/logs/gateway.log` under the user profile (`%APPDATA%/OpenClaude` on Windows).
- Logs rotate at 5 MiB, keeping one `.old` backup.

Logs never contain passwords (only sha256 hashes), tokens, cookies, or session content. Client identifiers in rate-limit logs are truncated to the first 12 hex chars of a sha256 hash.
