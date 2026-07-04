# Site Control — chat-driven browser control

A Manifest V3 Chromium extension with a **chat popup** that talks to an
agent on this server (over Tailscale). You type, the agent reads and
modifies the page, replies, and asks follow-ups.

```
   ┌───────────────────────────────┐
   │  Site Control · example.com   │  ← popup (400×540)
   │ ─────────────────────────────│
   │ you:  click the blue button   │
   │ me:   on it. clicking now.    │
   │       ▸ SC_CLICK  #btn-submit │
   │ me:   done. fill in email?    │
   │ you:  yes — user@example.com      │
   │ me:   typed and tabbed on.    │
   │ ─────────────────────────────│
   │ [ type a message…        ] ⏎  │
   └───────────────────────────────┘
              │ WebSocket (loopback)
              ▼
        ws://127.0.0.1:7777
              │
              ├─ bridge: ws_server.py
              │
              └─ agent: agent.py
                   └─ LLM (OpenAI-compatible)
                          ↓ tools
                   SC_CLICK, SC_FILL_FORM, …
                          ↓
                   extension (content.js) → page
```

## Install

```bash
# 1. Get the folder
#    Already in ~/git/chromium-extension/chromium-control — no copy needed.

# 2. Load it in Chrome/Brave/Edge
xdg-open https://chrome://extensions
#   → Developer mode ON
#   → "Load unpacked" → select the chromium-control folder
#   → Pin the Site Control icon to your toolbar

# 3. Start the bridge (local-only by default, binds 127.0.0.1)
pip install --break-system-packages websockets
python3 ~/Projects/chromium-control/server/ws_server.py
# writes token to ~/.hermes/site-control-token
# listens on ws://127.0.0.1:7777/control?token=...
```

## Wire the extension to the bridge

Open the **service worker** console (`chrome://extensions` →
Site Control → "service worker" link) and run:

```js
chrome.storage.local.set({
  bridgeUrl: "ws://127.0.0.1:7777/control?token=" + "PASTE_TOKEN" + "&role=extension"
});
```

Get the token from this machine:

```bash
cat ~/.hermes/site-control-token
```

The popup will show `bridge: connected` and `tab: <your active tab>` once
the WebSocket is up. Click the icon to chat.

## How the agent gets its brain

By default, **the agent is Hermes itself** — same model you're talking to
right now. When you type in the popup, `ws_server.py` shells out to
`hermes chat -q "<your message>" -s site-control -m MiniMax-M3 -r <session-id>`.
Hermes responds with SC_* commands; the bridge forwards them to the
extension which executes them on the active tab.

Session state is persisted at `~/.hermes/site-control-session` and
reused across bridge restarts and popup restarts — full context survives.
To start fresh: `rm ~/.hermes/site-control-session`.

The skill that teaches Hermes the protocol lives in
`~/.hermes/skills/site-control/SKILL.md`. It is auto-loaded via
`hermes chat -s site-control`.

### Using a different LLM

If you don't want Hermes as the brain, you can run `agent.py` (legacy)
which talks to any OpenAI-compatible endpoint:

```bash
# Ollama
ollama serve & ollama pull llama3.1
SC_LLM_URL=http://127.0.0.1:11434/v1/chat/completions  SC_LLM_MODEL=llama3.1 \
    python3 ~/Projects/chromium-control/server/agent.py

# OpenAI
SC_LLM_URL=https://api.openai.com/v1/chat/completions  SC_LLM_MODEL=gpt-4o \
SC_LLM_KEY=sk-... \
    python3 ~/Projects/chromium-control/server/agent.py
```

To force legacy mode and disable Hermes-as-responder, just remove or
rename `server/hermes_responder.py` and restart the bridge — it falls
back to forwarding SC_CHAT to controllers as before.

## Run the bridge locally

```bash
pip install --break-system-packages websockets
python3 ~/Projects/chromium-control/server/ws_server.py
# writes token to ~/.hermes/site-control-token
# binds 127.0.0.1:7777 (loopback only — same machine as your browser)

# Optional systemd unit (needs sudo)
sudo cp systemd/site-control.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now site-control.service
```

## Files

```
manifest.json              Manifest V3 (popup = chat.html)
background.js              Service worker: popup ↔ content ↔ bridge
content.js                 Page-side engine (DOM, Shadow DOM, screenshot)
popup/chat.html            Chat popup shell
popup/chat.css             Dark theme
popup/chat.js              UI: input, messages, status indicators
popup/{popup,options}.*    Legacy tabs-based UI (kept for reference)
icons/                     16/32/48/128 toolbar icons
scripts/make_icons.py      Regenerate icons
server/ws_server.py        WebSocket bridge (auto-uses hermes_responder if present)
server/hermes_responder.py Default responder — shells out to `hermes chat`
server/agent.py            Legacy LLM-driven chat agent (any OpenAI-compat endpoint)
server/llm_responder.py    Optional HTTP LLM relay (file-queue backend)
server/ws_client.py        CLI client
server/configure_extension.py  Generate the chrome.storage snippet
systemd/site-control.service   Optional unit
~/.hermes/skills/site-control/SKILL.md  Protocol spec loaded by `hermes chat -s site-control`
~/.hermes/site-control-session         Persistent Hermes session id for this bridge
```

## Agent tools

The LLM can call any of these; each becomes an `SC_*` message that
the extension runs on the active tab.

- `sc_get_page_info` — title, URL, readyState, element count, shadow DOM
- `sc_query_all(selector, limit?)` — find matches + samples
- `sc_query_one(selector)` — first match with attrs
- `sc_click(selector)` — real click (React/Vue aware)
- `sc_set_value(selector, value)` — type into input/select
- `sc_fill_form({selector: value})` — fill multiple fields
- `sc_scroll(selector?) / (x, y, absolute?)` — scroll element or window
- `sc_highlight(selector, duration?)` — flash a selector
- `sc_run_js(expression)` — run arbitrary JS
- `sc_sniff()` — localStorage / sessionStorage / non-httpOnly cookies
- `sc_take_screenshot()` — base64 PNG of the viewport
- `sc_reply(text)` — send a chat message to the user

## Security

- WebSocket traffic stays on loopback (127.0.0.1) — same machine only
- 256-bit URL-safe token in `~/.hermes/site-control-token` (chmod 600)
- Bridge binds `127.0.0.1`, not `0.0.0.0` — no LAN/Tailscale reachability
- Agent never logs/exfiltrates cookies, localStorage, or form values

## Privacy

This setup can take screenshots, read storage, and type into forms. It
should only be used with a browser you own and a user (you) who has
consented. The agent runs locally on this box; nothing is sent to
external services except to whichever LLM endpoint you point it at.