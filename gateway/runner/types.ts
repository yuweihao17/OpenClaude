import type { ConnectorStatus, SessionEvent, SessionSummary } from "../../shared/protocol.js";

export interface ConnectorRouteReport {
  route: string;
  status: ConnectorStatus;
  evidence: string;
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
