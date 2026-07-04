# Site Control — Setup

A Manifest V3 Chromium extension + WebSocket bridge that lets you control any
webpage via natural-language chat. The "LLM" is **Hermes itself** — same model
you're talking to right now. Everything runs locally on your machine.

```
   ┌───────────────────────────────┐
   │  Site Control · example.com   │  ← side panel (right edge)
   │ ─────────────────────────────│
   │ you:  click the blue button   │
   │ me:   on it. clicking now.    │
   │       ▸ SC_CLICK  #btn-submit │
   │ me:   done. fill in email?    │
   │ you:  yes — user@example.com  │
   │ me:   typed and tabbed on.    │
   │ [ thinking... ]               │
   │ ─────────────────────────────│
   │ [ type a message…        ] ⏎  │
   └───────────────────────────────┘
              │ WebSocket (loopback)
              ▼
        ws://127.0.0.1:7777
              │
              ├─ bridge: ws_server.py
              │
              └─ hermes chat -s site-control -m MiniMax-M3
                 (Hermes session id persisted at
                  ~/.hermes/site-control-session)
                          ↓ tools
                   SC_CLICK, SC_FILL_FORM, …
                          ↓
                   extension (content.js) → page
```

## What it does

You type in the side panel; the bridge shells out to `hermes chat` with the
active tab's page state prepended; Hermes responds with SC_* commands; the
extension executes them on the page. Conversation history persists per-tab.

## Prerequisites

- **Python 3.10+** with `websockets` (`pip install websockets`)
- **Hermes CLI** on your `PATH` (`which hermes` should print something)
- **Chromium** (or Chrome / Brave / Edge — anything MV3-compatible)

## Install

### 1. Get the code

```bash
git clone <your-repo-url> site-control
cd site-control
```

(or just copy the folder to wherever you keep projects)

### 2. Install Python dependency

```bash
pip install --break-system-packages websockets
```

(omit `--break-system-packages` if you're in a venv)

### 3. Start the bridge

```bash
python3 server/ws_server.py
```

You'll see:
```
TOKEN=<long-random-string>
EXT_URL=ws://127.0.0.1:7777/control?token=<TOKEN>&role=extension
CTRL_URL=ws://127.0.0.1:7777/control?token=<TOKEN>&role=controller
```

The token is also written to `~/.hermes/site-control-token` (chmod 600).
The bridge binds `127.0.0.1:7777` only — not reachable from the network.

Leave this terminal open. To run as a background service, see
[Running as a service](#running-as-a-service) below.

### 4. Load the extension in your browser

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`, etc.)
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked** → select the `site-control/` folder
4. Find **Site Control** in the list and note the **service worker** link
   under "Inspect views" — you'll need the console in step 5

### 5. Wire the extension to the bridge

In the service-worker DevTools console, paste:

```js
chrome.storage.local.set({
  bridgeUrl: "ws://127.0.0.1:7777/control?token=<TOKEN>&role=extension"
});
```

Replace `<TOKEN>` with the value from step 3 (or `cat ~/.hermes/site-control-token`).

Expected: returns `undefined` (success).

### 6. Open the side panel

Click the **Site Control** toolbar icon. The side panel slides in from the
right. The status line should show `bridge: connected` within a second.

Open any website, type a message, hit Enter. You'll see a `thinking ...`
bubble while the bot works, then a reply.

## Configuration

The extension reads `bridgeUrl` from `chrome.storage.local`. You can change
it at any time via the ⚙ button in the side panel header, or from the
service-worker console:

```js
chrome.storage.local.set({ bridgeUrl: "<new-url>" });
```

To force a fresh conversation (forget context), delete the Hermes session
file and restart the bridge:

```bash
rm ~/.hermes/site-control-session
```

## Running as a service

A systemd user unit template is at `systemd/site-control.service`. To install:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/site-control.service ~/.config/systemd/user/
# Edit the unit: fix WorkingDirectory and ExecStart to point at your checkout
systemctl --user daemon-reload
systemctl --user enable --now site-control.service
loginctl enable-linger $USER   # so it survives logout
```

Check status / logs:

```bash
systemctl --user status site-control
journalctl --user -u site-control -f
```

## Using a different LLM (optional)

By default the bridge calls `hermes chat -m MiniMax-M3`. To use a different
LLM endpoint, run the legacy agent:

```bash
SC_LLM_URL=http://127.0.0.1:11434/v1/chat/completions \
SC_LLM_MODEL=llama3.1 \
    python3 server/agent.py
```

The bridge auto-detects `hermes_responder.py` and uses it. To force legacy
mode, rename or remove `server/hermes_responder.py` and restart the bridge
— it falls back to forwarding SC_CHAT to controllers.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Side panel shows `bridge: disconnected` | `bridgeUrl` missing or wrong | Re-run step 5 with the correct token |
| `bridge not connected — check ⚙ settings` | Same as above, or bridge crashed | Check the bridge terminal for errors; restart it |
| Reply never comes, red `no response after 60s` | Hermes CLI not on PATH or stuck | `which hermes`; restart bridge |
| Thinking bubble says `bridge disconnected` mid-reply | WS dropped | Check bridge terminal; side panel auto-reconnects |
| `ModuleNotFoundError: No module named 'websockets'` | pip installed to wrong Python | `python3 -m pip install --break-system-packages websockets` |
| `python3` is from linuxbrew, no `websockets` | Two Pythons on system | `python3 -m pip install --break-system-packages websockets` |

Bridge log: `tail -F ~/.hermes/logs/site-control-server.log`

## Files

```
manifest.json              Manifest V3 (side panel = chat.html)
background.js              Service worker: side panel ↔ content ↔ bridge
content.js                 Page-side engine (DOM, Shadow DOM, screenshot)
popup/chat.html            Side panel shell
popup/chat.css             Dark theme
popup/chat.js              UI: input, messages, status, per-tab persistence
icons/                     16/32/48/128 toolbar icons
scripts/make_icons.py      Regenerate icons
server/ws_server.py        WebSocket bridge (auto-uses hermes_responder)
server/hermes_responder.py Default responder — shells out to `hermes chat`
server/agent.py            Legacy LLM-driven chat agent (any OpenAI-compat)
server/llm_responder.py    Optional HTTP LLM relay (file-queue backend)
server/ws_client.py        CLI client
server/configure_extension.py  Generate the chrome.storage snippet
systemd/site-control.service   Optional systemd unit
~/.hermes/skills/site-control/SKILL.md  Protocol spec auto-loaded by `hermes chat -s site-control`
~/.hermes/site-control-session         Persistent Hermes session id
~/.hermes/site-control-token           Bridge auth token (chmod 600)
```

## How the agent learns the protocol

`server/hermes_responder.py` runs `hermes chat -s site-control -m MiniMax-M3`,
which auto-loads `~/.hermes/skills/site-control/SKILL.md`. That file
documents every SC_* command the extension supports and the response format
Hermes should use.

If you add a new command type:
1. Add the handler in `content.js` `dispatch(msg)`
2. Add it to `popup/chat.js` `runOnActive` switch
3. Document it in `~/.hermes/skills/site-control/SKILL.md`

## Security

- WebSocket binds `127.0.0.1` only — not reachable from the network
- 256-bit URL-safe token in `~/.hermes/site-control-token` (chmod 600)
- Extension has `host_permissions: ["<all_urls>"]` so content scripts can run
  on any page — be aware that any page you visit can inject `<script>` that
  reads the DOM, but cannot exfiltrate (no network endpoint reachable from
  the extension)
- Agent runs locally; nothing is sent to remote LLM endpoints unless you
  set `SC_LLM_URL` to one
