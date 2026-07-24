import type { ConnectorStatus, SessionEvent, SessionSummary } from "../../shared/protocol.js";
import type { ClaudeDesktopConnector, ConnectorDiagnostics } from "./claude-desktop-connector.js";
import { diagnosticLog } from "../../gateway/runtime/core/diagnostics.js";

/**
 * Mock 连接器：仅用于本地演示、UI 集成和测试，绝不连接真实 Claude Desktop。
 * 模拟会话列表和流式回复，让前端可以在没有真实连接器时体验完整交互。
 */

export interface MockConnectorOptions {
  status?: ConnectorStatus;
}

interface MockSession {
  id: string;
  title: string;
  updatedAt: string;
  state: SessionSummary["state"];
  messages: { role: "user" | "assistant"; text: string }[];
}

export class MockClaudeDesktopConnector implements ClaudeDesktopConnector {
  readonly name = "claude-desktop-mock";
  readonly status: ConnectorStatus;
  private readonly listeners = new Set<(sessionId: string, event: SessionEvent) => void>();
  private readonly sessions = new Map<string, MockSession>();
  private activeTimers = new Set<NodeJS.Timeout>();

  constructor(options: MockConnectorOptions = {}) {
    this.status = options.status ?? "degraded";
    const now = new Date().toISOString();
    this.sessions.set("mock-1", {
      id: "mock-1",
      title: "Mock session",
      updatedAt: now,
      state: "idle",
      messages: [{ role: "assistant", text: "This is a mock session. The real Claude Desktop connector is not configured." }],
    });
    diagnosticLog("connector", "mock_init", { sessions: this.sessions.size, status: this.status });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id, title: s.title, updatedAt: s.updatedAt, state: s.state,
    }));
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId) ?? this.createSession(sessionId);
    session.messages.push({ role: "user", text });
    session.state = "working";

    const reply = `[mock reply] You said: ${text.slice(0, 200)}`;
    const chunks = this.chunkText(reply, 12);
    let delay = 120;
    for (const chunk of chunks) {
      const timer = setTimeout(() => {
        this.emit(sessionId, { kind: "assistant.delta", text: chunk });
      }, delay);
      this.activeTimers.add(timer);
      delay += 160;
    }
    const endTimer = setTimeout(() => {
      this.emit(sessionId, { kind: "assistant.completed", sessionId });
      session.state = "idle";
      session.messages.push({ role: "assistant", text: reply });
      this.activeTimers.delete(endTimer);
    }, delay + 120);
    this.activeTimers.add(endTimer);
  }

  async cancel(sessionId: string): Promise<void> {
    for (const timer of this.activeTimers) clearTimeout(timer);
    this.activeTimers.clear();
    this.emit(sessionId, { kind: "assistant.completed", sessionId });
    const session = this.sessions.get(sessionId);
    if (session) session.state = "idle";
  }

  onEvent(listener: (sessionId: string, event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async diagnostics(): Promise<ConnectorDiagnostics> {
    return {
      status: this.status,
      name: this.name,
      detail: "Mock connector for local demonstration. No real Claude Desktop connection.",
      routes: [],
    };
  }

  async close(): Promise<void> {
    for (const timer of this.activeTimers) clearTimeout(timer);
    this.activeTimers.clear();
    this.listeners.clear();
  }

  private createSession(id: string): MockSession {
    const session: MockSession = {
      id, title: `Session ${id}`, updatedAt: new Date().toISOString(), state: "idle", messages: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  private emit(sessionId: string, event: SessionEvent): void {
    for (const listener of this.listeners) {
      try { listener(sessionId, event); } catch { /* ignore */ }
    }
  }

  private chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    return chunks;
  }
}
