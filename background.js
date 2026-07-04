// Background service worker — brokers messages between popup, content scripts,
// and the WebSocket bridge at ws://127.0.0.1:7777/control.
//
// Flow:
//   popup    <-> background   (chrome.runtime.sendMessage)
//   content  <-> background   (chrome.tabs.sendMessage)
//   server   <-> background   (WebSocket, auto-reconnect)

const STATE = {
  lastSelector: null,
  lastExpression: null,
  recent: [],   // last N actions for the history panel
  ws: null,
  wsBackoff: 1000,
  wsConnected: false,
};

// --- Lifecycle -----------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: "sc-run-selector",
    title: "Site Control: run last selector",
    contexts: ["all"],
  });
  chrome.contextMenus.create({
    id: "sc-save-element",
    title: "Site Control: save selected element as last selector",
    contexts: ["all"],
  });
  // Connect to the bridge if the user has configured one.
  await connectBridge();
});

chrome.runtime.onStartup.addListener(connectBridge);

// Toolbar icon click — open the side panel for the active window. Without
// this listener the icon does nothing (no default_popup set anymore).
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.error("sidePanel.open failed:", e);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "sc-run-selector") {
    await runLastSelector(tab.id);
  } else if (info.menuItemId === "sc-save-element") {
    // Use the element under the right-click. We just re-run a fresh inspect
    // request so the popup can pick it up; storing happens via chrome.storage.
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.__SC__?.pickUnderPointer?.() || null,
    });
    if (result?.selector) {
      await chrome.storage.local.set({ lastSelector: result.selector });
      STATE.lastSelector = result.selector;
    }
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (cmd === "_execute_action") return; // popup handles itself
  if (cmd === "run-selector") await runLastSelector(tab.id);
});

// --- Helpers -------------------------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function recordRecent(entry) {
  STATE.recent.unshift({ at: Date.now(), ...entry });
  STATE.recent = STATE.recent.slice(0, 25);
}

async function runLastSelector(tabId) {
  const { lastSelector } = await chrome.storage.local.get("lastSelector");
  const sel = lastSelector || STATE.lastSelector;
  if (!sel) return { ok: false, error: "no saved selector" };
  return sendToTab(tabId, { type: "SC_QUERY_SELECTOR", selector: sel });
}

// --- Message routing -----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((err) =>
    sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // async
});

async function handle(msg, sender) {
  switch (msg.type) {
    // ---- popup -> tab ------------------------------------------------
    case "SC_QUERY_SELECTOR":    return runOnActive("SC_QUERY_SELECTOR", msg);
    case "SC_QUERY_ALL":         return runOnActive("SC_QUERY_ALL", msg);
    case "SC_RUN_JS":            return runOnActive("SC_RUN_JS", msg);
    case "SC_CLICK":             return runOnActive("SC_CLICK", msg);
    case "SC_SET_VALUE":         return runOnActive("SC_SET_VALUE", msg);
    case "SC_FILL_FORM":         return runOnActive("SC_FILL_FORM", msg);
    case "SC_SCROLL":            return runOnActive("SC_SCROLL", msg);
    case "SC_HIGHLIGHT":         return runOnActive("SC_HIGHLIGHT", msg);
    case "SC_INSPECT_START":     return runOnActive("SC_INSPECT_START", msg);
    case "SC_INSPECT_STOP":      return runOnActive("SC_INSPECT_STOP", msg);
    case "SC_PICK_UNDER":        return runOnActive("SC_PICK_UNDER", msg);
    case "SC_SNIFF":             return runOnActive("SC_SNIFF", msg);
    case "SC_GET_PAGE_INFO":     return runOnActive("SC_GET_PAGE_INFO", msg);
    case "SC_SCREENSHOT":        return runOnActive("SC_SCREENSHOT", msg);

    // ---- popup -> popup ----------------------------------------------
    case "SC_SAVE_SELECTOR": {
      await chrome.storage.local.set({ lastSelector: msg.selector });
      STATE.lastSelector = msg.selector;
      return { ok: true };
    }

    // ---- popup -> server (chat) -------------------------------------
    case "SC_CHAT_SEND": {
      if (!STATE.wsConnected || !STATE.ws) {
        return { ok: false, error: "bridge not connected" };
      }
      const envelope = {
        type: "SC_CHAT",
        sessionId: msg.sessionId,
        from: "user",
        text: msg.text,
        ts: msg.ts || Date.now(),
      };
      if (msg.pageState) envelope.pageState = msg.pageState;
      try {
        STATE.ws.send(JSON.stringify(envelope));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: "send failed: " + (e.message || e) };
      }
    }

    case "SC_GET_BRIDGE_STATE": {
      return { ok: true, state: STATE.wsConnected ? "connected" :
                              STATE.ws ? "connecting" : "disconnected" };
    }
    case "SC_GET_STATE": {
      const { lastSelector, lastExpression } = await chrome.storage.local.get(
        ["lastSelector", "lastExpression"]
      );
      return {
        ok: true,
        lastSelector: lastSelector || STATE.lastSelector,
        lastExpression: lastExpression || STATE.lastExpression,
        recent: STATE.recent,
      };
    }

    // ---- tab -> popup (pushed from content.js) -----------------------
    case "SC_INSPECT_RESULT": {
      if (msg.selector) {
        await chrome.storage.local.set({ lastSelector: msg.selector });
        STATE.lastSelector = msg.selector;
      }
      recordRecent({ kind: "inspect", selector: msg.selector, text: msg.text });
      return { ok: true };
    }

    default:
      return { ok: false, error: "unknown message type: " + msg.type };
  }
}

async function runOnActive(type, payload) {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, error: "no active tab" };
  if (!tab.url || /^chrome:|^edge:|^about:/.test(tab.url)) {
    return { ok: false, error: "cannot run on " + tab.url };
  }
  const res = await sendToTab(tab.id, { type, ...payload });
  recordRecent({ kind: type, ...payload, result: res });
  return res;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Content script not loaded yet (e.g. after navigation). Inject it.
    if (
      message.type !== "SC_INSPECT_START" &&
      message.type !== "SC_INSPECT_STOP"
    ) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (e2) {
        return { ok: false, error: "inject failed: " + (e2.message || e2) };
      }
    }
    return { ok: false, error: "no receiver: " + (e.message || e) };
  }
}

// Save last JS expression so the popup can re-run it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.lastExpression) STATE.lastExpression = changes.lastExpression.newValue;
  if (changes.bridgeUrl) {
    // URL changed — reconnect.
    if (STATE.ws) { try { STATE.ws.close(); } catch {} }
    connectBridge();
  }
});

// --- WebSocket bridge ---------------------------------------------------

async function connectBridge() {
  const { bridgeUrl, bridgeEnabled } = await chrome.storage.local.get(
    ["bridgeUrl", "bridgeEnabled"]
  );
  if (bridgeEnabled === false) {
    log("bridge disabled");
    return;
  }
  if (!bridgeUrl) {
    log("no bridgeUrl configured — set it via chrome.storage.local or the popup options");
    return;
  }
  if (STATE.ws) {
    try { STATE.ws.close(); } catch {}
    STATE.ws = null;
  }
  log("connecting to", bridgeUrl);
  let ws;
  try {
    ws = new WebSocket(bridgeUrl);
  } catch (e) {
    log("WS construct failed:", e.message);
    scheduleReconnect();
    return;
  }
  STATE.ws = ws;

  ws.addEventListener("open", async () => {
    STATE.wsConnected = true;
    STATE.wsBackoff = 1000;
    log("bridge connected");
    broadcastBridgeState("connected");
    const tabs = await chrome.tabs.query({});
    ws.send(JSON.stringify({ type: "REGISTER", role: "extension", tabCount: tabs.length }));
  });

  ws.addEventListener("message", async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }

    // Server -> extension protocol: WELCOME, server-issued commands, PING, etc.
    if (msg.type === "WELCOME") return;
    if (msg.type === "PING") {
      try { ws.send(JSON.stringify({ type: "PONG", t: Date.now() })); } catch {}
      return;
    }
    // Anything else: treat as a command to run against the active tab.
    if (!msg.id) msg.id = cryptoRandomId();

    // Chat messages from the server side go straight to the popup, do not
    // hit the content script.
    if (msg.type === "SC_CHAT") {
      const payload = {
        type: "SC_CHAT_INCOMING",
        sessionId: msg.sessionId,
        from: msg.from || "me",
        text: msg.text || "",
        html: msg.html,
        thinking: msg.thinking,
        summary: msg.summary,
        detail: msg.detail,
        ts: msg.ts || Date.now(),
      };
      try {
        await chrome.runtime.sendMessage(payload);
        ws.send(JSON.stringify({ id: msg.id, ok: true, delivered: true }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: "no popup open: " + (e.message || e) }));
      }
      return;
    }

    const result = await runOnActive(msg.type, msg);
    try {
      ws.send(JSON.stringify({ id: msg.id, ...result }));
    } catch (e) {
      log("failed to send result:", e.message);
    }
  });

  ws.addEventListener("close", () => {
    STATE.wsConnected = false;
    STATE.ws = null;
    log("bridge disconnected, will reconnect in", STATE.wsBackoff, "ms");
    broadcastBridgeState("disconnected");
    scheduleReconnect();
  });

  ws.addEventListener("error", (e) => {
    log("bridge error:", e.message || e);
    broadcastBridgeState("connecting");
  });
}

function broadcastBridgeState(state) {
  chrome.runtime.sendMessage({ type: "SC_BRIDGE_STATE", state }).catch(() => {});
}

function scheduleReconnect() {
  STATE.wsBackoff = Math.min(STATE.wsBackoff * 2, 30000);
  setTimeout(connectBridge, STATE.wsBackoff);
}

function cryptoRandomId() {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

function log(...args) {
  console.log("[site-control]", ...args);
  // Persist last few log lines so the popup can show them.
  chrome.storage?.local?.get({ logs: [] }, ({ logs }) => {
    logs.push({ t: Date.now(), line: args.map(String).join(" ") });
    while (logs.length > 50) logs.shift();
    chrome.storage.local.set({ logs });
  });
}
