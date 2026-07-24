import type { ConnectorStatus } from "../../shared/protocol.js";
import type { ConnectorRouteReport, DesktopScanResult } from "./claude-desktop-connector.js";

/**
 * Claude Desktop 连接路线能力探测。迁移自 OpenCodex capability probe 思路。
 *
 * 按以下顺序评估，每条路线都必须有证据才可标记 supported；否则按 degraded/unavailable 报告。
 * 绝不伪造"已连接/可用"。
 *
 * 1. official-runtime：从已安装 app.asar 拉起隔离的隐藏 Electron runtime，只中继必要 IPC。
 * 2. cowork-svc：cowork-svc.exe 或 chrome-native-host.exe 暴露的本地服务接口（协议未公开）。
 * 3. mcp-runtime：打包的 MCP runtime 或 WebSocket 接口（协议未公开）。
 * 4. ui-automation：Windows UI Automation 兜底，仅作版本受限的回退。
 */

export interface CapabilityProbeOptions {
  allowOnHostProbe?: boolean;
  platform?: string;
  supportedVersions?: string[];
}

const DEFAULT_SUPPORTED_VERSIONS: string[] = [];

function routeStatus(
  _evidence: string,
  opts: { found: boolean; verified: boolean; needsOnHost: boolean },
): { status: ConnectorStatus; needsOnHostVerification: boolean } {
  if (opts.verified) return { status: "supported", needsOnHostVerification: false };
  if (opts.found) return { status: "degraded", needsOnHostVerification: true };
  return { status: "unavailable", needsOnHostVerification: opts.needsOnHost };
}

export function probeCapabilities(scan: DesktopScanResult, options: CapabilityProbeOptions = {}): {
  status: ConnectorStatus;
  detail: string;
  routes: ConnectorRouteReport[];
} {
  const allowOnHost = options.allowOnHostProbe === true;
  const platform = options.platform ?? process.platform;
  const supportedVersions = options.supportedVersions ?? DEFAULT_SUPPORTED_VERSIONS;
  const routes: ConnectorRouteReport[] = [];

  // 1. official-runtime
  {
    const found = scan.found && scan.components.appAsar && Boolean(scan.mainEntry);
    const versionSupported =
      !scan.packageVersion || supportedVersions.length === 0 || supportedVersions.includes(scan.packageVersion);
    const verified = allowOnHost && found && versionSupported && Boolean(scan.electronVersion) && platform === "win32";
    const { status, needsOnHostVerification } = routeStatus(
      `app.asar=${scan.components.appAsar}, main=${scan.mainEntry || "(none)"}, electron=${scan.electronVersion || "(unknown)"}`,
      { found, verified, needsOnHost: true },
    );
    routes.push({
      route: "official-runtime",
      status,
      evidence: found
        ? `Found app.asar with main entry; Electron ${scan.electronVersion || "unknown"}; version ${scan.packageVersion || "unknown"}.`
        : "app.asar or main entry not available.",
      needsOnHostVerification,
    });
  }

  // 2. cowork-svc / native host local service
  {
    const found = scan.found && (scan.components.coworkSvc || scan.components.chromeNativeHost);
    const verified = false;
    const { status, needsOnHostVerification } = routeStatus(
      `cowork-svc=${scan.components.coworkSvc}, chrome-native-host=${scan.components.chromeNativeHost}`,
      { found, verified, needsOnHost: true },
    );
    routes.push({
      route: "cowork-svc",
      status,
      evidence: found
        ? "Local service executable present, but its IPC/HTTP contract is undocumented and unverified."
        : "Local service executables not found.",
      needsOnHostVerification,
    });
  }

  // 3. mcp-runtime
  {
    const found = scan.found && scan.components.mcpRuntime;
    const verified = false;
    const { status, needsOnHostVerification } = routeStatus(
      `mcp-runtime=${scan.components.mcpRuntime}, ws-dep=${scan.components.wsDependency}`,
      { found, verified, needsOnHost: true },
    );
    routes.push({
      route: "mcp-runtime",
      status,
      evidence: found
        ? "MCP runtime directory present; transport (stdio/WebSocket) and protocol are unverified."
        : "MCP runtime not found.",
      needsOnHostVerification,
    });
  }

  // 4. ui-automation fallback (Windows only)
  {
    const found = platform === "win32" && scan.found;
    const verified = false;
    const { status, needsOnHostVerification } = routeStatus(
      `platform=${platform}, install=${scan.found}`,
      { found, verified, needsOnHost: true },
    );
    routes.push({
      route: "ui-automation",
      status,
      evidence: found
        ? "Windows host with Claude Desktop install; UI Automation is a version-gated fallback only."
        : "UI Automation fallback is unavailable on this platform or without an install.",
      needsOnHostVerification,
    });
  }

  const bestRouteStatus = routes.reduce<ConnectorStatus>((acc, route) => {
    if (route.status === "supported") return "supported";
    if (route.status === "degraded" && acc === "unavailable") return "degraded";
    return acc;
  }, "unavailable");

  const overall: ConnectorStatus = allowOnHost ? bestRouteStatus : "unavailable";

  const detail = scan.found
    ? `Claude Desktop ${scan.packageVersion || "(unknown version)"} found at ${scan.installPath}. No connector route is verified${allowOnHost ? "" : " in this environment"}; run the on-host probe to confirm.`
    : "Claude Desktop installation was not found; connector remains unavailable.";

  return { status: overall, detail, routes };
}

export function unavailableDiagnostics(name: string, detail: string, scan?: DesktopScanResult): {
  status: ConnectorStatus;
  name: string;
  detail: string;
  routes: ConnectorRouteReport[];
  desktop?: DesktopScanResult;
} {
  return { status: "unavailable", name, detail, routes: [], desktop: scan };
}
