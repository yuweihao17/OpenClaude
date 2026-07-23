import { z } from "zod";

/**
 * OpenClaude 客户端/服务端协议。
 *
 * 迁移自 OpenCodex 协议结构，适配 OpenClaude：
 * - 客户端必须先发 hello，服务端回 hello-ack 后才允许业务消息。
 * - 所有请求带 requestId，服务端回复带上同一 requestId。
 * - 消息大小有上限（MAX_WS_MESSAGE_BYTES），超限服务端关闭连接。
 * - 文本输入有上限（MAX_PROMPT_TEXT），防止超大 prompt。
 */

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** 连接器能力状态：绝不伪造，未验证的路线最多 degraded。 */
export type ConnectorStatus = "supported" | "degraded" | "unavailable";

export const MAX_PROMPT_TEXT = 200_000;
export const MAX_WS_MESSAGE_BYTES = 2 * 1024 * 1024;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), requestId: z.string().min(1).optional() }),
  z.object({ type: z.literal("ping"), requestId: z.string().min(1) }),
  z.object({ type: z.literal("session.list"), requestId: z.string().min(1) }),
  z.object({
    type: z.literal("session.send"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    text: z.string().min(1).max(MAX_PROMPT_TEXT),
  }),
  z.object({
    type: z.literal("session.cancel"),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: "hello-ack"; clientId: string; serverVersion: string; connector: ConnectorStatus; connectorName: string }
  | { type: "pong"; requestId: string; serverTime: string }
  | { type: "session.list.result"; requestId: string; sessions: SessionSummary[] }
  | { type: "session.send.accepted"; requestId: string; sessionId: string }
  | { type: "session.cancel.accepted"; requestId: string; sessionId: string }
  | { type: "session.event"; sessionId: string; event: SessionEvent }
  | { type: "error"; requestId?: string; code: string; message: string };

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  state: "idle" | "working" | "error";
}

export type SessionEvent =
  | { kind: "assistant.delta"; text: string }
  | { kind: "assistant.completed"; sessionId?: string }
  | { kind: "tool.started"; name: string }
  | { kind: "tool.completed"; name: string }
  | { kind: "error"; message: string };
