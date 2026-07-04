// Popup logic. All actions go via chrome.runtime.sendMessage -> background.js.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let busy = false;
async function send(msg) {
  busy = true; setStatus("working…");
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res) throw new Error("no response (background not running)");
    return res;
  } catch (e) {
    show("#page-result, #js-result, #inspect-result", { ok: false, error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  } finally {
    busy = false; setStatus("idle");
  }
}

function setStatus(s) { $("#status").textContent = s; }
function show(targetSel, payload) {
  const el = $(targetSel);
  if (!el) return;
  el.classList.toggle("ok",  payload?.ok === true);
  el.classList.toggle("err", payload?.ok === false);
  el.textContent = JSON.stringify(payload, null, 2);
}

// ---- Tabs --------------------------------------------------------------
$$(".tab").forEach((b) => b.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.remove("active"));
  $$(".panel").forEach((p) => p.classList.remove("active"));
  b.classList.add("active");
  $("#panel-" + b.dataset.tab).classList.add("active");
}));

// ---- Restore saved state -----------------------------------------------
(async function init() {
  const state = await send({ type: "SC_GET_STATE" });
  if (state.ok) {
    if (state.lastSelector) $("#interact-sel").value = state.lastSelector;
    if (state.lastExpression) $("#js-expr").value = state.lastExpression;
    renderHistory(state.recent || []);
  }
})();

// ---- Interact panel ----------------------------------------------------
$("#interact-save").addEventListener("click", async () => {
  const sel = $("#interact-sel").value.trim();
  if (!sel) return;
  const r = await send({ type: "SC_SAVE_SELECTOR", selector: sel });
  if (r.ok) flashStatus("selector saved");
});

$$('[data-action="click"]').forEach((b) => b.addEventListener("click", () => {
  const sel = $("#interact-sel").value.trim();
  if (!sel) return;
  send({ type: "SC_CLICK", selector: sel });
}));
$$('[data-action="highlight"]').forEach((b) => b.addEventListener("click", () => {
  const sel = $("#interact-sel").value.trim();
  if (!sel) return;
  send({ type: "SC_HIGHLIGHT", selector: sel, duration: 2000 });
}));
$$('[data-action="scroll-into"]').forEach((b) => b.addEventListener("click", () => {
  const sel = $("#interact-sel").value.trim();
  if (!sel) return;
  send({ type: "SC_SCROLL", selector: sel });
}));
$$('[data-action="query-one"]').forEach((b) => b.addEventListener("click", async () => {
  const sel = $("#interact-sel").value.trim();
  if (!sel) return;
  const r = await send({ type: "SC_QUERY_SELECTOR", selector: sel });
  show("#page-result", r);
}));
$$('[data-action="query-all"]').forEach((b) => b.addEventListener("click", async () => {
  const sel = $("#interact-sel").value.trim();
  if (!sel) return;
  const r = await send({ type: "SC_QUERY_ALL", selector: sel, limit: 50 });
  show("#page-result", r);
}));
$$('[data-action="set-value"]').forEach((b) => b.addEventListener("click", () => {
  const sel = $("#interact-sel").value.trim();
  const v   = $("#interact-val").value;
  if (!sel) return;
  send({ type: "SC_SET_VALUE", selector: sel, value: v });
}));
$$('[data-action="fill-form"]').forEach((b) => b.addEventListener("click", async () => {
  let values; try { values = JSON.parse($("#interact-form").value); }
  catch (e) { show("#page-result", { ok: false, error: "invalid JSON" }); return; }
  const r = await send({ type: "SC_FILL_FORM", values });
  show("#page-result", r);
}));
$$('[data-action="scroll"]').forEach((b) => b.addEventListener("click", () => {
  send({ type: "SC_SCROLL", x: +$("#interact-sx").value, y: +$("#interact-sy").value });
}));
$$('[data-action="scroll-top"]').forEach((b) => b.addEventListener("click", () => {
  send({ type: "SC_SCROLL", x: 0, y: 0, absolute: true });
}));

// ---- Inspect panel -----------------------------------------------------
$("#inspect-start").addEventListener("click", () => {
  send({ type: "SC_INSPECT_START" }).then((r) => flashStatus(r.ok ? "pick an element…" : r.error));
  window.close();
});
$("#inspect-stop").addEventListener("click", () => send({ type: "SC_INSPECT_STOP" }));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SC_INSPECT_RESULT") return;
  if (msg.cancelled) { flashStatus("inspect cancelled"); return; }
  $("#interact-sel").value = msg.selector || "";
  $("#inspect-result").textContent = JSON.stringify(msg, null, 2);
  flashStatus("picked → " + msg.selector);
});

// ---- JS panel ----------------------------------------------------------
$$('[data-action="js-run"]').forEach((b) => b.addEventListener("click", async () => {
  const expr = $("#js-expr").value;
  const r = await send({ type: "SC_RUN_JS", expression: expr });
  show("#js-result", r);
  await chrome.storage.local.set({ lastExpression: expr });
}));
$$('[data-action="js-save"]').forEach((b) => b.addEventListener("click", async () => {
  await chrome.storage.local.set({ lastExpression: $("#js-expr").value });
  flashStatus("expression saved");
}));
$$('[data-action="js-load"]').forEach((b) => b.addEventListener("click", async () => {
  const { lastExpression } = await chrome.storage.local.get("lastExpression");
  if (lastExpression) $("#js-expr").value = lastExpression;
}));

// ---- Page panel --------------------------------------------------------
$$('[data-action="page-info"]').forEach((b) => b.addEventListener("click", async () => {
  const r = await send({ type: "SC_GET_PAGE_INFO" });
  show("#page-result", r);
}));
$$('[data-action="page-sniff"]').forEach((b) => b.addEventListener("click", async () => {
  const r = await send({ type: "SC_SNIFF" });
  show("#page-result", r);
}));
$$('[data-action="page-reload"]').forEach((b) => b.addEventListener("click", () => {
  chrome.tabs.reload();
}));

// ---- History panel -----------------------------------------------------
function renderHistory(items) {
  const list = $("#hist-list");
  list.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    const t = new Date(it.at).toLocaleTimeString();
    li.innerHTML = `<time>${t} · ${it.kind}</time>` +
                   JSON.stringify({ ...it, at: undefined, kind: undefined });
    list.appendChild(li);
  }
}
$("#hist-clear").addEventListener("click", () => renderHistory([]));

// ---- Misc --------------------------------------------------------------
let statusTimer;
function flashStatus(s) {
  setStatus(s);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => setStatus("idle"), 2000);
}