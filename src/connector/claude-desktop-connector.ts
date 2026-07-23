import type { SessionEvent, SessionSummary } from "../shared/protocol.js";

export interface ClaudeDesktopConnector {
  readonly name: string;
  listSessions(): Promise<SessionSummary[]>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void;
  close(): Promise<void>;
}

/**
 * 连接器接口先隔离未知的 Claude Desktop 内部协议，避免把 UI 自动化或私有 IPC 写死在网关层。
 */
export class UnavailableClaudeDesktopConnector implements ClaudeDesktopConnector {
  readonly name = "unavailable";

  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }

  async sendMessage(): Promise<void> {
    throw new Error("Claude Desktop connector is not configured yet");
  }

  async cancel(): Promise<void> {
    throw new Error("Claude Desktop connector is not configured yet");
  }

  onEvent(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    return undefined;
  }
}
