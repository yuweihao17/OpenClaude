# OpenClaude Development Plan

## Goal

Build a Windows-first companion that lets a phone on the same LAN inspect and operate work running in Claude Desktop, while keeping the desktop integration isolated, authenticated, observable, and reversible.

## Current Baseline

- Project directory: `D:\Projects\Openclaude`
- Target desktop: Claude Desktop `1.24012.1.0` (Windows AppX)
- Verified runtime: Electron `42.7.0`, package `@ant/desktop` `1.24012.1`, entry `.vite/build/index.pre.js`
- Relevant packaged components: `app.asar`, `cowork-svc.exe`, `chrome-native-host.exe`, MCP runtime, and `ws`
- Proposed shell: Electron + React + TypeScript
- Transport: authenticated HTTP for health/configuration and authenticated WebSocket for session events
- Default binding: loopback only; LAN mode must be an explicit setting
- Connector: unavailable placeholder until the installed Claude Desktop behavior is verified

## Milestones

### M0: Repository and shell

- Keep the Electron main/preload/renderer split.
- Build the renderer with Vite and React.
- Keep TypeScript project references and strict mode enabled.
- Add a smoke test for gateway health and an authentication test.

### M1: Gateway contract

- Define versioned client/server messages in `src/shared/protocol.ts`.
- Add request IDs, structured errors, connection heartbeats, and bounded message sizes.
- Add password hashing or a securely stored secret; never put a password in a URL or source file.
- Add LAN binding, CORS/origin checks, rate limits, and an explicit shutdown path.

### M2: Claude Desktop discovery

- Record the installed Claude Desktop version, AppX layout, Electron/runtime files, and available local IPC/UI surfaces.
- Prefer a documented or stable local interface. Do not depend on private tokens or bypass account security.
- If UI automation is required, isolate it behind the connector and gate it by an exact tested version.
- Add a capability probe that reports `unsupported`, `available`, or `degraded` rather than silently failing.

#### Connector route decision

Evaluate these routes in order and record evidence for each tested Claude Desktop version:

1. Official runtime route: launch an isolated hidden runtime from the installed `app.asar`, similar to OpenCodex's official runtime runner, then relay only the required IPC events.
2. Local service route: determine whether `cowork-svc.exe`, the native host, or the packaged MCP runtime exposes a supported authenticated local contract that can be reused without extracting credentials.
3. Accessibility route: use Windows UI Automation only as a version-gated fallback for visible controls and never as the sole source of persisted session state.

The connector must not redistribute proprietary Claude files. Runtime files may only be read from the user's installed package on the same machine.

### M3: Session control

- Implement list sessions, read message history, send prompt, cancel generation, and stream assistant/tool events.
- Correlate desktop events to phone clients by session ID.
- Persist only non-secret metadata needed for reconnect and resume.
- Add cancellation and reconnect tests.

### M4: Mobile workflow

- Add a responsive session list, message stream, composer, reconnect state, and clear error states.
- Support a QR code or one-time pairing flow without embedding the long-lived password in the QR payload.
- Keep file upload/download scoped to an explicitly selected workspace.

### M5: Packaging and operations

- Add Windows packaging and startup options.
- Document firewall rules scoped to the active LAN subnet.
- Add structured logs with secrets redacted and a diagnostics export that excludes message content by default.
- Verify upgrade behavior and connector compatibility after each Claude Desktop update.

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
