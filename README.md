# OpenClaude

OpenClaude is a personal secondary-development project based on [RyensX/OpenCodex](https://github.com/RyensX/OpenCodex). It explores a Windows-first LAN companion for controlling Claude Desktop from a phone.

The project is early-stage. Its launcher/gateway/web-shell boundaries follow the proven shape of OpenCodex, while the Claude-specific connector remains deliberately unavailable until the installed desktop version and its supported local integration surface are verified.

Current local research baseline: Claude Desktop `1.24012.1` on Windows, Electron `42.7.0`.

## Development

```powershell
pnpm install
pnpm run build
pnpm run lint
pnpm test
```

Keep development on loopback until authentication, LAN firewall scope, and connector capability checks are implemented.

## License

This project remains under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).
