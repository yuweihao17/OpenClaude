import type { ConnectorStatus, SessionEvent, SessionSummary } from "../../../shared/protocol.js";
import type { ClaudeDesktopConnector, ConnectorDiagnostics } from "../../runner/types.js";
import { claudeBridgeStatus, invokeClaudeIpc } from "./claude-bridge.js";
import { diagnosticLog } from "../core/diagnostics.js";

export class IpcBridgeConnector implements ClaudeDesktopConnector {
  readonly name = "claude-desktop-ipc-bridge";
  private readonly listeners = new Set<(sessionId: string, event: SessionEvent) => void>();

  get status(): ConnectorStatus {
    const bridgeStatus = claudeBridgeStatus();
    return bridgeStatus.ready ? "degraded" : "unavailable";
  }

  async listSessions(): Promise<SessionSummary[]> {
    throw new Error("listSessions not implemented: Claude Desktop IPC channels are unknown");
  }

  async sendMessage(_sessionId: string, _text: string): Promise<void> {
    throw new Error("sendMessage not implemented: Claude Desktop IPC channels are unknown");
  }

  async cancel(_sessionId: string): Promise<void> {
    throw new Error("cancel not implemented: Claude Desktop IPC channels are unknown");
  }

  onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async diagnostics(): Promise<ConnectorDiagnostics> {
    const bridgeStatus = claudeBridgeStatus();
    const status: ConnectorStatus = bridgeStatus.ready ? "degraded" : "unavailable";

    return {
      status,
      name: this.name,
      detail: bridgeStatus.ready
        ? `IPC bridge is ready with ${bridgeStatus.handlerCount} handlers. Claude Desktop IPC channels are not yet mapped to OpenClaude protocol.`
        : "IPC bridge is not ready. Waiting for Claude Desktop to register IPC handlers.",
      routes: [
        {
          route: "ipc-bridge",
          status,
          evidence: bridgeStatus.ready
            ? `Bridge ready: ${bridgeStatus.handlerCount} handlers, ${bridgeStatus.listenerCount} listeners`
            : "Bridge not ready",
          needsOnHostVerification: false,
        },
      ],
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    diagnosticLog("ipc-bridge-connector", "closed", {});
  }

  emitEvent(sessionId: string, event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, event);
      } catch (error) {
        diagnosticLog("ipc-bridge-connector", "listener_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async invokeIpc(channel: string, args: unknown[] = [], context: { clientId?: string } = {}): Promise<unknown> {
    return invokeClaudeIpc(channel, args, context);
  }
}
