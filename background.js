// Background service worker — thin relay between the side panel and content
// scripts. The side panel owns the WebSocket to the bridge directly (the SW
// can't keep a long-lived WS in MV3 — it gets torn down after ~30s of idle,
// which is shorter than a typical LLM response).
//
// Flow:
//   side panel  <-> content script   (chrome.runtime.sendMessage relayed here)
//   side panel  -- WS -->  bridge    (direct, owned by popup/chat.js)

chrome.runtime.onInstalled.addListener(() => {
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
});

// Toolbar icon click — open the side panel for the active window.
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
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.__SC__?.pickUnderPointer?.() || null,
    });
    if (result?.selector) {
      await chrome.storage.local.set({ lastSelector: result.selector });
    }
  }
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (cmd === "_execute_action") return;
  if (cmd === "run-selector") await runLastSelector(tab.id);
});

// --- Helpers ------------------------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runLastSelector(tabId) {
  const { lastSelector } = await chrome.storage.local.get("lastSelector");
  const sel = lastSelector;
  if (!sel) return { ok: false, error: "no saved selector" };
  return sendToTab(tabId, { type: "SC_QUERY_SELECTOR", selector: sel });
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

// --- Relay: side panel <-> content script ------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch((err) =>
    sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // async
});

async function handle(msg, sender) {
  // Commands the side panel sends — route to the active tab's content script.
  // The result is returned to the side panel.
  const SC_TO_CONTENT = new Set([
    "SC_QUERY_SELECTOR", "SC_QUERY_ONE", "SC_QUERY_ALL", "SC_RUN_JS",
    "SC_CLICK", "SC_SET_VALUE", "SC_FILL_FORM", "SC_SCROLL",
    "SC_HIGHLIGHT", "SC_INSPECT_START", "SC_INSPECT_STOP", "SC_PICK_UNDER",
    "SC_SNIFF", "SC_GET_PAGE_INFO", "SC_SCREENSHOT",
  ]);

  if (SC_TO_CONTENT.has(msg.type)) {
    const tab = await activeTab();
    if (!tab?.id) return { ok: false, error: "no active tab" };
    if (!tab.url || /^chrome:|^edge:|^about:/.test(tab.url)) {
      return { ok: false, error: "cannot run on " + tab.url };
    }
    return sendToTab(tab.id, msg);
  }

  // Side-panel-only operations (no content script involvement)
  switch (msg.type) {
    case "SC_SAVE_SELECTOR": {
      await chrome.storage.local.set({ lastSelector: msg.selector });
      return { ok: true };
    }
    case "SC_INSPECT_RESULT": {
      if (msg.selector) {
        await chrome.storage.local.set({ lastSelector: msg.selector });
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown message type: " + msg.type };
  }
}
