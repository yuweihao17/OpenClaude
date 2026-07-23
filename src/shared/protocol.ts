import { z } from "zod";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.list"), requestId: z.string().min(1) }),
  z.object({ type: z.literal("session.send"), requestId: z.string().min(1), text: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal("session.cancel"), requestId: z.string().min(1) }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: "hello"; serverVersion: string; connector: string }
  | { type: "session.list.result"; requestId: string; sessions: SessionSummary[] }
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
  | { kind: "assistant.completed" }
  | { kind: "tool.started"; name: string }
  | { kind: "tool.completed"; name: string };
