// Injected into every page. Owns the actual DOM interactions.
// Communicates with background.js via chrome.runtime messages.

(() => {
  if (window.__SC_INSTALLED__) return;
  window.__SC_INSTALLED__ = true;

  const HIGHLIGHT_ID = "__sc_highlight__";
  let inspecting = false;
  let lastHoverEl = null;

  // ---- Utilities --------------------------------------------------------

  function safeSelector(s) {
    try { return document.querySelector(s); } catch { return null; }
  }
  function safeAll(s) {
    try { return [...document.querySelectorAll(s)]; } catch { return []; }
  }
  function summarize(el, depth = 2) {
    if (!el) return null;
    function walk(node, d) {
      if (!node || d < 0) return null;
      return {
        tag: node.tagName?.toLowerCase(),
        id: node.id || undefined,
        className: typeof node.className === "string" ? node.className : undefined,
        text: (node.children.length === 0 ? (node.textContent || "").trim().slice(0, 200) : undefined),
        attrs: node.getAttributeNames?.().reduce((a, n) => {
          if (n === "style") return a;
          a[n] = node.getAttribute(n);
          return a;
        }, {}),
        rect: node.getBoundingClientRect ? roundRect(node.getBoundingClientRect()) : undefined,
        children: d > 0 ? [...node.children].slice(0, 20).map((c) => walk(c, d - 1)).filter(Boolean) : undefined,
      };
    }
    return walk(el, depth);
  }
  function roundRect(r) {
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function uniqueSelector(el) {
    if (!el || el === document.documentElement) {
      return el === document.documentElement ? "html" : null;
    }
    if (el === document.body) return "body";
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) {
      return "#" + CSS.escape(el.id);
    }
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += "#" + CSS.escape(cur.id);
        parts.unshift(part);
        break;
      }
      if (cur.className && typeof cur.className === "string") {
        const cls = cur.className.trim().split(/\s+/).filter(Boolean)
          .map((c) => "." + CSS.escape(c)).join("");
        if (cls) part += cls;
      }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) {
          part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }
  function deepQuery(sel) {
    // Search every open shadow root. Returns first match or null.
    function* walk(root) {
      yield* root.querySelectorAll(sel);
      const all = root.querySelectorAll("*");
      for (const n of all) if (n.shadowRoot) yield* walk(n.shadowRoot);
    }
    for (const el of walk(document)) return el;
    return null;
  }
  function deepAll(sel) {
    const out = [];
    function* walk(root) {
      yield* root.querySelectorAll(sel);
      for (const n of root.querySelectorAll("*")) if (n.shadowRoot) yield* walk(n.shadowRoot);
    }
    for (const el of walk(document)) out.push(el);
    return out;
  }

  // ---- Inspector -------------------------------------------------------

  function startInspect() {
    if (inspecting) return;
    inspecting = true;
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }
  function stopInspect() {
    inspecting = false;
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("mouseout", onOut, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    clearHighlight();
  }
  function onOver(e) {
    lastHoverEl = e.target;
    highlight(e.target);
  }
  function onOut(e) {
    if (e.target === lastHoverEl) clearHighlight();
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const sel = uniqueSelector(e.target);
    chrome.runtime.sendMessage({
      type: "SC_INSPECT_RESULT",
      selector: sel,
      text: (e.target.textContent || "").trim().slice(0, 200),
      summary: summarize(e.target, 1),
    });
    stopInspect();
  }
  function onKey(e) {
    if (e.key === "Escape") {
      stopInspect();
      chrome.runtime.sendMessage({ type: "SC_INSPECT_RESULT", cancelled: true });
    }
  }

  // ---- Highlight overlay ----------------------------------------------

  function highlight(el) {
    if (!el) return clearHighlight();
    let box = document.getElementById(HIGHLIGHT_ID);
    if (!box) {
      box = document.createElement("div");
      box.id = HIGHLIGHT_ID;
      box.style.cssText = `
        position: fixed; pointer-events: none; z-index: 2147483647;
        background: rgba(255, 220, 0, 0.2); border: 2px solid #f7c948;
        border-radius: 3px; transition: all 60ms ease-out;
      `;
      const tag = document.createElement("div");
      tag.id = HIGHLIGHT_ID + "_tag";
      tag.style.cssText = `
        position: fixed; pointer-events: none; z-index: 2147483647;
        background: #f7c948; color: #111; font: 11px/1 monospace;
        padding: 2px 6px; border-radius: 3px; max-width: 400px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      `;
      document.documentElement.appendChild(box);
      document.documentElement.appendChild(tag);
    }
    const r = el.getBoundingClientRect();
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    const tag = document.getElementById(HIGHLIGHT_ID + "_tag");
    tag.textContent = uniqueSelector(el);
    tag.style.left = Math.min(r.left, window.innerWidth - 420) + "px";
    tag.style.top = (r.top - 22) + "px";
  }
  function clearHighlight() {
    document.getElementById(HIGHLIGHT_ID)?.remove();
    document.getElementById(HIGHLIGHT_ID + "_tag")?.remove();
  }

  // ---- DOM helpers ----------------------------------------------------

  function setNativeValue(el, value) {
    // Bypass React/Vue by dispatching the right input/change events.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function dispatchClick(el) {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click",     { bubbles: true }));
  }

  // ---- Public: pick under pointer (for context menu) ----------------
  window.__SC__ = window.__SC__ || {};
  window.__SC__.pickUnderPointer = () => {
    const el = document.elementFromPoint(window.__SC_LAST_X__ || 0, window.__SC_LAST_Y__ || 0);
    if (!el) return null;
    return { selector: uniqueSelector(el), text: (el.textContent || "").trim().slice(0, 200) };
  };
  document.addEventListener("contextmenu", (e) => {
    window.__SC_LAST_X__ = e.clientX;
    window.__SC_LAST_Y__ = e.clientY;
  }, true);

  // ---- Screenshot via foreignObject SVG -----------------------------
  async function captureScreenshot() {
    const w = window.innerWidth, h = window.innerHeight;
    const clone = document.documentElement.cloneNode(true);
    // Strip the highlight overlay if any
    clone.querySelectorAll("#" + HIGHLIGHT_ID + ", #" + HIGHLIGHT_ID + "_tag")
         .forEach((n) => n.remove());
    // Resolve relative URLs
    clone.querySelectorAll("img").forEach((img) => {
      try { img.src = new URL(img.getAttribute("src"), location.href).toString(); } catch {}
    });
    clone.querySelectorAll("a").forEach((a) => {
      try { a.href = new URL(a.getAttribute("href"), location.href).toString(); } catch {}
    });
    const xhtml = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <foreignObject width="100%" height="100%">${xhtml}</foreignObject>
    </svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---- Message handlers from background.js ---------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        const out = await dispatch(msg);
        sendResponse({ ok: true, ...out });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  });

  async function dispatch(msg) {
    switch (msg.type) {
      case "SC_GET_PAGE_INFO":
        return {
          info: {
            title: document.title,
            url: location.href,
            readyState: document.readyState,
            frame: window === top,
            elementCount: document.querySelectorAll("*").length,
            hasShadow: !!document.querySelectorAll("*").length && [...document.querySelectorAll("*")].some(n => n.shadowRoot),
          },
        };

      case "SC_QUERY_SELECTOR":
        return { matches: [summarize(deepQuery(msg.selector), 1)] };

      case "SC_QUERY_ALL":
        return { count: msg.limit ? deepAll(msg.selector).slice(0, msg.limit).length : deepAll(msg.selector).length,
                 samples: deepAll(msg.selector).slice(0, 5).map((e) => summarize(e, 0)) };

      case "SC_RUN_JS":
        // eslint-disable-next-line no-new-func
        const fn = new Function("with(this){return (" + msg.expression + "\n)}");
        let value; try { value = fn.call(window); }
        catch (e) { value = "[error: " + (e?.message || e) + "]"; }
        let serialized;
        try {
          serialized = JSON.stringify(value, replacer, 2);
          // eslint-disable-next-line no-eval
          eval;
        } catch (e) {
          serialized = "[unserializable: " + (e?.message || e) + "]";
        }
        return { value: serialized };
        function replacer(_k, v) {
          if (v instanceof Element) return "[Element " + (v.tagName || "") + "]";
          if (v instanceof Window) return "[Window]";
          if (typeof v === "function") return "[Function]";
          if (typeof v === "bigint") return v.toString() + "n";
          if (v && v.nodeType) return "[Node " + v.nodeType + "]";
          return v;
        }

      case "SC_CLICK": {
        const el = deepQuery(msg.selector);
        if (!el) throw new Error("not found: " + msg.selector);
        dispatchClick(el);
        return { clicked: true };
      }

      case "SC_SET_VALUE": {
        const el = deepQuery(msg.selector);
        if (!el) throw new Error("not found: " + msg.selector);
        if (el.tagName === "SELECT") el.value = msg.value;
        else setNativeValue(el, String(msg.value));
        return { set: true };
      }

      case "SC_FILL_FORM": {
        const results = {};
        for (const [sel, val] of Object.entries(msg.values || {})) {
          const el = deepQuery(sel);
          if (!el) { results[sel] = "not-found"; continue; }
          if (el.tagName === "SELECT") el.value = val;
          else setNativeValue(el, String(val));
          results[sel] = "ok";
        }
        return { results };
      }

      case "SC_SCROLL": {
        if (msg.selector) {
          const el = deepQuery(msg.selector);
          if (!el) throw new Error("not found: " + msg.selector);
          el.scrollIntoView({ behavior: "smooth", block: msg.block || "center" });
          return { scrolled: "element" };
        }
        const x = msg.x || 0, y = msg.y || 0;
        if (msg.absolute) window.scrollTo({ top: y, left: x, behavior: "smooth" });
        else window.scrollBy({ top: y, left: x, behavior: "smooth" });
        return { scrolled: "window", at: { x: window.scrollX, y: window.scrollY } };
      }

      case "SC_HIGHLIGHT": {
        if (msg.selector) {
          const el = deepQuery(msg.selector);
          if (!el) throw new Error("not found: " + msg.selector);
          el.scrollIntoView({ block: "center" });
          highlight(el);
          setTimeout(clearHighlight, msg.duration || 1500);
        } else clearHighlight();
        return { highlighted: !!msg.selector };
      }

      case "SC_INSPECT_START": startInspect(); return { inspecting: true };
      case "SC_INSPECT_STOP":  stopInspect();   return { inspecting: false };
      case "SC_PICK_UNDER": {
        const el = document.elementFromPoint(msg.x, msg.y);
        return el ? { selector: uniqueSelector(el), rect: roundRect(el.getBoundingClientRect()) } : { selector: null };
      }

      case "SC_SNIFF": {
        return {
          meta: {
            title: document.title, url: location.href, referrer: document.referrer,
            cookies: document.cookie,  // may be empty due to httpOnly
            localStorage: safeLs(),
            sessionStorage: safeSession(),
          },
        };
        function safeLs() { try { return { ...localStorage }; } catch { return {}; } }
        function safeSession() { try { return { ...sessionStorage }; } catch { return {}; } }
      }

      case "SC_SCREENSHOT": {
        // Use html2canvas-style approach: serialize the viewport via a
        // foreignObject SVG, then export. Falls back to nothing if not possible.
        try {
          const dataUrl = await captureScreenshot();
          if (!dataUrl) throw new Error("capture failed");
          // strip the data:image/png;base64, prefix
          const b64 = dataUrl.split(",")[1] || "";
          return { imageBase64: b64, width: window.innerWidth, height: window.innerHeight };
        } catch (e) {
          return { error: String(e?.message || e) };
        }
      }

      default:
        throw new Error("content got unknown type: " + msg.type);
    }
  }
})();
