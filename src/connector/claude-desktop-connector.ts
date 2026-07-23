import type { ConnectorStatus, SessionEvent, SessionSummary } from "../../shared/protocol.js";

/**
 * Claude Desktop 连接器接口。
 *
 * 这是网关层唯一允许知道 Claude Desktop 适配细节的模块边界（见 AGENTS.md）。
 * 网关只依赖这个接口；具体实现（unavailable / mock / 真实适配）在各自文件里。
 *
 * 真实 Claude Desktop 连接器在云端环境无法验证，因此默认实现是 UnavailableConnector，
 * 它会明确返回 unavailable 状态，绝不伪造"已连接/已同步/可用"。
 */

export interface ConnectorRouteReport {
  /** 连接路线：official-runtime / cowork-svc / mcp-runtime / ui-automation */
  route: string;
  status: ConnectorStatus;
  evidence: string;
  /** 是否需要在本机进一步验证才能确认 */
  needsOnHostVerification: boolean;
}

export interface ConnectorDiagnostics {
  status: ConnectorStatus;
  name: string;
  detail: string;
  routes: ConnectorRouteReport[];
  desktop?: DesktopScanResult;
}

export interface ClaudeDesktopConnector {
  readonly name: string;
  readonly status: ConnectorStatus;
  listSessions(): Promise<SessionSummary[]>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void;
  diagnostics(): Promise<ConnectorDiagnostics>;
  close(): Promise<void>;
}

/**
 * Windows AppX 安装扫描结果。所有字段都可由 fixture 注入，便于在 Linux CI 上测试。
 */
export interface DesktopScanResult {
  found: boolean;
  installPath: string;
  source: string;
  packageName: string;
  packageVersion: string;
  electronVersion: string;
  mainEntry: string;
  components: {
    appAsar: boolean;
    coworkSvc: boolean;
    chromeNativeHost: boolean;
    mcpRuntime: boolean;
    wsDependency: boolean;
  };
  scannedAt: string;
  notes: string[];
}
