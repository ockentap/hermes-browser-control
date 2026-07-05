#!/usr/bin/env python3
"""
Site Control — WebSocket bridge.

Listens on ws://127.0.0.1:7777/control?token=<TOKEN>
The Chromium extension connects as a *receiver* (does the DOM work).
Remote clients (you, an agent) connect as *controllers* (send commands,
get results back).

If `hermes_responder` is importable, SC_CHAT from the extension is
intercepted and routed through `hermes chat` (the LLM is Hermes itself).
The bridge builds page state by asking the extension, calls the responder,
and forwards the resulting SC_* commands back to the extension.

Protocol (JSON, one message per line on the WS — websockets auto-frames):

  controller -> server:
    {"id": "uuid", "type": "SC_CLICK", "selector": "#login", "timeout": 10}
  server -> controller:
    {"id": "uuid", "ok": true, "result": {...}}      # success
    {"id": "uuid", "ok": false, "error": "..."}     # failure

Special controller messages:
    {"type": "PING"}                       -> {"type": "PONG"}
    {"type": "LIST_TABS"}                  -> asks the extension for tab list
    {"type": "BROADCAST", "payload":{...}} -> fans a command out to all extensions,
                                              returns first non-error result
    {"type": "SHUTDOWN", "token": "..."}   -> stops the server (auth required)

Server-bound messages from the extension:
    {"type": "REGISTER", "role": "extension", "tabCount": 3}
    {"type": "EVENT", "kind": "page_loaded", "url": "..."}
    {"type": "SC_CHAT", "from": "user", "text": "...", "sessionId": "..."}
        -> routed through hermes_responder if available; otherwise forwarded
           to controllers as EXT_CHAT (legacy mode).
"""

import asyncio
import json
import logging
import os
import secrets
import signal
import sys
import time
import uuid
from pathlib import Path

from urllib.parse import urlparse, parse_qs

# ---------- logging (declared early so the responder-import block can log) -

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(Path.home() / ".hermes" / "logs" / "site-control-server.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("site-control")

# ---------- websockets import ------------------------------------------

try:
    from websockets.asyncio.server import serve
    from websockets.exceptions import ConnectionClosed
except ImportError:
    from websockets.server import serve  # legacy fallback
    from websockets.exceptions import ConnectionClosed

# Responder is optional — if hermes isn't installed or the module breaks,
# the bridge falls back to forwarding SC_CHAT to controllers as before.
try:
    import hermes_responder
    _HAS_RESPONDER = True
except Exception as _e:
    hermes_responder = None
    _HAS_RESPONDER = False
    log.warning("hermes_responder import failed (%s) — SC_CHAT will be forwarded to controllers as before", _e)

# ---------- config -----------------------------------------------------

HOST = "127.0.0.1"
PORT = 7777
TOKEN_FILE = Path.home() / ".hermes" / "site-control-token"
LOG_FILE   = Path.home() / ".hermes" / "logs" / "site-control-server.log"
PATH       = "/control"


def load_or_create_token() -> str:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    if TOKEN_FILE.exists():
        tok = TOKEN_FILE.read_text().strip()
        if tok:
            return tok
    tok = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(tok + "\n")
    TOKEN_FILE.chmod(0o600)
    return tok


# ---------- state ------------------------------------------------------

# Pending requests: id -> asyncio.Future
PENDING: dict[str, asyncio.Future] = {}
# Connected extensions (role == "extension")
EXTENSIONS: set = set()
# Connected controllers (role == "controller")
CONTROLLERS: set = set()
# Event subscribers (controllers that want to receive pushed events)
SUBSCRIBERS: set = set()


def _check_token(query_params) -> bool:
    return query_params.get("token") == TOKEN


# ---------- responder helpers ------------------------------------------

async def _ask_extension_for_page_info(ws, timeout: float = 5.0) -> dict | None:
    """Send SC_GET_PAGE_INFO to the given extension WS and await the result.

    Returns the page info dict on success, or None on timeout/error.
    """
    rid = str(uuid.uuid4())
    fut = asyncio.get_event_loop().create_future()
    PENDING[rid] = fut
    try:
        await ws.send(json.dumps({"id": rid, "type": "SC_GET_PAGE_INFO", "timeout": int(timeout)}))
        reply = await asyncio.wait_for(fut, timeout=timeout)
        if reply.get("ok"):
            return reply.get("result") or {}
        log.warning("SC_GET_PAGE_INFO failed: %s", reply.get("error"))
        return None
    except asyncio.TimeoutError:
        log.warning("SC_GET_PAGE_INFO timed out after %.1fs", timeout)
        return None
    except ConnectionClosed:
        return None
    finally:
        PENDING.pop(rid, None)


async def _send_commands_to_extension(ws, commands: list[dict]) -> None:
    """Forward a list of {"type": "SC_X", ...} commands to the extension WS.

    Each command gets a fresh id and is sent in order. We don't await results
    here — SC_CHAT is fire-and-forget from the user's perspective; the next
    user message gives us another chance to inspect state.
    """
    for cmd in commands:
        if not isinstance(cmd, dict):
            continue
        cmd.setdefault("id", str(uuid.uuid4()))
        cmd.setdefault("timeout", 10)
        try:
            await ws.send(json.dumps(cmd))
        except ConnectionClosed:
            log.warning("extension disconnected mid-command-stream")
            return


async def _send_chat_to_extension(ws, text: str, session_id: str | None = None) -> None:
    """Wrap text in an SC_CHAT envelope and send it back to the popup."""
    msg = {
        "type": "SC_CHAT",
        "from": "me",
        "text": text,
        "ts": int(time.time() * 1000),
    }
    if session_id:
        msg["sessionId"] = session_id
    try:
        await ws.send(json.dumps(msg))
    except ConnectionClosed:
        log.warning("extension disconnected before chat reply could be sent")


async def _execute_commands_and_collect(ws, commands: list[dict]) -> str:
    """Send a batch of commands to the extension and return a feedback string
    describing what happened (used as input to the next agentic-loop iteration).

    Each command gets a fresh id, is sent to the extension, and we wait for
    its RESULT envelope on the WS. Failures are captured in the feedback so
    Hermes can react. SC_NAVIGATE and SC_RUN_JS deliberately skip the wait
    (the page is being torn down for navigation, and SC_RUN_JS has a self-
    contained return value).
    """
    results_lines = []
    for cmd in commands:
        if not isinstance(cmd, dict):
            continue
        cmd.setdefault("id", str(uuid.uuid4()))
        cmd.setdefault("timeout", 10)
        ctype = cmd.get("type")
        try:
            # Register a future so the WS reply resolves the result.
            fut = asyncio.get_event_loop().create_future()
            PENDING[cmd["id"]] = fut
            await ws.send(json.dumps(cmd))
            try:
                reply = await asyncio.wait_for(fut, timeout=cmd["timeout"])
            except asyncio.TimeoutError:
                PENDING.pop(cmd["id"], None)
                results_lines.append(f"  {ctype}: TIMEOUT after {cmd['timeout']}s")
                continue
            if reply.get("ok"):
                # Extract a useful summary field if present
                detail = ""
                for k in ("result", "value", "clicked", "set", "navigating", "highlighted"):
                    if k in reply:
                        detail = f" → {reply[k] if not isinstance(reply[k], (dict, list)) else '...'}"
                        break
                results_lines.append(f"  {ctype}: ok{detail}")
            else:
                err = reply.get("error", "unknown")
                results_lines.append(f"  {ctype}: FAILED — {err}")
        except ConnectionClosed:
            PENDING.pop(cmd["id"], None)
            results_lines.append(f"  {ctype}: extension disconnected")
            break
        except Exception as e:
            results_lines.append(f"  {ctype}: exception — {e}")
    return "\n".join(results_lines) if results_lines else "(no commands executed)"


async def _handle_sc_chat_via_responder(ws, msg: dict) -> None:
    """Pop the user message through hermes_responder, then send the result
    (chat reply + SC_* commands) back to the extension that sent it.

    Page state is read from msg.pageState if the popup attached it; otherwise
    we ask the extension for it via _ask_extension_for_page_info as a fallback.
    """
    user_text = msg.get("text", "").strip()
    session_id = msg.get("sessionId")
    if not user_text:
        return

    log.info("SC_CHAT (responder): %r", user_text[:120])

    # 1. Prefer pageState attached by the popup; fall back to asking extension
    page_state = msg.get("pageState")
    if not page_state:
        log.debug("no pageState in envelope; asking extension")
        page_state = await _ask_extension_for_page_info(ws)
    if page_state is None:
        page_state = {}

    # 2. Agentic loop: call Hermes, execute its commands, feed results back,
    #    loop until Hermes says "done" (no commands + only SC_REPLY) or we hit
    #    the iteration cap. Without this loop, a multi-step task like
    #    "fill form, click Next, fill next form, click Submit" would only
    #    run the first step and leave the user with a half-finished task.
    MAX_ITERATIONS = 6
    final_reply = ""
    iteration = 0
    feedback = ""  # accumulated command results fed back into next prompt
    try:
        while iteration < MAX_ITERATIONS:
            iteration += 1
            # Build prompt: original user msg + accumulated feedback from
            # previous iterations (only after iteration 1)
            prompt_msg = user_text
            if feedback:
                prompt_msg += "\n\n[Tool results from previous step]\n" + feedback

            reply_text, commands = await asyncio.to_thread(
                hermes_responder.respond, prompt_msg, page_state
            )
            log.info("iter %d: responder returned reply_len=%d commands=%d",
                     iteration, len(reply_text), len(commands))

            # No commands + a reply text → Hermes is done, send the final reply
            if not commands:
                final_reply = reply_text or "(no reply)"
                break

            # Commands present → execute them and feed results back
            log.info("iter %d: responder emitted %d command(s): %s",
                     iteration, len(commands), [c.get("type") for c in commands])
            results = await _execute_commands_and_collect(ws, commands)

            # If any reply text came back alongside commands (e.g. SC_REPLY
            # mixed with SC_CLICK), preserve it as the running final reply —
            # later iterations can refine or extend it.
            if reply_text:
                final_reply = reply_text

            # Build feedback for next iteration. Always include fresh page
            # state so Hermes sees what the page looks like AFTER its actions.
            new_state = await _ask_extension_for_page_info(ws) or {}
            feedback_parts = [results]
            if new_state:
                # Compact view of post-action page state
                title = new_state.get("title", "?")
                url = new_state.get("url", "?")
                body = (new_state.get("bodyText") or "")[:500]
                feedback_parts.append(
                    f"\n[Page after action — title={title!r} url={url!r}]\n{body}"
                )
            feedback = "\n".join(feedback_parts)

            # Update page_state so SC_GET_PAGE_INFO-style data stays current
            page_state = new_state or page_state
    except Exception as e:
        log.exception("responder loop crashed")
        await _send_chat_to_extension(ws, f"(responder crashed: {e})", session_id)
        return

    log.info("agentic loop done after %d iteration(s)", iteration)

    # 3. Send the final chat reply
    if final_reply:
        await _send_chat_to_extension(ws, final_reply, session_id)
    else:
        await _send_chat_to_extension(
            ws, "(responder produced no output — check the bridge log)", session_id
        )


# ---------- websocket handlers ----------------------------------------

async def serve_extension(ws):
    """Browser extension registered."""
    EXTENSIONS.add(ws)
    log.info("extension connected (%d total)", len(EXTENSIONS))
    try:
        await ws.send(json.dumps({
            "type": "WELCOME", "role": "extension",
            "serverTime": time.time(),
            "instructions": "send {type:'REGISTER', tabCount:N} then route messages with matching {id}",
        }))
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            kind = msg.get("type")
            if kind == "REGISTER":
                ws._tab_count = msg.get("tabCount", 0)
                log.info("extension reports %d tabs", ws._tab_count)
            elif kind == "RESULT" or ("id" in msg and "ok" in msg):
                # Result for a request we sent. Accept either an explicit
                # {"type":"RESULT","id":...} envelope or any message that
                # carries both an id and an ok flag (extension's own format).
                rid = msg.get("id")
                fut = PENDING.pop(rid, None)
                if fut and not fut.done():
                    fut.set_result(msg)
            elif kind == "EVENT":
                # Push event to subscribers
                evt = json.dumps({"type": "EXT_EVENT", **msg})
                await asyncio.gather(
                    *[s.send(evt) for s in SUBSCRIBERS],
                    return_exceptions=True,
                )
            elif kind == "SC_CHAT":
                if _HAS_RESPONDER:
                    # Route through Hermes-as-LLM. Run as a background task so
                    # we don't block other inbound messages on this WS while
                    # the responder is shelling out to `hermes chat`.
                    asyncio.create_task(_handle_sc_chat_via_responder(ws, msg))
                else:
                    # Legacy mode: forward to controllers as EXT_CHAT.
                    evt = json.dumps({**msg, "type": "EXT_CHAT"})
                    await asyncio.gather(
                        *[c.send(evt) for c in CONTROLLERS],
                        return_exceptions=True,
                    )
            else:
                log.warning("unknown extension message: %s", kind)
    except ConnectionClosed:
        pass
    finally:
        EXTENSIONS.discard(ws)
        log.info("extension disconnected (%d remaining)", len(EXTENSIONS))


async def serve_controller(ws):
    """Remote controller (you, an agent, a script)."""
    CONTROLLERS.add(ws)
    log.info("controller connected (%d total)", len(CONTROLLERS))
    try:
        await ws.send(json.dumps({"type": "WELCOME", "role": "controller"}))
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                await ws.send(json.dumps({"ok": False, "error": "invalid json"}))
                continue

            kind = msg.get("type")

            if kind == "PING":
                await ws.send(json.dumps({"type": "PONG", "t": time.time()}))
                continue

            if kind == "SHUTDOWN":
                if msg.get("token") == TOKEN:
                    log.warning("shutdown requested")
                    await ws.send(json.dumps({"ok": True, "shutting_down": True}))
                    await asyncio.sleep(0.2)
                    os._exit(0)
                await ws.send(json.dumps({"ok": False, "error": "bad token"}))
                continue

            if kind == "SUBSCRIBE_EVENTS":
                SUBSCRIBERS.add(ws)
                await ws.send(json.dumps({"ok": True, "subscribed": True}))
                continue

            if kind == "UNSUBSCRIBE_EVENTS":
                SUBSCRIBERS.discard(ws)
                await ws.send(json.dumps({"ok": True, "subscribed": False}))
                continue

            if kind == "LIST_CLIENTS":
                await ws.send(json.dumps({
                    "ok": True,
                    "extensions": len(EXTENSIONS),
                    "controllers": len(CONTROLLERS),
                    "pending": len(PENDING),
                }))
                continue

            if kind == "BROADCAST":
                payload = msg.get("payload") or {}
                if not EXTENSIONS:
                    await ws.send(json.dumps({"ok": False, "error": "no extension connected"}))
                    continue
                payload.setdefault("id", str(uuid.uuid4()))
                payload.setdefault("timeout", 10)
                data = json.dumps(payload)
                await asyncio.gather(
                    *[e.send(data) for e in EXTENSIONS],
                    return_exceptions=True,
                )
                # Wait for first result
                fut = asyncio.get_event_loop().create_future()
                PENDING[payload["id"]] = fut
                try:
                    reply = await asyncio.wait_for(fut, timeout=payload["timeout"])
                    await ws.send(json.dumps(reply))
                except asyncio.TimeoutError:
                    PENDING.pop(payload["id"], None)
                    await ws.send(json.dumps({"ok": False, "id": payload["id"], "error": "timeout"}))
                continue

            # Regular command — assign id, send to *all* extensions, await first good result.
            cmd = dict(msg)
            cmd.setdefault("id", str(uuid.uuid4()))
            cmd.setdefault("timeout", 10)
            if not EXTENSIONS:
                await ws.send(json.dumps({"ok": False, "id": cmd["id"], "error": "no extension connected"}))
                continue
            data = json.dumps(cmd)
            await asyncio.gather(*[e.send(data) for e in EXTENSIONS], return_exceptions=True)
            fut = asyncio.get_event_loop().create_future()
            PENDING[cmd["id"]] = fut
            # Chat messages don't expect a result ack; don't await.
            if cmd.get("type") == "SC_CHAT":
                # Fire-and-forget
                continue
            try:
                reply = await asyncio.wait_for(fut, timeout=cmd["timeout"])
                await ws.send(json.dumps(reply))
            except asyncio.TimeoutError:
                PENDING.pop(cmd["id"], None)
                await ws.send(json.dumps({"ok": False, "id": cmd["id"], "error": "timeout"}))
    except ConnectionClosed:
        pass
    finally:
        CONTROLLERS.discard(ws)
        SUBSCRIBERS.discard(ws)
        log.info("controller disconnected (%d remaining)", len(CONTROLLERS))


async def handler(ws):
    """Route connection by ?role= query param."""
    # websockets 16+ stores the full request line in ws.request.path
    # (including "?token=...&role=..."), with no .query_params helper.
    raw = getattr(ws, "request", None)
    full_path = raw.path if raw is not None else "/"
    parsed = urlparse(full_path)
    params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
    if not _check_token(params):
        await ws.close(code=4001, reason="bad token")
        log.warning("rejected connection — bad token from path=%s", full_path[:60])
        return
    role = params.get("role", "extension")
    if role == "controller":
        await serve_controller(ws)
    else:
        await serve_extension(ws)


# ---------- main -------------------------------------------------------

def main():
    global TOKEN
    TOKEN = load_or_create_token()
    log.info("starting on ws://%s:%d%s?token=%s...&role=...", HOST, PORT, PATH, TOKEN[:8])
    # Print the full URL once on stdout for the agent to capture
    print(f"TOKEN={TOKEN}", flush=True)
    print(f"EXT_URL=ws://127.0.0.1:{PORT}{PATH}?token={TOKEN}&role=extension", flush=True)
    print(f"CTRL_URL=ws://127.0.0.1:{PORT}{PATH}?token={TOKEN}&role=controller", flush=True)

    async def runner():
        async with serve(handler, HOST, PORT,
                         ping_interval=20, max_size=2**20) as server:
            log.info("listening on %s:%d", HOST, PORT)
            await asyncio.Future()  # run forever

    asyncio.run(runner())


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)