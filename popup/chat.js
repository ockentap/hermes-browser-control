// Site Control — side panel. Owns the WebSocket to the bridge directly.
// The SW can't keep a long-lived WS in MV3 (gets torn down after ~30s idle),
// so we keep it here in the side panel which lives as long as it's open.
//
// Flow:
//   side panel (chat.js)  <--WS-->  bridge  <--subprocess-->  hermes chat
//   side panel (chat.js)  <--chrome.runtime.sendMessage-->  SW  <--tabs.sendMessage-->  content.js
//
// Per-tab conversation history persisted in chrome.storage.local.

const $ = (s) => document.querySelector(s);
const messagesEl = $("#messages");
const inputEl    = $("#input");
const sendBtn    = $("#send-btn");
const bridgeState = $("#bridge-state");
const connDot    = $("#conn-dot");
const tabTitle   = $("#tab-title");
const busy       = $("#busy");

let sessionId = null;
let currentTabId = null;

// ---- WebSocket ownership (side panel, not the SW) ----------------------

let ws = null;
let wsConnected = false;
let wsBackoff = 1000;
let wsUrl = null;
let reconnectTimer = null;

async function loadBridgeUrl() {
  const { bridgeUrl } = await chrome.storage.local.get("bridgeUrl");
  wsUrl = bridgeUrl || null;
}

function connectBridge() {
  if (!wsUrl) {
    setConnected("disconnected");
    return;
  }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  setConnected("connecting");
  let sock;
  try {
    sock = new WebSocket(wsUrl);
  } catch (e) {
    console.error("[sc] WS construct failed:", e.message);
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.addEventListener("open", () => {
    wsConnected = true;
    wsBackoff = 1000;
    setConnected("connected");
    sock.send(JSON.stringify({ type: "REGISTER", role: "extension" }));
  });

  sock.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }
    handleServerMessage(msg);
  });

  sock.addEventListener("close", () => {
    wsConnected = false;
    ws = null;
    setConnected("disconnected");
    scheduleReconnect();
  });

  sock.addEventListener("error", (e) => {
    console.error("[sc] WS error:", e?.message || e);
    // The close event will follow; reconnect handled there.
  });
}

function scheduleReconnect() {
  wsBackoff = Math.min(wsBackoff * 2, 5000);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBridge, wsBackoff);
}

function reconnectNow() {
  wsBackoff = 1000;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connectBridge();
}

function waitForConnection(timeout = 3000) {
  return new Promise((resolve) => {
    if (wsConnected) return resolve(true);
    const start = Date.now();
    const tick = () => {
      if (wsConnected) return resolve(true);
      if (Date.now() - start > timeout) return resolve(false);
      setTimeout(tick, 25);
    };
    tick();
  });
}

function wsSend(obj) {
  if (!wsConnected || !ws) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.error("[sc] ws.send failed:", e.message);
    return false;
  }
}

// Server messages: route by type
async function handleServerMessage(msg) {
  if (msg.type === "WELCOME") return;
  if (msg.type === "PING") { wsSend({ type: "PONG", t: Date.now() }); return; }
  // SC_CHAT from the agent — show in chat
  if (msg.type === "SC_CHAT") {
    if (msg.sessionId && msg.sessionId !== sessionId) return;
    clearThinkingBubble();
    if (msg.from === "me") {
      if (msg.thinking) {
        await append("me", msg.text, { html: `<span class="thinking-dots">${escapeHtml(msg.text)}</span>`, skipSave: false });
      } else if (msg.html) {
        await append("me", "", { html: msg.html, skipSave: false });
      } else {
        await append("me", msg.text || "", { skipSave: false });
      }
    } else if (msg.from === "system") {
      await sysMsg(msg.text || "", { skipSave: false });
    } else if (msg.from === "error") {
      await errMsg(msg.text || "", { skipSave: false });
    } else if (msg.from === "action") {
      await append("me", msg.summary || "Action:", { code: JSON.stringify(msg.detail, null, 2), skipSave: false });
    }
    setBusy(false);
    return;
  }
  // Server-issued command for the active tab — forward to content script
  // via the SW relay. The bridge expects a {id, ok, result} reply on the WS.
  try {
    const tab = await getActiveTabId();
    if (!tab) {
      wsSend({ id: msg.id, ok: false, error: "no active tab" });
      return;
    }
    const result = await chrome.runtime.sendMessage({ ...msg, _targetTabId: tab });
    wsSend({ id: msg.id, ...(result || { ok: false, error: "no response from SW" }) });
  } catch (e) {
    wsSend({ id: msg.id, ok: false, error: String(e?.message || e) });
  }
}

async function getActiveTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

// ---- session id (per-tab) ----
async function initSession(tabId) {
  const k = `session:${tabId}`;
  const { [k]: stored } = await chrome.storage.local.get(k);
  if (stored) sessionId = stored;
  else {
    sessionId = "sc_" + Math.random().toString(36).slice(2, 10);
    await chrome.storage.local.set({ [k]: sessionId });
  }
}

// ---- conversation persistence ----
async function loadConvo(tabId) {
  const { convos = {} } = await chrome.storage.local.get("convos");
  return convos[String(tabId)] || [];
}

async function saveConvo(tabId, msgs) {
  const { convos = {} } = await chrome.storage.local.get("convos");
  convos[String(tabId)] = msgs;
  await chrome.storage.local.set({ convos });
}

function renderConvo(msgs) {
  messagesEl.innerHTML = "";
  for (const m of msgs) {
    if (m.role === "sys")  sysMsg(m.text, { time: m.ts, skipSave: true });
    else if (m.role === "err") errMsg(m.text, { time: m.ts, skipSave: true });
    else append(m.role, m.text, { html: m.html, code: m.code, time: m.ts, skipSave: true });
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- helpers ----
async function append(role, text, opts = {}) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  const body = document.createElement("div");
  body.className = "body";
  if (opts.html) body.innerHTML = opts.html;
  else body.textContent = text;
  el.appendChild(body);
  if (opts.code) {
    const pre = document.createElement("pre");
    pre.textContent = opts.code;
    el.appendChild(pre);
  }
  if (opts.time !== false) {
    const t = document.createElement("span");
    t.className = "meta-time";
    t.textContent = new Date(opts.time || Date.now()).toLocaleTimeString();
    el.appendChild(t);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  if (!opts.skipSave && currentTabId != null) {
    const msgs = await loadConvo(currentTabId);
    msgs.push({
      role, text,
      ts: opts.time || Date.now(),
      html: opts.html, code: opts.code,
    });
    await saveConvo(currentTabId, msgs);
  }
  return el;
}

function sysMsg(text, opts = {}) { return append("sys", text, opts); }
function errMsg(text, opts = {}) { return append("err", text, opts); }

function setConnected(state) {
  wsConnected = state === "connected";
  bridgeState.textContent = state;
  connDot.className = "dot " + (state === "connected" ? "ok" :
                                state === "connecting" ? "warn" : "");
  sendBtn.disabled = !wsConnected && state !== "disconnected";
  // Mark any pending thinking bubble as failed on disconnect
  if (state === "disconnected" && thinkingEl) {
    thinkingEl.classList.add("failed");
    const label = thinkingEl.querySelector("span");
    if (label) label.textContent = "bridge disconnected";
  }
}

function setBusy(b, text) {
  busy.textContent = text || (b ? "agent thinking…" : "idle");
}

// ---- thinking indicator ----
let thinkingEl = null;
let thinkingTimer60 = null;
let thinkingTimer120 = null;

function addThinkingBubble() {
  clearThinkingBubble();
  thinkingEl = document.createElement("div");
  thinkingEl.className = "msg thinking me";
  const body = document.createElement("div");
  body.className = "body";
  const label = document.createElement("span");
  label.textContent = "thinking";
  const dots = document.createElement("span");
  dots.className = "dots";
  dots.textContent = ".";
  body.appendChild(label);
  body.appendChild(document.createTextNode(" "));
  body.appendChild(dots);
  thinkingEl.appendChild(body);
  messagesEl.appendChild(thinkingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  let frame = 0;
  const frames = [".", "..", "...", ".."];
  thinkingEl._dotsTimer = setInterval(() => {
    if (!thinkingEl || !dots.isConnected) return;
    dots.textContent = frames[frame % frames.length];
    frame++;
  }, 350);

  // Extend the timeout as we go — Hermes for editing tasks with multi-turn
  // context can take 60-90s. After 60s, switch the bubble to a "still
  // thinking..." state so the user knows we're not dead.
  thinkingTimer60 = setTimeout(() => {
    if (thinkingEl) {
      const label = thinkingEl.querySelector("span");
      if (label) label.textContent = "still thinking… (long edit task)";
    }
  }, 60000);
  thinkingTimer120 = setTimeout(() => {
    if (thinkingEl) {
      thinkingEl.classList.add("failed");
      const label = thinkingEl.querySelector("span");
      label.textContent = "no response after 120s — bridge may be slow or disconnected";
      clearInterval(thinkingEl._dotsTimer);
    }
  }, 120000);
}

function clearThinkingBubble() {
  if (thinkingTimer60) { clearTimeout(thinkingTimer60); thinkingTimer60 = null; }
  if (thinkingTimer120) { clearTimeout(thinkingTimer120); thinkingTimer120 = null; }
  if (thinkingEl) {
    if (thinkingEl._dotsTimer) clearInterval(thinkingEl._dotsTimer);
    thinkingEl.remove();
    thinkingEl = null;
  }
}

async function refreshTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) tabTitle.textContent = tab.title || tab.url || "—";
    else tabTitle.textContent = "—";
  } catch { tabTitle.textContent = "?"; }
}

async function switchToTab(tabId) {
  if (tabId === currentTabId) return;
  currentTabId = tabId;
  await initSession(tabId);
  const msgs = await loadConvo(tabId);
  renderConvo(msgs);
  if (msgs.length === 0) sysMsg("New conversation for this tab.");
  await refreshTab();
}

async function getPageState() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "SC_GET_PAGE_INFO" });
    if (!r || !r.ok) return null;
    const info = r.info || {};
    return {
      title: info.title,
      url: info.url,
      readyState: info.readyState,
      elementCount: info.elementCount,
      hasShadowDOM: info.hasShadow,
      bodyText: info.bodyText || "",
      links: info.links || [],
    };
  } catch {
    return null;
  }
}

async function send(text) {
  const t = text.trim();
  if (!t) return;
  append("you", t);
  inputEl.value = "";
  inputEl.style.height = "auto";
  setBusy(true, "agent thinking…");
  addThinkingBubble();
  // If disconnected, try to reconnect and wait briefly
  if (!wsConnected) {
    reconnectNow();
    const ok = await waitForConnection(3000);
    if (!ok) {
      clearThinkingBubble();
      errMsg("bridge not connected — check ⚙ settings or that ws_server.py is running");
      setBusy(false);
      return;
    }
  }
  const pageState = await getPageState();
  const envelope = {
    type: "SC_CHAT",
    sessionId,
    from: "user",
    text: t,
    ts: Date.now(),
    pageState,
  };
  if (!wsSend(envelope)) {
    clearThinkingBubble();
    errMsg("send failed — bridge not connected");
    setBusy(false);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Tab change handling
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await switchToTab(tabId);
});

// React to bridgeUrl changes (from settings dialog)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeUrl) {
    wsUrl = changes.bridgeUrl.newValue || null;
    if (ws) { try { ws.close(); } catch {} ws = null; }
    if (wsUrl) {
      reconnectNow();
    } else {
      setConnected("disconnected");
    }
  }
});

// Input handling
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(inputEl.value);
  } else if (e.key === "l" && e.ctrlKey) {
    e.preventDefault();
    if (currentTabId != null) {
      saveConvo(currentTabId, []);
      messagesEl.innerHTML = "";
      sysMsg("Chat cleared for this tab.");
    }
  }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
});
sendBtn.addEventListener("click", () => send(inputEl.value));

// Settings dialog
$("#settings-btn").addEventListener("click", async () => {
  const { bridgeUrl } = await chrome.storage.local.get("bridgeUrl");
  $("#bridge-url").value = bridgeUrl || "";
  $("#settings").classList.remove("hidden");
});
$("#settings-close").addEventListener("click", () => $("#settings").classList.add("hidden"));
$("#bridge-save").addEventListener("click", async () => {
  const url = $("#bridge-url").value.trim();
  await chrome.storage.local.set({ bridgeUrl: url });
  $("#settings").classList.add("hidden");
  sysMsg("Bridge URL saved — reconnecting…");
});
$("#bridge-clear").addEventListener("click", async () => {
  await chrome.storage.local.set({ bridgeUrl: "" });
  $("#settings").classList.add("hidden");
  sysMsg("Bridge URL cleared.");
});

// Boot
(async () => {
  await loadBridgeUrl();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    await switchToTab(tab.id);
  } else {
    sysMsg("No active tab detected.");
  }
  if (wsUrl) connectBridge();
  else setConnected("disconnected");
  inputEl.focus();
})();
