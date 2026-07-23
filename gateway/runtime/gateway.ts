import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { ClaudeDesktopConnector } from "../../src/connector/claude-desktop-connector.js";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { clientMessageSchema, MAX_WS_MESSAGE_BYTES } from "../../shared/protocol.js";
import { OPENCLAUDE_VERSION_LABEL } from "../../shared/app-version.js";
import { HOST, PORT, MAX_REQUEST_BODY_BYTES } from "./core/config.js";
import {
  diagnosticLog,
  diagnosticWarn,
  diagnosticError,
  shortId,
} from "./core/diagnostics.js";
import { isLoopbackHostHeader } from "./core/loopback-host.js";
import { headerValue, sendJson, safeParseUrl, type Headers } from "./http/http-utils.js";
import { createAuthService, type AuthService } from "./http/auth.js";
import { createStaticServer } from "./http/static-server.js";

/**
 * OpenClaude Gateway 运行时。迁移自 OpenCodex gateway 结构。
 * - HTTP：/api/health、/api/auth/*、静态 web-shell、/api/status、/api/diagnostics。
 * - WebSocket：/ws，鉴权后中继客户端 <-> 连接器协议消息。
 * - 安全：默认 loopback；LAN 模式由 launcher 通过 host=0.0.0.0 + 密码显式开启。
 * - 鉴权：访问密码 hash 化、token 仅内存、登录限速、cookie/Authorization 双通道。
 * - 心跳：服务端定期 ping，超时断开；客户端 hello 后才能发业务消息。
 * - 消息上限：单条 WS 消息字节上限 MAX_WS_MESSAGE_BYTES，超限断开。
 */

export interface GatewayOptions {
  host?: string;
  port?: number;
  connector: ClaudeDesktopConnector;
  authService?: AuthService;
  webShellDir?: string;
  allowedOrigins?: string[];
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface GatewayHandle {
  readonly host: string;
  readonly port: number;
  readonly authRequired: boolean;
  listen(): Promise<void>;
  close(): Promise<void>;
  restart(): Promise<void>;
  broadcastConnectorStatus(): Promise<void>;
}

interface ClientSession {
  ws: WebSocket;
  clientId: string;
  helloAck: boolean;
  isAlive: boolean;
}

const HEARTBEAT_INTERVAL_MS = 25_000;

function isLoopbackRequest(req: IncomingMessage): boolean {
  return isLoopbackHostHeader(String(headerValue(req.headers as Headers, "host") || ""));
}

function originFromRequest(req: IncomingMessage): string {
  return String(headerValue(req.headers as Headers, "origin") || "").trim();
}

function isOriginAllowed(req: IncomingMessage, allowedOrigins: string[], authRequired: boolean): boolean {
  const origin = originFromRequest(req);
  if (isLoopbackRequest(req)) return true;
  if (!origin) return authRequired;
  return allowedOrigins.some((allowed) => allowed === origin);
}

function generateClientId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function createGateway(options: GatewayOptions): GatewayHandle {
  const host = options.host ?? HOST;
  const port = options.port ?? PORT;
  const connector = options.connector;
  const auth = options.authService ?? createAuthService();
  const staticServer = createStaticServer({ rootDir: options.webShellDir ?? "" });
  const allowedOrigins = options.allowedOrigins ?? [];

  let httpServer: Server | null = null;
  let wsServer: WebSocketServer | null = null;
  const clients = new Map<WebSocket, ClientSession>();
  let heartbeatTicker: NodeJS.Timeout | null = null;
  // 连接器事件监听器在整个 gateway 生命周期内常驻；close() 清空 clients 后广播变 no-op，
  // restart() 后新客户端自动被现有监听器覆盖。最终销毁由 connector.close() 清理。
  const removeConnectorListener = connector.onEvent((sessionId, event) => {
    broadcast({ type: "session.event", sessionId, event });
  });

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const session of clients.values()) {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(payload, (error) => {
          if (error) diagnosticWarn("ws", "send_failed", { clientId: shortId(session.clientId), error: String(error) });
        });
      }
    }
  }

  function sendError(ws: WebSocket, code: string, message: string, requestId?: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const msg: ServerMessage = { type: "error", code, message, ...(requestId ? { requestId } : {}) };
    ws.send(JSON.stringify(msg));
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = safeParseUrl(req.url || "/");
    if (!url) { sendJson(res, 400, { ok: false, error: "bad_request" }); return; }
    const pathname = url.pathname;

    if (pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        version: OPENCLAUDE_VERSION_LABEL,
        connector: { name: connector.name, status: connector.status },
        authRequired: auth.authRequired,
        host, port,
      }, { "cache-control": "no-store" });
      return;
    }

    if (pathname === "/api/auth/login" && req.method === "POST") { void auth.handleAuthLogin(req, res); return; }
    if (pathname === "/api/auth/status" && req.method === "GET") { auth.handleAuthStatus(req, res, url); return; }
    if (pathname === "/api/auth/logout" && req.method === "POST") { auth.handleAuthLogout(req, res, url); return; }

    if (pathname.startsWith("/api/")) {
      if (auth.authRequired && !auth.isAuthed(req, url)) { auth.sendUnauthorized(res); return; }
      if (pathname === "/api/status" && req.method === "GET") { void handleStatus(req, res); return; }
      if (pathname === "/api/diagnostics" && req.method === "GET") { void handleDiagnostics(req, res); return; }
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    if (staticServer.serve(req, res, pathname)) return;
    staticServer.serveNotFound(res);
  }

  async function handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const diag = await connector.diagnostics();
      sendJson(res, 200, {
        ok: true,
        version: OPENCLAUDE_VERSION_LABEL,
        connector: { name: diag.name, status: diag.status, detail: diag.detail, routes: diag.routes },
        authRequired: auth.authRequired,
        host, port,
        loopback: host === "127.0.0.1" || host === "localhost",
      }, { "cache-control": "no-store" });
    } catch (error) {
      diagnosticError("gateway", "status_failed", { error: String(error) });
      sendJson(res, 500, { ok: false, error: "status_failed" });
    }
  }

  async function handleDiagnostics(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const diag = await connector.diagnostics();
      sendJson(res, 200, {
        ok: true,
        version: OPENCLAUDE_VERSION_LABEL,
        connector: diag,
        host, port,
        loopback: host === "127.0.0.1" || host === "localhost",
        clientCount: clients.size,
      }, { "cache-control": "no-store" });
    } catch (error) {
      diagnosticError("gateway", "diagnostics_failed", { error: String(error) });
      sendJson(res, 500, { ok: false, error: "diagnostics_failed" });
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: import("node:net").Socket, head: Buffer): void {
    const url = safeParseUrl(req.url || "/");
    if (!url || url.pathname !== "/ws") { socket.destroy(); return; }
    if (auth.authRequired) {
      const authResult = auth.authResultForRequest(req, url);
      if (!authResult.authenticated) { socket.destroy(); return; }
    }
    if (!isOriginAllowed(req, allowedOrigins, auth.authRequired)) { socket.destroy(); return; }
    if (!wsServer) { socket.destroy(); return; }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer!.emit("connection", ws, req);
    });
  }

  function setupWebSocket(): void {
    wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
    wsServer.on("connection", (ws, req) => {
      const clientId = generateClientId();
      const session: ClientSession = { ws, clientId, helloAck: false, isAlive: true };
      clients.set(ws, session);
      diagnosticLog("ws", "connected", { clientId: shortId(clientId), host: String(headerValue(req.headers as Headers, "host") || "") });

      ws.on("pong", () => { session.isAlive = true; });

      ws.on("message", (raw, isBinary) => {
        if (isBinary) { sendError(ws, "binary_unsupported", "Binary messages are not supported"); return; }
        if (Buffer.byteLength(raw as Buffer) > MAX_WS_MESSAGE_BYTES) {
          ws.close(1009, "message too large");
          return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(raw.toString()); } catch { sendError(ws, "invalid_json", "Message is not valid JSON"); return; }
        const result = clientMessageSchema.safeParse(parsed);
        if (!result.success) { sendError(ws, "invalid_message", result.error.issues[0]?.message || "invalid message"); return; }
        const message = result.data as ClientMessage;
        if (message.type === "hello") {
          session.helloAck = true;
          const ack: ServerMessage = {
            type: "hello-ack",
            clientId: session.clientId,
            serverVersion: OPENCLAUDE_VERSION_LABEL,
            connector: connector.status,
            connectorName: connector.name,
          };
          ws.send(JSON.stringify(ack));
          return;
        }
        if (!session.helloAck) { sendError(ws, "hello_required", "Send hello before any other message", "requestId" in message ? message.requestId : undefined); return; }
        void handleClientMessage(session, message);
      });

      ws.on("close", () => {
        clients.delete(ws);
        diagnosticLog("ws", "disconnected", { clientId: shortId(clientId) });
      });

      ws.on("error", (error) => {
        diagnosticWarn("ws", "client_error", { clientId: shortId(clientId), error: String(error) });
        clients.delete(ws);
      });
    });
  }

  async function handleClientMessage(session: ClientSession, message: ClientMessage): Promise<void> {
    const { ws } = session;
    try {
      if (message.type === "ping") {
        const pong: ServerMessage = { type: "pong", requestId: message.requestId, serverTime: new Date().toISOString() };
        ws.send(JSON.stringify(pong));
        return;
      }
      if (message.type === "session.list") {
        const sessions = await connector.listSessions();
        const reply: ServerMessage = { type: "session.list.result", requestId: message.requestId, sessions };
        ws.send(JSON.stringify(reply));
        return;
      }
      if (message.type === "session.send") {
        await connector.sendMessage(message.sessionId, message.text);
        const reply: ServerMessage = { type: "session.send.accepted", requestId: message.requestId, sessionId: message.sessionId };
        ws.send(JSON.stringify(reply));
        return;
      }
      if (message.type === "session.cancel") {
        await connector.cancel(message.sessionId);
        const reply: ServerMessage = { type: "session.cancel.accepted", requestId: message.requestId, sessionId: message.sessionId };
        ws.send(JSON.stringify(reply));
        return;
      }
    } catch (error) {
      const code = "request_failed";
      const msg = error instanceof Error ? error.message : "Request failed";
      sendError(ws, code, msg, "requestId" in message ? message.requestId : undefined);
      diagnosticWarn("ws", "handle_failed", { clientId: shortId(session.clientId), code, error: msg });
    }
  }

  function startHeartbeat(): void {
    if (heartbeatTicker) return;
    heartbeatTicker = setInterval(() => {
      for (const session of clients.values()) {
        if (!session.isAlive) {
          diagnosticWarn("ws", "heartbeat_timeout", { clientId: shortId(session.clientId) });
          session.ws.terminate();
          continue;
        }
        session.isAlive = false;
        try { session.ws.ping(); } catch { /* ignore */ }
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTicker.unref === "function") heartbeatTicker.unref();
  }

  function stopHeartbeat(): void {
    if (heartbeatTicker) { clearInterval(heartbeatTicker); heartbeatTicker = null; }
  }

  return {
    host,
    port,
    authRequired: auth.authRequired,

    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer = createServer(handleHttp);
        setupWebSocket();
        httpServer.on("upgrade", handleUpgrade);
        httpServer.on("error", (error) => {
          diagnosticError("gateway", "listen_error", { error: String(error) });
        });
        httpServer.listen(port, host, () => {
          diagnosticLog("gateway", "listening", { host, port, authRequired: auth.authRequired, connector: connector.name });
          startHeartbeat();
          resolve();
        });
        httpServer.on("error", reject);
      });
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        stopHeartbeat();
        for (const session of clients.values()) {
          try { session.ws.close(1001, "server shutting down"); } catch { /* ignore */ }
        }
        clients.clear();
        if (wsServer) { wsServer.close(); wsServer = null; }
        if (httpServer) {
          httpServer.close((error) => {
            httpServer = null;
            if (error) reject(error); else resolve();
          });
        } else {
          resolve();
        }
      });
    },

    async restart(): Promise<void> {
      diagnosticLog("gateway", "restart_begin", {});
      await this.close();
      await this.listen();
      diagnosticLog("gateway", "restart_complete", { host, port });
    },

    async broadcastConnectorStatus(): Promise<void> {
      const ack: ServerMessage = {
        type: "hello-ack",
        clientId: "",
        serverVersion: OPENCLAUDE_VERSION_LABEL,
        connector: connector.status,
        connectorName: connector.name,
      };
      broadcast(ack);
    },
  };
}
