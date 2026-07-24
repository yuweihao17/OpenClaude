// OpenClaude web-shell 客户端（ES module）。
//
// 设计原则：绝不伪造连接状态。
// - WebSocket 状态只反映真实 readyState。
// - 连接器状态只来自 hello-ack.connector，未收到前显示“未知”。
// - 连接器为 unavailable 时明确提示“未配置”，并禁用会话操作。
//
// 协议（见 shared/protocol.ts）：
// - 客户端先发 {type:"hello"}，服务端回 {type:"hello-ack", connector, connectorName, ...}。
// - 业务消息：session.list / session.send(sessionId,text) / session.cancel(sessionId)。
// - 服务端消息：hello-ack / pong / session.list.result / session.send.accepted /
//   session.cancel.accepted / session.event / error。
// - 鉴权：POST /api/auth/login，body 为 {passwordHash}（密码的 sha256 hex）。

const TOKEN_KEY = "openclaude_token";
const HEARTBEAT_INTERVAL_MS = 20000;
const GATEWAY_POLL_MS = 20000;
const MAX_PROMPT_TEXT = 200000;

const ROLE_LABELS = {
  user: "你",
  assistant: "Claude",
  tool: "工具",
  error: "错误",
  system: "",
};

// ---------------- DOM ----------------

const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const loginForm = $("login-form");
const passwordInput = $("password-input");
const loginButton = $("login-button");
const loginError = $("login-error");

const appView = $("app-view");
const wsDot = $("ws-dot");
const wsValue = $("ws-value");
const gatewayDot = $("gateway-dot");
const gatewayValue = $("gateway-value");
const connectorDot = $("connector-dot");
const connectorValue = $("connector-value");
const serverVersionEl = $("server-version");

const appBody = $("app-body");
const refreshSessions = $("refresh-sessions");
const sessionList = $("session-list");
const sessionEmpty = $("session-empty");
const sessionEmptyText = $("session-empty-text");
const sessionEmptyHint = $("session-empty-hint");

const backButton = $("back-button");
const conversationTitle = $("conversation-title");
const conversationState = $("conversation-state");

const connectorBanner = $("connector-banner");
const bannerIcon = $("banner-icon");
const bannerTitle = $("banner-title");
const bannerDetail = $("banner-detail");

const messageStream = $("message-stream");
const composer = $("composer");
const composerHint = $("composer-hint");
const composerTextarea = $("composer-textarea");
const sendButton = $("send-button");
const cancelButton = $("cancel-button");

const toast = $("toast");

// 首次运行密码一次性展示（仅桌面端 preload 注入，手机端无此 API）
const setupModal = $("setup-modal");
const setupPasswordEl = $("setup-password");
const setupCopyBtn = $("setup-copy");
const setupCloseBtn = $("setup-close");

// ---------------- 状态 ----------------

let authToken = "";
let ws = null;
let helloAck = false;
let wsState = "disconnected"; // connecting | handshaking | connected | disconnected | error
let connectorStatus = null; // "supported" | "degraded" | "unavailable" | null(未知)
let connectorName = "";

let manualClose = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let heartbeatTimer = null;
let pendingPing = null;
let gatewayPollTimer = null;

let sessionsCache = [];
let activeSessionId = null;
let activeSessionTitle = "";

// sessionId -> Item[]
const messagesBySession = new Map();
// sessionId -> "idle" | "working" | "error"
const sessionStates = new Map();
// 当前渲染会话：itemId -> HTMLElement
const itemNodes = new Map();
// sessionId -> <li>
const sessionItemNodes = new Map();

let pendingSend = null; // { requestId, sessionId, itemId }
let pendingCancel = null; // { requestId, sessionId }
let pendingList = null; // requestId

// ---------------- 工具 ----------------

function genRequestId() {
  return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function genId() {
  return "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

function authHeaders() {
  const h = {};
  if (authToken) h["x-openclaude-token"] = authToken;
  return h;
}

function wsBaseUrl() {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + loc.host + "/ws";
}

function formatTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return pad(d.getHours()) + ":" + pad(d.getMinutes());
  return d.getMonth() + 1 + "-" + d.getDate();
}

let toastTimer = null;
function showToast(text, isError) {
  toast.textContent = text || "";
  toast.classList.toggle("error", !!isError);
  toast.classList.add("visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function showLoginError(text) {
  loginError.textContent = text;
  loginError.classList.add("visible");
}

function hideLoginError() {
  loginError.classList.remove("visible");
  loginError.textContent = "";
}

// ---------------- 状态栏 ----------------

function applyDot(el, cls) {
  el.className = "dot " + cls;
}

function setWsState(state) {
  wsState = state;
  const map = {
    connecting: { dot: "connecting", value: "连接中" },
    handshaking: { dot: "connecting", value: "握手中" },
    connected: { dot: "connected", value: "已连接" },
    disconnected: { dot: "disconnected", value: "已断开" },
    error: { dot: "error", value: "连接错误" },
  };
  const m = map[state] || map.disconnected;
  applyDot(wsDot, m.dot);
  wsValue.textContent = m.value;
  updateComposerState();
  updateSessionEmptyHint();
}

function setGatewayState(state) {
  const map = {
    online: { dot: "connected", value: "在线" },
    offline: { dot: "error", value: "离线" },
    unknown: { dot: "disconnected", value: "未知" },
  };
  const m = map[state] || map.unknown;
  applyDot(gatewayDot, m.dot);
  gatewayValue.textContent = m.value;
}

function setConnectorStatus(status) {
  connectorStatus = status;
  let dotClass;
  let value;
  if (status === "supported") {
    dotClass = "connected";
    value = "已就绪";
  } else if (status === "degraded") {
    dotClass = "degraded";
    value = "降级";
  } else if (status === "unavailable") {
    dotClass = "error";
    value = "未配置";
  } else {
    dotClass = "disconnected";
    value = "未知";
  }
  applyDot(connectorDot, dotClass);
  connectorValue.textContent = value;
  updateBanner();
  updateComposerState();
  updateSessionEmptyHint();
}

function updateBanner() {
  if (connectorStatus === "unavailable") {
    bannerIcon.textContent = "!";
    bannerTitle.textContent = "Claude Desktop 连接器未配置";
    bannerDetail.textContent =
      "当前版本不支持或连接器尚未配置，会话功能不可用。请在桌面端完成配置后再试。";
    connectorBanner.className = "connector-banner visible unavailable";
  } else if (connectorStatus === "degraded") {
    bannerIcon.textContent = "!";
    bannerTitle.textContent = "连接器降级运行";
    bannerDetail.textContent = "Claude Desktop 连接器处于降级状态，部分功能可能不可用。";
    connectorBanner.className = "connector-banner visible degraded";
  } else {
    connectorBanner.className = "connector-banner";
  }
}

function updateComposerState() {
  const text = composerTextarea.value.trim();
  const wsOk = wsState === "connected";
  const connectorOk = connectorStatus === "supported" || connectorStatus === "degraded";
  const hasActive = !!activeSessionId;
  const working = hasActive && sessionStates.get(activeSessionId) === "working";

  sendButton.disabled =
    !wsOk || !connectorOk || !hasActive || !!pendingSend || working || !text;
  cancelButton.disabled = !wsOk || !hasActive || !working;

  let hint = "";
  if (hasActive) {
    if (connectorStatus === "unavailable") hint = "连接器未配置";
    else if (!wsOk) hint = "连接已断开";
  }
  composerHint.textContent = hint;
}

function updateSessionEmptyHint() {
  if (!sessionEmpty || sessionEmpty.hidden) return;
  if (connectorStatus === "unavailable") {
    sessionEmptyText.textContent = "无法获取会话";
    sessionEmptyHint.textContent = "Claude Desktop 连接器未配置。";
  } else if (wsState !== "connected") {
    sessionEmptyText.textContent = "暂无会话";
    sessionEmptyHint.textContent = "正在连接网关…";
  } else {
    sessionEmptyText.textContent = "暂无会话";
    sessionEmptyHint.textContent = "等待 Claude Desktop 创建会话。";
  }
}

// ---------------- 鉴权 ----------------

async function bootstrap() {
  authToken = sessionStorage.getItem(TOKEN_KEY) || "";

  let authRequired = true;
  try {
    const hres = await fetch("/api/health", { cache: "no-store" });
    if (hres.ok) {
      const h = await hres.json();
      authRequired = !!h.authRequired;
      setGatewayState("online");
    } else {
      setGatewayState("offline");
    }
  } catch {
    setGatewayState("offline");
  }

  if (!authRequired) {
    enterApp();
    return;
  }

  try {
    const sres = await fetch("/api/auth/status", {
      cache: "no-store",
      headers: authHeaders(),
    });
    if (sres.ok) {
      const s = await sres.json();
      if (s.authenticated) {
        enterApp();
        return;
      }
    }
  } catch {
    /* 忽略，停留在登录页 */
  }

  // 停留在登录页（HTML 默认可见）
  passwordInput.focus();
}

function enterApp() {
  loginView.style.display = "none";
  appView.classList.add("visible");
  setWsState("disconnected");
  setConnectorStatus(null);
  pollGateway();
  gatewayPollTimer = setInterval(pollGateway, GATEWAY_POLL_MS);
  connect();
}

async function pollGateway() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error("health " + res.status);
    setGatewayState("online");
  } catch {
    setGatewayState("offline");
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  hideLoginError();
  const password = passwordInput.value;
  if (!password) {
    showLoginError("请输入密码");
    return;
  }
  loginButton.disabled = true;
  loginButton.textContent = "登录中…";
  try {
    const passwordHash = await sha256Hex(password);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ passwordHash }),
      cache: "no-store",
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* 忽略解析错误 */
    }
    if (res.ok && data.authenticated) {
      if (data.token) {
        authToken = data.token;
        sessionStorage.setItem(TOKEN_KEY, data.token);
      }
      enterApp();
      return;
    }
    if (res.status === 401) showLoginError("密码错误");
    else if (res.status === 429) showLoginError("尝试次数过多，请稍后再试");
    else if (res.status === 413) showLoginError("请求体过大");
    else showLoginError(data.error || "登录失败，请重试");
  } catch {
    showLoginError("无法连接到网关，请检查网络");
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = "登录";
  }
}

// ---------------- WebSocket ----------------

function connect() {
  manualClose = false;
  if (ws) {
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
    ws = null;
  }
  setWsState("connecting");

  const url =
    wsBaseUrl() + (authToken ? "?token=" + encodeURIComponent(authToken) : "");
  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    setWsState("error");
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    helloAck = false;
    setWsState("handshaking");
    // 握手：必须先发 hello，等待 hello-ack 后才允许业务消息。
    sendJson({ type: "hello" });
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
    helloAck = false;
    setWsState("disconnected");
    // 中断时把待发送消息标记为失败，绝不假装已送达。
    if (pendingSend) {
      const { sessionId, itemId } = pendingSend;
      const item = findItem(sessionId, itemId);
      if (item) {
        item.status = "failed";
        refreshItemNode(item);
      }
      pushItem(sessionId, { id: genId(), role: "system", text: "连接已中断，消息可能未送达。" });
      pendingSend = null;
      setSessionState(sessionId, "error");
      updateComposerState();
    }
    pendingCancel = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    setWsState("error");
    // onclose 随后会触发并调度重连。
  };
}

function sendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function scheduleReconnect() {
  if (manualClose) return;
  if (reconnectTimer) return;
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
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
      // 上一次 ping 未收到 pong，判定连接无响应，主动重连。
      showToast("连接无响应，正在重连…", true);
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      return;
    }
    const requestId = genRequestId();
    pendingPing = requestId;
    sendJson({ type: "ping", requestId });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  pendingPing = null;
}

// ---------------- 服务端消息 ----------------

function handleServerMessage(msg) {
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "hello-ack":
      handleHelloAck(msg);
      break;
    case "pong":
      pendingPing = null;
      break;
    case "session.list.result":
      handleSessionListResult(msg);
      break;
    case "session.send.accepted":
      handleSendAccepted(msg);
      break;
    case "session.cancel.accepted":
      handleCancelAccepted(msg);
      break;
    case "session.event":
      handleSessionEvent(msg);
      break;
    case "error":
      handleServerError(msg);
      break;
    default:
      break;
  }
}

function handleHelloAck(msg) {
  helloAck = true;
  reconnectAttempts = 0;
  // 连接器状态只来自 hello-ack，绝不伪造。
  setWsState("connected");
  setConnectorStatus(msg.connector || null);
  if (msg.connectorName) connectorName = msg.connectorName;
  if (msg.serverVersion) serverVersionEl.textContent = "v" + msg.serverVersion;
  // 连接器不可用时不主动拉取会话（必然为空），但仍尝试一次以刷新空态提示。
  requestSessionList();
}

function requestSessionList() {
  if (!helloAck) {
    showToast("尚未连接", true);
    return;
  }
  const requestId = genRequestId();
  pendingList = requestId;
  sendJson({ type: "session.list", requestId });
}

function handleSessionListResult(msg) {
  if (pendingList && msg.requestId !== pendingList) {
    // 忽略过期的列表结果（理论上不会发生）。
  }
  pendingList = null;
  sessionsCache = Array.isArray(msg.sessions) ? msg.sessions : [];
  for (const s of sessionsCache) {
    if (s && s.id) sessionStates.set(s.id, s.state || "idle");
  }
  renderSessionList();
}

function handleSendAccepted(msg) {
  if (pendingSend && msg.requestId === pendingSend.requestId) {
    const { sessionId, itemId } = pendingSend;
    const item = findItem(sessionId, itemId);
    if (item) {
      item.status = "delivered";
      refreshItemNode(item);
    }
    pendingSend = null;
    setSessionState(sessionId, "working");
    updateComposerState();
  }
}

function handleCancelAccepted(msg) {
  if (pendingCancel && msg.requestId === pendingCancel.requestId) pendingCancel = null;
  setSessionState(msg.sessionId, "idle");
  showToast("已请求停止生成");
  updateComposerState();
}

function handleSessionEvent(msg) {
  const sessionId = msg.sessionId;
  const ev = msg.event;
  if (!sessionId || !ev || !ev.kind) return;
  switch (ev.kind) {
    case "assistant.delta":
      handleAssistantDelta(sessionId, ev.text || "");
      break;
    case "assistant.completed":
      handleAssistantCompleted(sessionId);
      break;
    case "tool.started":
      handleTool(sessionId, "started", ev.name || "");
      break;
    case "tool.completed":
      handleTool(sessionId, "completed", ev.name || "");
      break;
    case "error":
      handleSessionError(sessionId, ev.message || "未知错误");
      break;
    default:
      break;
  }
}

function handleServerError(msg) {
  const message = msg.message || "服务器错误";
  if (pendingSend && msg.requestId === pendingSend.requestId) {
    const { sessionId, itemId } = pendingSend;
    const item = findItem(sessionId, itemId);
    if (item) {
      item.status = "failed";
      refreshItemNode(item);
    }
    pushItem(sessionId, { id: genId(), role: "error", text: message });
    pendingSend = null;
    setSessionState(sessionId, "error");
    updateComposerState();
    showToast(message, true);
    return;
  }
  if (pendingCancel && msg.requestId === pendingCancel.requestId) {
    pendingCancel = null;
    showToast("停止失败：" + message, true);
    updateComposerState();
    return;
  }
  if (pendingList && msg.requestId === pendingList) {
    pendingList = null;
    showToast("获取会话列表失败：" + message, true);
    return;
  }
  showToast(message, true);
}

// ---------------- 会话事件处理 ----------------

function handleAssistantDelta(sessionId, text) {
  let msgs = messagesBySession.get(sessionId);
  if (!msgs) {
    msgs = [];
    messagesBySession.set(sessionId, msgs);
  }
  let last = msgs.length ? msgs[msgs.length - 1] : null;
  if (!last || last.role !== "assistant" || last.status !== "streaming") {
    last = { id: genId(), role: "assistant", text: "", status: "streaming" };
    msgs.push(last);
    if (sessionId === activeSessionId) appendItemNode(last);
  }
  last.text += text;
  if (sessionId === activeSessionId) {
    refreshItemNode(last);
    scrollToBottomIfNear();
  }
  setSessionState(sessionId, "working");
}

function handleAssistantCompleted(sessionId) {
  const msgs = messagesBySession.get(sessionId);
  if (msgs) {
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === "assistant" && msgs[i].status === "streaming") {
        msgs[i].status = "done";
        if (sessionId === activeSessionId) refreshItemNode(msgs[i]);
        break;
      }
    }
  }
  setSessionState(sessionId, "idle");
  updateComposerState();
}

function handleTool(sessionId, kind, name) {
  pushItem(sessionId, { id: genId(), role: "tool", kind, toolName: name });
  if (kind === "started") setSessionState(sessionId, "working");
  if (sessionId === activeSessionId) scrollToBottomIfNear();
}

function handleSessionError(sessionId, message) {
  pushItem(sessionId, { id: genId(), role: "error", text: message });
  setSessionState(sessionId, "error");
  updateComposerState();
  if (sessionId === activeSessionId) scrollToBottomIfNear();
}

// ---------------- 会话列表渲染 ----------------

function renderSessionList() {
  sessionList.innerHTML = "";
  sessionItemNodes.clear();

  if (!sessionsCache || sessionsCache.length === 0) {
    sessionEmpty.hidden = false;
    sessionList.hidden = true;
    updateSessionEmptyHint();
    return;
  }

  sessionEmpty.hidden = true;
  sessionList.hidden = false;

  for (const s of sessionsCache) {
    const li = document.createElement("li");
    li.className = "session-item" + (s.id === activeSessionId ? " active" : "");
    li.dataset.sessionId = s.id;

    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = s.title || "未命名会话";

    const meta = document.createElement("div");
    meta.className = "session-meta";

    const time = document.createElement("span");
    time.textContent = formatTime(s.updatedAt);

    const state = document.createElement("span");
    state.className = "session-state";
    applySessionStateSpan(state, sessionStates.get(s.id) || s.state || "idle");

    meta.appendChild(time);
    meta.appendChild(state);
    li.appendChild(title);
    li.appendChild(meta);

    li.addEventListener("click", () =>
      selectSession(s.id, s.title || "未命名会话"),
    );

    sessionList.appendChild(li);
    sessionItemNodes.set(s.id, li);
  }
}

function applySessionStateSpan(span, state) {
  span.className =
    "session-state" +
    (state === "working" ? " working" : state === "error" ? " error" : "");
  span.textContent =
    state === "working" ? "工作中" : state === "error" ? "错误" : "空闲";
}

function updateSessionListItemState(sessionId) {
  const li = sessionItemNodes.get(sessionId);
  if (!li) return;
  const span = li.querySelector(".session-state");
  if (!span) return;
  applySessionStateSpan(span, sessionStates.get(sessionId) || "idle");
}

function setSessionState(sessionId, state) {
  if (!sessionId) return;
  sessionStates.set(sessionId, state);
  updateSessionListItemState(sessionId);
  if (sessionId === activeSessionId) {
    conversationState.textContent =
      state === "working" ? "工作中" : state === "error" ? "错误" : "空闲";
  }
}

function selectSession(id, title) {
  activeSessionId = id;
  activeSessionTitle = title;
  for (const [sid, li] of sessionItemNodes) {
    li.classList.toggle("active", sid === id);
  }
  conversationTitle.textContent = title;
  const st = sessionStates.get(id) || "idle";
  conversationState.textContent =
    st === "working" ? "工作中" : st === "error" ? "错误" : "空闲";
  appBody.classList.add("show-conversation");
  renderActiveSession();
  updateComposerState();
  composerTextarea.focus();
}

// ---------------- 消息渲染 ----------------

function createItemNode(item) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + item.role;
  wrap.dataset.itemId = item.id;

  if (item.role === "user" && item.status === "pending") wrap.classList.add("pending");
  if (item.role === "user" && item.status === "failed") wrap.classList.add("failed");
  if (item.role === "assistant" && item.status === "streaming")
    wrap.classList.add("streaming");

  if (item.role !== "system") {
    const role = document.createElement("div");
    role.className = "msg-role";
    role.textContent = ROLE_LABELS[item.role] || "";
    wrap.appendChild(role);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (item.role === "tool") {
    const tag = document.createElement("span");
    tag.className = "tool-tag";
    tag.textContent = item.kind === "started" ? "▶ 工具开始" : "✔ 工具完成";
    bubble.appendChild(tag);
    bubble.appendChild(document.createTextNode(" " + (item.toolName || "")));
  } else {
    bubble.textContent = item.text || "";
  }

  wrap.appendChild(bubble);
  return wrap;
}

function appendItemNode(item) {
  const node = createItemNode(item);
  messageStream.appendChild(node);
  itemNodes.set(item.id, node);
}

function refreshItemNode(item) {
  const node = itemNodes.get(item.id);
  if (!node) return;
  const bubble = node.querySelector(".msg-bubble");
  if (item.role === "assistant") {
    if (bubble) bubble.textContent = item.text || "";
    node.classList.toggle("streaming", item.status === "streaming");
  } else if (item.role === "user") {
    node.classList.toggle("pending", item.status === "pending");
    node.classList.toggle("failed", item.status === "failed");
    if (bubble) bubble.textContent = item.text || "";
  }
}

function findItem(sessionId, itemId) {
  const msgs = messagesBySession.get(sessionId);
  if (!msgs) return null;
  return msgs.find((m) => m.id === itemId) || null;
}

function pushItem(sessionId, item) {
  let msgs = messagesBySession.get(sessionId);
  if (!msgs) {
    msgs = [];
    messagesBySession.set(sessionId, msgs);
  }
  msgs.push(item);
  if (sessionId === activeSessionId) {
    hideMessageEmpty();
    appendItemNode(item);
    scrollToBottomIfNear();
  }
}

function renderActiveSession() {
  messageStream.innerHTML = "";
  itemNodes.clear();
  if (!activeSessionId) {
    showMessageEmpty("请从左侧选择会话");
    return;
  }
  const msgs = messagesBySession.get(activeSessionId) || [];
  if (msgs.length === 0) {
    showMessageEmpty("暂无消息，输入内容开始对话");
    return;
  }
  hideMessageEmpty();
  for (const item of msgs) appendItemNode(item);
  scrollToBottom();
}

function showMessageEmpty(text) {
  let el = messageStream.querySelector(".message-empty");
  if (!el) {
    el = document.createElement("div");
    el.className = "message-empty";
    messageStream.appendChild(el);
  }
  el.textContent = text;
}

function hideMessageEmpty() {
  const el = messageStream.querySelector(".message-empty");
  if (el) el.remove();
}

function scrollToBottom() {
  messageStream.scrollTop = messageStream.scrollHeight;
}

function scrollToBottomIfNear() {
  const el = messageStream;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (near) el.scrollTop = el.scrollHeight;
}

// ---------------- 输入与发送 ----------------

function autoSizeTextarea() {
  const el = composerTextarea;
  el.style.height = "auto";
  el.style.height = Math.min(140, el.scrollHeight) + "px";
}

function handleSend(e) {
  e.preventDefault();
  if (!helloAck || wsState !== "connected") {
    showToast("尚未连接", true);
    return;
  }
  if (connectorStatus === "unavailable") {
    showToast("连接器未配置，无法发送", true);
    return;
  }
  const sessionId = activeSessionId;
  if (!sessionId) {
    showToast("请先选择会话", true);
    return;
  }
  const text = composerTextarea.value.trim();
  if (!text) return;
  if (text.length > MAX_PROMPT_TEXT) {
    showToast("消息过长", true);
    return;
  }

  const item = { id: genId(), role: "user", text, status: "pending" };
  pushItem(sessionId, item);

  const requestId = genRequestId();
  pendingSend = { requestId, sessionId, itemId: item.id };
  sendJson({ type: "session.send", requestId, sessionId, text });

  composerTextarea.value = "";
  autoSizeTextarea();
  updateComposerState();
}

function handleCancel() {
  if (!activeSessionId) return;
  if (wsState !== "connected" || !helloAck) {
    showToast("尚未连接", true);
    return;
  }
  if (sessionStates.get(activeSessionId) !== "working") return;
  const requestId = genRequestId();
  pendingCancel = { requestId, sessionId: activeSessionId };
  sendJson({ type: "session.cancel", requestId, sessionId: activeSessionId });
  updateComposerState();
}

// ---------------- 首次运行密码展示 ----------------

function showSetupPassword(password) {
  if (!setupModal || !setupPasswordEl) return;
  setupPasswordEl.textContent = String(password || "");
  setupModal.hidden = false;
  if (setupCopyBtn) {
    setupCopyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(String(password || ""));
        showToast("已复制到剪贴板");
      } catch {
        showToast("复制失败，请手动选中复制", true);
      }
    };
  }
  if (setupCloseBtn) {
    setupCloseBtn.onclick = () => {
      setupModal.hidden = true;
      // 清空 DOM 中的明文，避免长期驻留。
      setupPasswordEl.textContent = "";
    };
  }
}

// ---------------- 初始化 ----------------

function init() {
  loginForm.addEventListener("submit", handleLoginSubmit);

  // 桌面端首次运行：preload 通过 window.openclaude.onInitialPassword 一次性投递明文密码。
  // 仅本机窗口可触发；手机端浏览器没有 window.openclaude，因此永不会进入此分支。
  if (window.openclaude && typeof window.openclaude.onInitialPassword === "function") {
    window.openclaude.onInitialPassword((password) => {
      if (!password) return;
      showSetupPassword(password);
    });
  }

  refreshSessions.addEventListener("click", () => {
    if (!helloAck) {
      showToast("尚未连接", true);
      return;
    }
    requestSessionList();
  });

  backButton.addEventListener("click", () => {
    appBody.classList.remove("show-conversation");
  });

  composer.addEventListener("submit", handleSend);
  cancelButton.addEventListener("click", handleCancel);

  composerTextarea.addEventListener("input", () => {
    autoSizeTextarea();
    updateComposerState();
  });

  composerTextarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!sendButton.disabled) handleSend(e);
    }
  });

  window.addEventListener("beforeunload", () => {
    manualClose = true;
  });

  bootstrap();
}

init();
