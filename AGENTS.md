# OpenClaude Agent Guidance

- Read `.agent/README.md`, `.agent/architecture.md`, and `docs/PLAN.md` before changing the desktop connector.
- Keep version-specific Claude Desktop behavior behind `src/connector/claude-desktop-connector.ts`.
- Add focused tests for protocol, authentication, and compatibility changes.
- Never commit credentials, tokens, cookies, private conversation content, or copied proprietary Claude binaries.
- Keep loopback as the default network binding and require an explicit authenticated LAN mode.
