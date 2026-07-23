# OpenClaude Agent Notes

This directory contains project-local agent guidance and implementation notes.

## Working Rules

- Keep Claude Desktop integration behind `src/connector/claude-desktop-connector.ts`.
- Do not read, print, commit, or transmit API keys, access passwords, cookies, or session tokens.
- Keep LAN access authenticated and disabled by default in development.
- Validate every protocol change with a focused test before changing the desktop adapter.
- Treat undocumented Claude Desktop IPC/UI behavior as version-specific and reversible.
