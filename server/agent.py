#!/usr/bin/env python3
"""
Site Control — chat agent.

Connects to the bridge as a controller. Receives SC_CHAT envelopes from the
extension popup, asks an LLM what to do, and sends replies back. Replies can
be either:
  - plain text:  {"type":"SC_CHAT","from":"me","text":"..."}
  - DOM action: {"type":"SC_CLICK","selector":"#submit"}

The LLM is called via the OpenAI-compatible HTTP API. Set SC_LLM_URL and
SC_LLM_MODEL in the environment, or use the defaults (this server already
runs minimax locally).

Run:
  python3 server/agent.py
  python3 server/agent.py --once          # one-shot mode
  python3 server/agent.py --model m2.7    # pick a model
"""
import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode, urlparse

import websockets
from websockets.exceptions import ConnectionClosed

# --- config -----------------------------------------------------------

BRIDGE_HOST = os.environ.get("SC_BRIDGE_HOST", "127.0.0.1")
BRIDGE_PORT = int(os.environ.get("SC_BRIDGE_PORT", "7777"))
TOKEN_FILE  = Path.home() / ".hermes" / "site-control-token"

LLM_URL    = os.environ.get("SC_LLM_URL",   "http://127.0.0.1:11434/v1/chat/completions")
LLM_MODEL  = os.environ.get("SC_LLM_MODEL", "MiniMax-M3")
LLM_KEY    = os.environ.get("SC_LLM_KEY",   "")  # optional bearer

# Tools the agent can call. These are SC_* message types the bridge forwards
# to the extension, which runs them on the active tab.
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "sc_get_page_info",
            "description": "Read the active tab's title, URL, readyState, element count, and whether it has shadow DOM. Call first when you need to know what page you're on.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_query_all",
            "description": "Find all elements matching a CSS selector. Returns count + up to 5 sample summaries (tag, id, class, text, rect).",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string", "description": "CSS selector"},
                    "limit":    {"type": "integer", "default": 20},
                },
                "required": ["selector"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_query_one",
            "description": "Find the first element matching a CSS selector. Returns full summary with attrs and bounding rect.",
            "parameters": {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
                "required": ["selector"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_click",
            "description": "Click an element by CSS selector. Fires a real mousedown/mouseup/click so React etc. respond.",
            "parameters": {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
                "required": ["selector"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_set_value",
            "description": "Set the value of an input/textarea/select. Triggers input + change events so React/Vue detect it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "value":    {"type": "string"},
                },
                "required": ["selector", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_fill_form",
            "description": "Fill multiple form fields at once. values is {selector: value}.",
            "parameters": {
                "type": "object",
                "properties": {
                    "values": {
                        "type": "object",
                        "additionalProperties": {"type": "string"},
                        "description": "{selector: value}",
                    },
                },
                "required": ["values"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_scroll",
            "description": "Scroll the window (by x/y pixels, or absolute) or scroll an element into view.",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "x": {"type": "number", "default": 0},
                    "y": {"type": "number", "default": 0},
                    "absolute": {"type": "boolean", "default": False},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_highlight",
            "description": "Visually highlight all elements matching a selector for a few seconds. Useful for confirming what the agent is about to act on.",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "duration": {"type": "integer", "default": 2000},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_run_js",
            "description": "Run an arbitrary JavaScript expression in the page. The return value is JSON-serialized. Use for scraping, computed values, anything that isn't a simple selector.",
            "parameters": {
                "type": "object",
                "properties": {"expression": {"type": "string"}},
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_sniff",
            "description": "Read the page's localStorage, sessionStorage, and non-httpOnly cookies. Use to inspect app state.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_take_screenshot",
            "description": "Capture a PNG of the visible viewport. Returns base64 data you can describe or summarize for the user.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sc_reply",
            "description": "Send a chat message back to the user. Use this to narrate what you're doing, ask clarifying questions, or report results. text may contain simple markdown (the popup renders **bold**, `code`, and newlines).",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Markdown-ish text shown in the chat"},
                },
                "required": ["text"],
            },
        },
    },
]

SYSTEM_PROMPT = """You are Site Control, an agent that lives inside a Chromium extension popup. The user is looking at a web page and can see the same things you can. You can call tools to inspect and modify that page.

Rules:
- Be concise. One or two sentences per reply, no fluff.
- When you take a destructive or visible action (click, type, scroll, fill form), narrate it briefly first ("clicking submit…") so the user can see what's happening.
- Always confirm results: "done", "filled", "clicked".
- If a selector doesn't match, try a broader one or call sc_query_all to discover the right selector.
- The active tab is whatever the user is currently looking at. Use sc_get_page_info first if you're unsure what page you're on.
- Never exfiltrate credentials, tokens, or session secrets. Treat localStorage, cookies, and form values as sensitive — never print them verbatim to chat.
- You are running on a private Tailscale network. The user trusts you with their browser."""

# --- llm client ------------------------------------------------------

import urllib.request, urllib.error
import hashlib, hmac

# LLM is "me" — the running agent in this very Hermes session. We hand off
# requests via a simple signed file-based queue. The agent's session_search
# (or a watcher) picks them up, generates a response, and writes it back.
#
# Override with SC_LLM_URL / SC_LLM_MODEL to use a real OpenAI-compatible
# endpoint instead (Ollama, vLLM, OpenAI, etc.).
SC_USE_FILE_QUEUE = os.environ.get("SC_LLM_BACKEND", "file") == "file"
SC_QUEUE_DIR     = Path(os.environ.get("SC_QUEUE_DIR", "/tmp/sc-llm-queue"))

if SC_USE_FILE_QUEUE:
    SC_QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    (SC_QUEUE_DIR / "inbox").mkdir(exist_ok=True)
    (SC_QUEUE_DIR / "outbox").mkdir(exist_ok=True)


def _sign(payload: bytes) -> str:
    import hmac, hashlib
    return hmac.new(SC_AGENT_TOKEN.encode(), payload, hashlib.sha256).hexdigest()


def call_llm(messages, tools=None):
    """Drop a request file into the queue, wait for a response.

    The "agent" (you/me in another session) is expected to:
      1. Watch SC_QUEUE_DIR/inbox for new *.json files
      2. Run the LLM with the messages + tools
      3. Write the response to SC_QUEUE_DIR/outbox/<id>.json
    """
    if not SC_USE_FILE_QUEUE:
        # Real HTTP LLM
        body = {"model": LLM_MODEL, "messages": messages, "temperature": 0.2}
        if tools: body["tools"] = tools; body["tool_choice"] = "auto"
        req = urllib.request.Request(
            LLM_URL, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json",
                     **({"Authorization": f"Bearer {LLM_KEY}"} if LLM_KEY else {})},
            method="POST")
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())

    # File-queue backend
    import random
    rid = f"{int(time.time()*1000)}_{random.randrange(10**6):06d}"
    inbox_path = SC_QUEUE_DIR / "inbox" / f"{rid}.json"
    outbox_path = SC_QUEUE_DIR / "outbox" / f"{rid}.json"
    payload = {
        "id": rid,
        "model": LLM_MODEL,
        "messages": messages,
        "tools": tools,
    }
    raw = json.dumps(payload).encode()
    inbox_path.write_bytes(raw)
    # Wait for response (max 120s)
    deadline = time.time() + 120
    while time.time() < deadline:
        if outbox_path.exists():
            try:
                resp = json.loads(outbox_path.read_bytes())
                outbox_path.unlink()
                inbox_path.unlink(missing_ok=True)
                return resp
            except Exception:
                pass
        time.sleep(0.2)
    inbox_path.unlink(missing_ok=True)
    raise TimeoutError(f"LLM queue timed out for {rid}")


# --- bridge i/o ------------------------------------------------------

def load_token():
    if not TOKEN_FILE.exists():
        sys.exit(f"missing token at {TOKEN_FILE} — start the bridge first")
    return TOKEN_FILE.read_text().strip()


SC_AGENT_TOKEN = os.environ.get("SC_AGENT_TOKEN", "")  # populated lazily in main()


async def send_action(ws, action, session_id):
    """Send a tool call to the extension. Fire-and-forget — the action runs
    in the extension's content script and the result is delivered through
    the SAME `SC_CHAT` round-trip we use for user messages (the agent's
    run-loop recv() picks it up and routes it).
    """
    action["id"] = str(uuid.uuid4())
    action["timeout"] = 15
    await ws.send(json.dumps(action))
    # No ack wait — see handle_response() for the result-routing logic.
    return {"ok": True, "pending": action["id"]}


async def send_chat(ws, text, session_id, html=None):
    msg = {
        "type": "SC_CHAT",
        "from": "me",
        "sessionId": session_id,
        "text": text,
        "ts": int(time.time() * 1000),
    }
    if html: msg["html"] = html
    await ws.send(json.dumps(msg))
    return {"ok": True, "pending": msg.get("ts")}


# --- agent loop ------------------------------------------------------

class Agent:
    def __init__(self, ws):
        self.ws = ws
        self.sessions = {}   # sessionId -> list of messages
        self.pending_actions = {}  # id -> asyncio.Future (result from extension)
        self.action_results_queue = asyncio.Queue()

    def history(self, sid):
        return self.sessions.setdefault(sid, [
            {"role": "system", "content": SYSTEM_PROMPT}
        ])

    def add_user(self, sid, text):
        msgs = self.history(sid)
        msgs.append({"role": "user", "content": text})
        if len(msgs) > 40:
            self.sessions[sid] = [msgs[0]] + msgs[-39:]

    def add_assistant(self, sid, msg):
        self.history(sid).append(msg)

    def add_tool_result(self, sid, name, content, call_id):
        self.history(sid).append({
            "role": "tool",
            "tool_call_id": call_id,
            "name": name,
            "content": content if isinstance(content, str) else json.dumps(content),
        })

    async def step(self, sid):
        """One LLM step: ask the model, execute any tool calls, return when model
        produces a final message (no more tool calls)."""
        for _ in range(20):
            resp = call_llm(self.history(sid), tools=TOOLS)
            choice = resp["choices"][0]
            msg = choice["message"]
            self.add_assistant(sid, msg)

            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                return msg.get("content", "")

            # Send all tool calls, gather their results.
            for tc in tool_calls:
                name = tc["function"]["name"]
                args = json.loads(tc["function"].get("arguments") or "{}")
                args = self.translate_tool(name, args)
                result = await self.execute_tool(name, args, sid, tc["id"])
                self.add_tool_result(sid, name, result, tc["id"])
        return "(agent gave up after 20 tool rounds)"

    def translate_tool(self, name, args):
        return {
            "sc_get_page_info":   {"type": "SC_GET_PAGE_INFO"},
            "sc_query_all":       {"type": "SC_QUERY_ALL", "selector": args["selector"], "limit": args.get("limit", 20)},
            "sc_query_one":       {"type": "SC_QUERY_SELECTOR", "selector": args["selector"]},
            "sc_click":           {"type": "SC_CLICK", "selector": args["selector"]},
            "sc_set_value":       {"type": "SC_SET_VALUE", "selector": args["selector"], "value": args["value"]},
            "sc_fill_form":       {"type": "SC_FILL_FORM", "values": args["values"]},
            "sc_scroll":          {"type": "SC_SCROLL", **{k: v for k, v in args.items() if v is not None}},
            "sc_highlight":       {"type": "SC_HIGHLIGHT", "selector": args["selector"], "duration": args.get("duration", 2000)},
            "sc_run_js":          {"type": "SC_RUN_JS", "expression": args["expression"]},
            "sc_sniff":           {"type": "SC_SNIFF"},
            "sc_take_screenshot": {"type": "SC_SCREENSHOT"},
        }.get(name, {"type": "SC_" + name.upper()})

    async def execute_tool(self, name, args, sid, call_id):
        if name == "sc_reply":
            return await send_chat(self.ws, args["text"], sid)
        if name == "sc_take_screenshot":
            return {"ok": False, "error": "screenshot not yet implemented"}
        # All other tools: send the action, await its result via the run-loop
        action_id = str(uuid.uuid4())
        args["id"] = action_id
        args["timeout"] = 15
        await self.ws.send(json.dumps(args))
        fut = asyncio.get_event_loop().create_future()
        self.pending_actions[action_id] = fut
        try:
            result = await asyncio.wait_for(fut, timeout=20)
        except asyncio.TimeoutError:
            result = {"ok": False, "error": "timeout"}
        finally:
            self.pending_actions.pop(action_id, None)
        if isinstance(result, dict): result.pop("id", None)
        return result

    def on_ws_message(self, msg):
        """Called by run() for every incoming message from the bridge.
        Resolves pending action futures OR queues user chat messages."""
        if msg.get("type") == "EXT_CHAT" and msg.get("from") == "user":
            self.action_results_queue.put_nowait(("user_chat", msg))
            return
        if "id" in msg and msg.get("ok") is not None:
            # Action result
            fut = self.pending_actions.get(msg["id"])
            if fut and not fut.done():
                fut.set_result(msg)
            return
        # Anything else: log
        print(f"[agent] unhandled ws message: {msg}", file=sys.stderr)

    async def handle_user_chat(self, envelope):
        sid = envelope.get("sessionId", "default")
        text = (envelope.get("text") or "").strip()
        if not text:
            return
        self.add_user(sid, text)
        # Show "thinking…" as a placeholder; will be replaced by reply.
        await send_chat(self.ws, "…", sid, html="<span class='thinking-dots'>thinking…</span>")
        try:
            answer = await self.step(sid)
        except Exception as e:
            answer = f"(error: {e})"
        if answer.strip():
            await send_chat(self.ws, answer.strip(), sid)


# --- main loop -------------------------------------------------------

async def run(once=False):
    token = load_token()
    url = f"ws://{BRIDGE_HOST}:{BRIDGE_PORT}/control?token={token}&role=controller"
    print(f"[agent] connecting to {url[:80]}…", flush=True)
    async with websockets.connect(url, ping_interval=20) as ws:
        welcome = json.loads(await ws.recv())
        print(f"[agent] {welcome.get('type','?')}", flush=True)
        agent = Agent(ws)
        await send_chat(ws, "Agent connected. Open the Site Control extension popup to chat.", "agent")

        try:
            while True:
                raw = await ws.recv()
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                # Route EVERY inbound message through the agent synchronously
                # (this resolves pending action futures in-place).
                agent.on_ws_message(msg)
                # If the message is a user chat, kick off a handler task so
                # we can keep reading the WS while it runs.
                if msg.get("type") == "EXT_CHAT" and msg.get("from") == "user":
                    print(f"[agent] user: {(msg.get('text') or '')[:80]}", flush=True)
                    asyncio.create_task(agent.handle_user_chat(msg))
                    if once:
                        # Give the handler time to finish, then exit
                        await asyncio.sleep(8)
                        return
        except ConnectionClosed:
            print("[agent] bridge closed", flush=True)
        except KeyboardInterrupt:
            return


def main():
    global LLM_MODEL, SC_AGENT_TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="exit after first chat round")
    ap.add_argument("--model", default=None)
    args = ap.parse_args()
    if args.model:
        LLM_MODEL = args.model
    SC_AGENT_TOKEN = load_token()  # share the bridge token for queue auth
    asyncio.run(run(once=args.once))


if __name__ == "__main__":
    main()