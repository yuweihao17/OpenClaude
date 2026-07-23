# OpenClaude Development Plan

## Goal

Build a Windows-first companion that lets a phone on the same LAN inspect and operate work running in Claude Desktop, while keeping the desktop integration isolated, authenticated, observable, and reversible.

## Current Baseline

- Target desktop: Claude Desktop `1.24012.1.0` (Windows AppX)
- Verified runtime (local research): Electron `42.7.0`, package `@ant/desktop` `1.24012.1`, entry `.vite/build/index.pre.js`
- Relevant packaged components: `app.asar`, `cowork-svc.exe`, `chrome-native-host.exe`, MCP runtime, and `ws`
- Shell: Electron + TypeScript (gateway-served web-shell, no separate renderer build)
- Transport: authenticated HTTP for health/configuration and authenticated WebSocket for session events
- Default binding: loopback only; LAN mode must be an explicit setting
- Connector: unavailable placeholder until the installed Claude Desktop behavior is verified

## Implementation Status

### Completed (cloud-verified on Linux CI)

- **M0 Repository and shell**: Electron main/preload split, gateway-served web-shell, TypeScript composite project, strict mode. Smoke + auth tests in place.
- **M1 Gateway contract**: Versioned client/server messages in `shared/protocol.ts` with hello/hello-ack handshake, request IDs, structured errors, heartbeats, bounded message sizes. Password hashing (sha256-v1) in `config.yaml`, in-memory tokens, LAN binding, origin checks, login rate limits, explicit shutdown/restart path.
- **M2 Claude Desktop discovery**: Scanner records installed version, AppX layout, Electron/runtime files, and component presence. Capability probe reports `supported` / `degraded` / `unavailable` over 4 routes and fails closed (overall `unavailable`) when no route is verified. Connector framework (`UnavailableConnector`, `MockConnector`) never fakes success.
- **M4 Mobile workflow**: Responsive web-shell with login, session list, message stream, composer, reconnect state, and clear error/unsupported states. PWA manifest included. The UI shows real connector status and never displays fake "connected".
- **M5 Packaging and operations**: `electron-builder` config for Windows portable target, `sync:version` and `probe:claude` scripts, `.env.example`, firewall documentation in README, structured logs with rotation, diagnostics export excluding message content.

### Not yet implemented

- **M3 Session control**: Real Claude Desktop session operations (list, read history, send, cancel, stream). The connector interface exists but the real adapter is not implemented because no route is verified.
- **M2 connector routes**: All 4 routes (official-runtime / cowork-svc / mcp-runtime / ui-automation) remain unverified. None can be marked `supported` until the on-host probe confirms a stable protocol on a specific Claude Desktop version.

### Must be verified on a Windows host

- Real Claude Desktop install scan via `pnpm run probe:claude`.
- Electron launcher starting and serving the web-shell on loopback.
- LAN mode end-to-end: password generation, phone login, WebSocket auth.
- Windows packaging via `pnpm run pack:win`.
- Each connector route against Claude Desktop `1.24012.1`.

## Milestones

### M0: Repository and shell — DONE

- Electron main/preload split with gateway-served web-shell.
- TypeScript composite project, strict mode.
- Smoke test for gateway health and an authentication test.

### M1: Gateway contract — DONE

- Versioned client/server messages in `shared/protocol.ts`.
- Request IDs, structured errors, connection heartbeats, and bounded message sizes.
- Password hashing in `config.yaml`; never put a password in a URL or source file.
- LAN binding, CORS/origin checks, rate limits, and an explicit shutdown/restart path.

### M2: Claude Desktop discovery — PARTIAL

- Scanner records the installed Claude Desktop version, AppX layout, Electron/runtime files, and component presence.
- Capability probe reports `supported` / `degraded` / `unavailable` and fails closed.
- **Remaining**: verify at least one route on a real Windows install.

#### Connector route decision

Evaluate these routes in order and record evidence for each tested Claude Desktop version:

1. **official-runtime**: launch an isolated hidden runtime from the installed `app.asar`, similar to OpenCodex's official runtime runner, then relay only the required IPC events.
2. **cowork-svc**: determine whether `cowork-svc.exe`, the native host, or the packaged MCP runtime exposes a supported authenticated local contract that can be reused without extracting credentials.
3. **mcp-runtime**: packaged MCP runtime or WebSocket interface (protocol unverified).
4. **ui-automation**: Windows UI Automation only as a version-gated fallback for visible controls and never as the sole source of persisted session state.

The connector must not redistribute proprietary Claude files. Runtime files may only be read from the user's installed package on the same machine.

### M3: Session control — NOT STARTED

- Implement list sessions, read message history, send prompt, cancel generation, and stream assistant/tool events.
- Correlate desktop events to phone clients by session ID.
- Persist only non-secret metadata needed for reconnect and resume.
- Add cancellation and reconnect tests.

Blocked on M2 route verification.

### M4: Mobile workflow — DONE

- Responsive session list, message stream, composer, reconnect state, and clear error states.
- Real connection/connector status display; never fakes success.
- PWA manifest and offline error page.

### M5: Packaging and operations — DONE

- Windows packaging config and startup options.
- Firewall rules scoped to the active LAN subnet (documented in README).
- Structured logs with secrets redacted and a diagnostics export that excludes message content by default.
- Log rotation at 5 MiB.

## Non-goals

- No public Internet exposure by default.
- No extraction or redistribution of Claude Desktop proprietary binaries.
- No credential scraping, token reuse, or security bypass.
- No assumption that a private IPC schema remains stable across desktop updates.

## Definition of Done for the First Usable Release

- A fresh Windows install can start in loopback mode without credentials in source control.
- A user can explicitly enable LAN mode and authenticate from a same-network phone.
- A supported Claude Desktop version can list sessions, send a prompt, stream a response, and cancel it.
- Unsupported desktop versions show a clear compatibility message.
- Focused tests cover authentication, protocol validation, reconnects, and connector capability checks.

## Risks and Mitigations

- Desktop updates can break private IPC: pin compatibility by Claude version and fail closed.
- Running a second Electron runtime can conflict with the official profile: use isolated user-data and temp directories.
- UI Automation can send input to the wrong window: require foreground/window identity checks and confirmation for destructive actions.
- LAN exposure can leak conversations or tools: bind to loopback by default, require authentication, rate-limit login, and scope firewall rules to the active subnet.
- Third-party API configurations may differ from official accounts: reuse the existing desktop profile only through supported runtime behavior; never copy credentials into OpenClaude configuration.
