/**
 * OpenClaude Bridge Polyfill
 *
 * 在浏览器环境中模拟 Electron 的 window.electron.ipcRenderer API，
 * 通过 WebSocket 将所有 IPC 调用转发到 OpenClaude Gateway。
 *
 * 设计原则：
 * - 完全透明：Claude Desktop 的 renderer 代码无需修改
 * - 双向通信：支持 invoke、on、send 等所有 IPC 模式
 * - 可靠传输：WebSocket 断线自动重连，消息队列保证顺序
 */

(function () {
  const w = window;

  // 防止重复安装
  if (w.__claudeBridgePolyfillInstalled) return;
  w.__claudeBridgePolyfillInstalled = true;

  // 配置从 gateway 注入（通过 <script> 标签的 data 属性或 window.__CLAUDE_WEB_CONFIG__）
  const cfg = (w.__CLAUDE_WEB_CONFIG__ = w.__CLAUDE_WEB_CONFIG__ || {
    gatewayBaseUrl: location.origin,
    gatewayWsUrl: location.origin.replace(/^http/, "ws") + "/ws",
  });

  // ==================== 常量 ====================

  const WS_READY_WAIT_TIMEOUT_MS = 2500;
  const HEARTBEAT_INTERVAL_MS = 20000;
  const RECONNECT_MIN_DELAY_MS = 500;
  const RECONNECT_MAX_DELAY_MS = 30000;
  const CLIENT_DIAGNOSTIC_FLUSH_DELAY_MS = 120;
  const CLIENT_DIAGNOSTIC_MAX_BATCH = 40;

  // ==================== 状态 ====================

  const clientId = w.crypto?.randomUUID?.() || `web-client-${Math.random().toString(36).slice(2)}`;
  const bridgeStartedAtMs = Date.now();

  // IPC 监听器：Map<channel, Set<handler>>
  const listeners = new Map();

  // WebSocket 状态
  let ws = null;
  let wsReady = false;
  const wsReadyWaiters = new Set();
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let heartbeatTimer = null;
  let pendingPing = null;

  // 认证
  let authToken = "";

  // 诊断日志队列
  const clientDiagnosticQueue = [];
  let clientDiagnosticFlushTimer = null;

  // ==================== 工具函数 ====================

  function gatewayAuthToken() {
    try {
      return String(w.__OPEN_CLAUDE_RUNTIME_AUTH_TOKEN__ || "").trim();
    } catch {
      return "";
    }
  }

  function gatewayAuthHeaders(headers) {
    const result = new Headers(headers || {});
    const token = gatewayAuthToken();
    if (token) {
      result.set("authorization", `Bearer ${token}`);
      result.set("x-claude-web-token", token);
    }
    return result;
  }

  function gatewayWebSocketUrl() {
    const rawUrl = cfg.gatewayWsUrl || location.origin.replace(/^http/, "ws") + "/ws";
    const token = gatewayAuthToken();
    if (!token) return rawUrl;
    try {
      const parsed = new URL(rawUrl, location.href);
      parsed.searchParams.set("token", token);
      return parsed.toString();
    } catch {
      const separator = rawUrl.includes("?") ? "&" : "?";
      return `${rawUrl}${separator}token=${encodeURIComponent(token)}`;
    }
  }

  function websocketStateName(socket) {
    if (!socket || !("WebSocket" in w)) return "missing";
    if (socket.readyState === w.WebSocket.CONNECTING) return "connecting";
    if (socket.readyState === w.WebSocket.OPEN) return "open";
    if (socket.readyState === w.WebSocket.CLOSING) return "closing";
    if (socket.readyState === w.WebSocket.CLOSED) return "closed";
    return String(socket.readyState);
  }

  function payloadShape(payload) {
    if (payload === null) return "null";
    if (Array.isArray(payload)) return `array(${payload.length})`;
    if (typeof payload === "object") return `object(${Object.keys(payload).length})`;
    return typeof payload;
  }

  function stringifyForIpc(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, nestedValue) => {
      if (nestedValue instanceof Error) {
        return {
          name: nestedValue.name,
          message: nestedValue.message,
          stack: nestedValue.stack,
          cause: nestedValue.cause,
        };
      }
      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
      }
      return nestedValue;
    });
  }

  // ==================== 诊断日志 ====================

  function sanitizeClientDiagnosticValue(key, value) {
    if (value == null) return value;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : undefined;
    if (typeof value === "string") {
      return value.length > 260 ? `${value.slice(0, 260)}...` : value;
    }
    return payloadShape(value);
  }

  function flushClientDiagnostics() {
    clientDiagnosticFlushTimer = null;
    if (clientDiagnosticQueue.length === 0) return;
    const events = clientDiagnosticQueue.splice(0, clientDiagnosticQueue.length);
    try {
      w.fetch("/api/client-log", {
        method: "POST",
        credentials: "same-origin",
        headers: gatewayAuthHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ clientId, events }),
      }).catch(() => {});
    } catch {}
  }

  function scheduleClientDiagnosticFlush() {
    if (clientDiagnosticFlushTimer) return;
    clientDiagnosticFlushTimer = w.setTimeout(flushClientDiagnostics, CLIENT_DIAGNOSTIC_FLUSH_DELAY_MS);
  }

  function clientDiagnostic(event, data) {
    try {
      const diagnosticData = {
        ageMs: Date.now() - bridgeStartedAtMs,
        clientAt: new Date().toISOString(),
        clientId: clientId.slice(0, 16),
        href: location.href.split("?")[0],
      };
      if (data && typeof data === "object") {
        for (const [key, value] of Object.entries(data)) {
          const sanitized = sanitizeClientDiagnosticValue(key, value);
          if (sanitized !== undefined) diagnosticData[key] = sanitized;
        }
      }
      clientDiagnosticQueue.push({ event, data: diagnosticData });
      if (clientDiagnosticQueue.length >= CLIENT_DIAGNOSTIC_MAX_BATCH) {
        if (clientDiagnosticFlushTimer) {
          w.clearTimeout(clientDiagnosticFlushTimer);
          clientDiagnosticFlushTimer = null;
        }
        flushClientDiagnostics();
      } else {
        scheduleClientDiagnosticFlush();
      }
    } catch {}
  }

  clientDiagnostic("bridge-installed", {
    target: "claude-bridge-polyfill",
    wsState: websocketStateName(ws),
  });

  // ==================== WebSocket 连接 ====================

  function connect() {
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }

    const url = gatewayWebSocketUrl();
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      clientDiagnostic("ws-connect-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      clientDiagnostic("ws-connected", {
        wsState: websocketStateName(socket),
      });
      // 发送 hello 握手
      sendJson({ type: "hello", clientId });
      startHeartbeat();
    };

    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      handleServerMessage(msg);
    };

    socket.onclose = () => {
      if (ws === socket) ws = null;
      stopHeartbeat();
      wsReady = false;
      settleWsReadyWaiters(false);
      clientDiagnostic("ws-closed", {
        wsState: websocketStateName(socket),
      });
      scheduleReconnect();
    };

    socket.onerror = () => {
      clientDiagnostic("ws-error", {
        wsState: websocketStateName(socket),
      });
    };
  }

  function sendJson(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_MIN_DELAY_MS * Math.pow(2, reconnectAttempts));
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function startHeartbeat() {
    stopHeartbeat();
    pendingPing = null;
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (pendingPing !== null) {
        // 上一次 ping 未收到 pong，判定连接无响应
        clientDiagnostic("ws-heartbeat-timeout", {
          wsState: websocketStateName(ws),
        });
        try {
          ws.close();
        } catch {}
        return;
      }
      const requestId = `ping-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingPing = requestId;
      sendJson({ type: "ping", requestId, clientId });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    pendingPing = null;
  }

  function settleWsReadyWaiters(ready) {
    for (const resolve of [...wsReadyWaiters]) {
      wsReadyWaiters.delete(resolve);
      try {
        resolve(ready);
      } catch {}
    }
  }

  function markGatewayWsReady() {
    wsReady = true;
    reconnectAttempts = 0;
    settleWsReadyWaiters(true);
    clientDiagnostic("ws-ready", {
      wsState: websocketStateName(ws),
    });
  }

  function waitForGatewayWsReady() {
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = w.setTimeout(() => {
        wsReadyWaiters.delete(resolveReady);
        resolve(false);
      }, WS_READY_WAIT_TIMEOUT_MS);
      const resolveReady = (ready) => {
        w.clearTimeout(timer);
        resolve(ready);
      };
      wsReadyWaiters.add(resolveReady);
    });
  }

  // ==================== 服务端消息处理 ====================

  function handleServerMessage(msg) {
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "hello-ack":
        markGatewayWsReady();
        break;
      case "pong":
        pendingPing = null;
        break;
      case "ipc-message":
        // Gateway 发来的 IPC 消息（从 Claude Desktop main 进程）
        handleIpcMessage(msg);
        break;
      default:
        break;
    }
  }

  function handleIpcMessage(msg) {
    if (!msg.channel) return;
    const channel = msg.channel;
    const payload = msg.payload;

    clientDiagnostic("ipc-receive", {
      channel,
      payloadType: payloadShape(payload),
    });

    dispatch(channel, payload);
  }

  // ==================== IPC 监听器管理 ====================

  function ensureSet(channel) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    return listeners.get(channel);
  }

  function subscribe(channel, handler) {
    const set = ensureSet(channel);
    set.add(handler);
    return () => unsubscribe(channel, handler);
  }

  function unsubscribe(channel, handler) {
    const set = listeners.get(channel);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) listeners.delete(channel);
  }

  function dispatch(channel, payload) {
    const set = listeners.get(channel);
    if (!set || set.size === 0) return 0;
    let delivered = 0;
    for (const handler of [...set]) {
      try {
        // Electron IPC handler 签名: (event, ...args)
        // event 对象包含 sender, reply 等方法
        const event = {
          sender: {
            send: (replyChannel, ...replyArgs) => {
              send(replyChannel, ...replyArgs);
            },
          },
        };
        handler(event, payload);
        delivered += 1;
      } catch (error) {
        console.error("[claude-web] listener error", channel, error);
      }
    }
    return delivered;
  }

  // ==================== IPC API 实现 ====================

  /**
   * ipcRenderer.invoke(channel, ...args)
   * 通过 HTTP 调用 gateway 的 /api/ipc/invoke
   */
  async function invoke(channel, ...args) {
    const invokeStartedAtMs = Date.now();
    clientDiagnostic("ipc-invoke-start", {
      channel,
      argsCount: args.length,
      wsReady,
      wsState: websocketStateName(ws),
    });

    // 等待 WebSocket 就绪（用于接收异步响应）
    await waitForGatewayWsReady();

    const body = stringifyForIpc({ channel, args, clientId });

    try {
      const res = await w.fetch("/api/ipc/invoke", {
        method: "POST",
        credentials: "same-origin",
        headers: gatewayAuthHeaders({ "content-type": "application/json" }),
        body,
      });

      const json = await res.json().catch(() => null);

      if (!res.ok || (json && typeof json === "object" && json.ok === false)) {
        const message = `IPC invoke failed: ${channel} (${res.status})`;
        const error = new Error(message);
        error.channel = channel;
        error.status = res.status;
        error.response = json;
        throw error;
      }

      clientDiagnostic("ipc-invoke-success", {
        channel,
        elapsedMs: Date.now() - invokeStartedAtMs,
        ok: true,
        status: res.status,
      });

      // Gateway 返回 { value: ... } 格式
      if (json && typeof json === "object" && Object.prototype.hasOwnProperty.call(json, "value")) {
        return json.value;
      }
      return json;
    } catch (error) {
      clientDiagnostic("ipc-invoke-failed", {
        channel,
        elapsedMs: Date.now() - invokeStartedAtMs,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        status: error && typeof error.status === "number" ? error.status : 0,
      });
      throw error;
    }
  }

  /**
   * ipcRenderer.send(channel, ...args)
   * 单向发送消息到 main 进程
   */
  function send(channel, ...args) {
    clientDiagnostic("ipc-send", {
      channel,
      argsCount: args.length,
    });

    // send 是单向的，通过 WebSocket 发送
    if (!sendJson({ type: "ipc-send", channel, args, clientId })) {
      // WebSocket 未就绪，尝试通过 HTTP 发送
      w.fetch("/api/ipc/send", {
        method: "POST",
        credentials: "same-origin",
        headers: gatewayAuthHeaders({ "content-type": "application/json" }),
        body: stringifyForIpc({ channel, args, clientId }),
      }).catch(() => {});
    }
  }

  /**
   * ipcRenderer.on(channel, handler)
   * 注册监听器
   */
  function on(channel, handler) {
    subscribe(channel, handler);
  }

  /**
   * ipcRenderer.once(channel, handler)
   * 注册一次性监听器
   */
  function once(channel, handler) {
    const wrappedHandler = (event, ...args) => {
      unsubscribe(channel, wrappedHandler);
      handler(event, ...args);
    };
    subscribe(channel, wrappedHandler);
  }

  /**
   * ipcRenderer.off(channel, handler)
   * 移除监听器
   */
  function off(channel, handler) {
    unsubscribe(channel, handler);
  }

  /**
   * ipcRenderer.removeListener(channel, handler)
   * 移除监听器（别名）
   */
  function removeListener(channel, handler) {
    unsubscribe(channel, handler);
  }

  /**
   * ipcRenderer.removeAllListeners(channel)
   * 移除某个频道的所有监听器
   */
  function removeAllListeners(channel) {
    if (channel) {
      listeners.delete(channel);
    } else {
      listeners.clear();
    }
  }

  // ==================== 安装 Polyfill ====================

  // 创建 ipcRenderer API
  const ipcRenderer = {
    invoke,
    send,
    on,
    once,
    off,
    removeListener,
    removeAllListeners,
  };

  // 安装到 window.electron.ipcRenderer（Claude Desktop 的标准 API）
  if (!w.electron) {
    w.electron = {};
  }
  w.electron.ipcRenderer = ipcRenderer;

  // 也可以挂载到 window.__CLAUDE_WEB_IPC__ 用于调试
  w.__CLAUDE_WEB_IPC__ = {
    ipcRenderer,
    diagnostics: {
      clientId,
      getWsState: () => websocketStateName(ws),
      isReady: () => wsReady,
      getListeners: () => Array.from(listeners.keys()),
    },
  };

  clientDiagnostic("polyfill-ready", {
    target: "window.electron.ipcRenderer",
  });

  // ==================== 启动连接 ====================

  // 页面加载完成后建立 WebSocket 连接
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      connect();
    }, { once: true });
  } else {
    connect();
  }

  // 页面卸载时清理
  window.addEventListener("beforeunload", () => {
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
  });

})();
