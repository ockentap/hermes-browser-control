// Site Control — chat side panel. All messaging routes through background.js.
// We never talk to the bridge directly from the side panel — that's the SW's job.
//
// Persistence: conversations are stored per-tab in chrome.storage.local under
// the key "convos". Switching tabs loads that tab's history. Sending a message
// appends to the current tab's history AND to the DOM.

const $ = (s) => document.querySelector(s);
const messagesEl = $("#messages");
const inputEl    = $("#input");
const sendBtn    = $("#send-btn");
const bridgeState = $("#bridge-state");
const connDot    = $("#conn-dot");
const tabTitle   = $("#tab-title");
const busy       = $("#busy");

let sessionId = null;
let isConnected = false;
let currentTabId = null;

// ---- session id (per-tab) ----
// Stable for the lifetime of the tab so background.js can route replies back
// even if the side panel is hidden behind another tab.
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
// "convos" maps tabId (number-as-string) -> [{role, text, ts, html?, code?}, ...]
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

  // Persist (unless we're rendering a saved convo)
  if (!opts.skipSave && currentTabId != null) {
    const msgs = await loadConvo(currentTabId);
    msgs.push({
      role,
      text,
      ts: opts.time || Date.now(),
      html: opts.html,
      code: opts.code,
    });
    await saveConvo(currentTabId, msgs);
  }
  return el;
}

function sysMsg(text, opts = {}) { return append("sys", text, opts); }
function errMsg(text, opts = {}) { return append("err", text, opts); }

function setConnected(state) {
  isConnected = state === "connected";
  bridgeState.textContent = state;
  connDot.className = "dot " + (state === "connected" ? "ok" :
                                state === "connecting" ? "warn" : "");
  sendBtn.disabled = !isConnected && state !== "disconnected";
}

function setBusy(b, text) {
  busy.textContent = text || (b ? "agent thinking…" : "idle");
}

// ---- thinking indicator ----
// Animated bubble shown in the chat while waiting for a response.
// Tracks one in-flight bubble at a time; clears it on reply or timeout.
let thinkingEl = null;
let thinkingTimer = null;

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

  // Animate the dots via JS (more reliable than CSS content animation)
  let frame = 0;
  const frames = [".", "..", "...", ".."];
  thinkingEl._dotsTimer = setInterval(() => {
    if (!thinkingEl || !dots.isConnected) return;
    dots.textContent = frames[frame % frames.length];
    frame++;
  }, 350);

  // Timeout — if no reply within 60s, mark as failed
  thinkingTimer = setTimeout(() => {
    if (thinkingEl) {
      thinkingEl.classList.add("failed");
      label.textContent = "no response after 60s — bridge may be slow or disconnected";
      clearInterval(thinkingEl._dotsTimer);
    }
  }, 60000);
}

function clearThinkingBubble() {
  if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
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
    };
  } catch {
    return null;
  }
}

async function send(text) {
  const t = text.trim();
  if (!t) return;
  if (!isConnected) {
    errMsg("bridge not connected — check ⚙ settings");
    return;
  }
  append("you", t);
  inputEl.value = "";
  inputEl.style.height = "auto";
  setBusy(true, "agent thinking…");
  addThinkingBubble();
  try {
    const pageState = await getPageState();
    const r = await chrome.runtime.sendMessage({
      type: "SC_CHAT_SEND",
      sessionId,
      text: t,
      ts: Date.now(),
      pageState,
    });
    if (!r || !r.ok) {
      clearThinkingBubble();
      errMsg("send failed: " + (r?.error || "no response"));
    }
  } catch (e) {
    clearThinkingBubble();
    errMsg("send error: " + (e.message || e));
  } finally {
    setBusy(false);
  }
}

// ---- receive messages from the agent (pushed by background.js) ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SC_CHAT_INCOMING") return;
  // Filter by session: this tab's panel only shows this tab's session replies.
  if (msg.sessionId && msg.sessionId !== sessionId) return;
  // Any incoming reply resolves the thinking bubble
  if (msg.from !== "system") clearThinkingBubble();
  if (msg.from === "me") {
    if (msg.thinking) append("me", msg.text, { html: `<span class="thinking-dots">${escapeHtml(msg.text)}</span>` });
    else if (msg.html) append("me", "", { html: msg.html });
    else append("me", msg.text);
  } else if (msg.from === "system") {
    sysMsg(msg.text);
  } else if (msg.from === "error") {
    errMsg(msg.text);
  } else if (msg.from === "action") {
    append("me", msg.summary || "Action:", { code: JSON.stringify(msg.detail, null, 2) });
  }
  setBusy(false);
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---- bridge status updates ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SC_BRIDGE_STATE") {
    setConnected(msg.state);
    // If bridge drops while we have a pending bubble, mark it failed
    if (msg.state === "disconnected" && thinkingEl) {
      thinkingEl.classList.add("failed");
      const label = thinkingEl.querySelector("span");
      if (label) label.textContent = "bridge disconnected";
    }
  }
});

// ---- tab switch handling ----
// While the side panel is open, switch the visible conversation when the user
// changes tabs in the main browser.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await switchToTab(tabId);
});

// ---- input handling ----
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(inputEl.value);
  } else if (e.key === "l" && e.ctrlKey) {
    e.preventDefault();
    // Clear only the current tab's convo (not all tabs)
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

// ---- settings dialog ----
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

// ---- boot ----
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    await switchToTab(tab.id);
  } else {
    sysMsg("No active tab detected.");
  }
  chrome.runtime.sendMessage({ type: "SC_GET_BRIDGE_STATE" }, (r) => {
    if (r) setConnected(r.state);
  });
})();
