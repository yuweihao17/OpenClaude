import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClaudeDesktopConnector } from "../connector/claude-desktop-connector.js";
import { clientMessageSchema, type ServerMessage } from "../shared/protocol.js";

export interface GatewayOptions {
  host: string;
  port: number;
  accessPassword: string;
  connector: ClaudeDesktopConnector;
}

function isAuthorized(request: IncomingMessage, password: string): boolean {
  if (!password) return false;
  const value = request.headers.authorization || "";
  return value === `Bearer ${password}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createGateway(options: GatewayOptions) {
  const httpServer = createServer((request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      sendJson(response, 200, { ok: true, connector: options.connector.name });
      return;
    }
    if (!isAuthorized(request, options.accessPassword)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const removeConnectorListener = options.connector.onEvent((sessionId, event) => {
    const message: ServerMessage = { type: "session.event", sessionId, event };
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  });

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws" || !isAuthorized(request, options.accessPassword)) {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });

  webSocketServer.on("connection", (client) => {
    clients.add(client);
    const hello: ServerMessage = { type: "hello", serverVersion: "0.1.0", connector: options.connector.name };
    client.send(JSON.stringify(hello));
    client.on("message", async (raw) => {
      try {
        const message = clientMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type === "session.list") {
          client.send(JSON.stringify({ type: "session.list.result", requestId: message.requestId, sessions: await options.connector.listSessions() }));
        } else if (message.type === "session.send") {
          await options.connector.sendMessage("default", message.text);
        } else if (message.type === "session.cancel") {
          await options.connector.cancel("default");
        }
      } catch (error) {
        const message: ServerMessage = { type: "error", code: "request_failed", message: error instanceof Error ? error.message : "Request failed" };
        client.send(JSON.stringify(message));
      }
    });
    client.on("close", () => clients.delete(client));
  });

  return {
    listen(): Promise<void> {
      return new Promise((resolve) => httpServer.listen(options.port, options.host, resolve));
    },
    close(): Promise<void> {
      removeConnectorListener();
      for (const client of clients) client.close();
      webSocketServer.close();
      return new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
