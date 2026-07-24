import type { ConnectorStatus, SessionEvent, SessionSummary } from "../../shared/protocol.js";
import type {
  ClaudeDesktopConnector,
  ConnectorDiagnostics,
  DesktopScanResult,
} from "./claude-desktop-connector.js";
import { scanClaudeDesktop } from "./claude-desktop-scanner.js";
import { probeCapabilities, unavailableDiagnostics } from "./claude-desktop-capabilities.js";
import { diagnosticLog } from "../../gateway/runtime/core/diagnostics.js";

/**
 * 默认连接器：明确报告 Claude Desktop 连接不可用。
 *
 * 云端环境无法验证真实 Claude Desktop 端到端连接，因此默认实现绝不伪造
 * "已连接/已同步/可用"状态。所有会话操作都会向监听器派发 error 事件。
 */
export interface UnavailableConnectorOptions {
  scanResult?: DesktopScanResult;
  allowOnHostProbe?: boolean;
  detail?: string;
  scanOptions?: Parameters<typeof scanClaudeDesktop>[0];
}

export class UnavailableClaudeDesktopConnector implements ClaudeDesktopConnector {
  readonly name = "claude-desktop-unavailable";
  readonly status: ConnectorStatus;
  private readonly listeners = new Set<(sessionId: string, event: SessionEvent) => void>();
  private readonly scan: DesktopScanResult;
  private readonly detailText: string;
  private readonly routeReport: ReturnType<typeof probeCapabilities>;

  constructor(options: UnavailableConnectorOptions = {}) {
    this.scan =
      options.scanResult ??
      scanClaudeDesktop(options.scanOptions ?? { allowLoadAsar: false });
    this.routeReport = probeCapabilities(this.scan, {
      allowOnHostProbe: options.allowOnHostProbe === true,
    });
    this.status = "unavailable";
    this.detailText =
      options.detail ??
      this.routeReport.detail ??
      "Claude Desktop connector is not configured. Run the on-host probe on Windows to verify a route.";
    diagnosticLog("connector", "unavailable_init", {
      found: this.scan.found,
      routes: this.routeReport.routes.length,
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async sendMessage(sessionId: string, _text: string): Promise<void> {
    this.emitError(sessionId, "Claude Desktop connector is unavailable; message not delivered.");
  }

  async cancel(sessionId: string): Promise<void> {
    this.emitError(sessionId, "Claude Desktop connector is unavailable; cancel ignored.");
  }

  onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async diagnostics(): Promise<ConnectorDiagnostics> {
    const status: ConnectorStatus = this.routeReport.status === "supported" ? "supported" : "unavailable";
    if (status === "unavailable") {
      const diag = unavailableDiagnostics(this.name, this.detailText, this.scan);
      return { ...diag, routes: this.routeReport.routes };
    }
    return {
      status,
      name: this.name,
      detail: this.routeReport.detail,
      routes: this.routeReport.routes,
      desktop: this.scan,
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  private emitError(sessionId: string, message: string): void {
    const event: SessionEvent = { kind: "error", message };
    for (const listener of this.listeners) {
      try { listener(sessionId, event); } catch (error) {
        diagnosticLog("connector", "listener_error", { error: String(error) });
      }
    }
  }
}
