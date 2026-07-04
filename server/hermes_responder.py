#!/usr/bin/env python3
"""
Site Control — Hermes responder.

When the popup sends an SC_CHAT, the bridge calls `respond(user_msg, page_state)`
here. We shell out to `hermes chat -q ...` with the page state prepended,
parse the response for SC_* commands, and return them as a list the bridge
forwards to the extension.

A single global session_id is persisted at ~/.hermes/site-control-session so
context survives bridge restarts. To wipe it: `rm ~/.hermes/site-control-session`.

Usage from ws_server.py:
    from hermes_responder import respond
    reply_text, commands = respond(user_msg, page_state)
    # commands = [{"type": "SC_CLICK", "selector": "#x"}, ...]
    # reply_text = the SC_REPLY text, or "" if the LLM didn't emit one
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time as _time
from pathlib import Path

# --- logging --------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("site-control-responder")

# --- config ---------------------------------------------------------------

SESSION_FILE = Path.home() / ".hermes" / "site-control-session"
SKILL_NAME   = "site-control"
DEFAULT_MODEL = os.environ.get("SC_LLM_MODEL", "MiniMax-M3")
HERMES_BIN    = os.environ.get("HERMES_BIN", shutil.which("hermes") or "hermes")
RESPONSE_TIMEOUT_S = int(os.environ.get("SC_RESPONDER_TIMEOUT", "120"))
HEALTH_CHECK_TIMEOUT_S = int(os.environ.get("SC_HEALTH_CHECK_TIMEOUT", "15"))
HEALTH_CHECK_CACHE_S = int(os.environ.get("SC_HEALTH_CHECK_CACHE", "30"))
MAX_CONTEXT_CHARS = int(os.environ.get("SC_MAX_CONTEXT", "8000"))

# --- session persistence --------------------------------------------------

def _load_session_id() -> str | None:
    if SESSION_FILE.exists():
        sid = SESSION_FILE.read_text().strip()
        return sid or None
    return None

def _save_session_id(sid: str) -> None:
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSION_FILE.write_text(sid + "\n")
    SESSION_FILE.chmod(0o600)

def reset_session() -> None:
    """Forget the current session. Next call starts fresh."""
    SESSION_FILE.unlink(missing_ok=True)


# --- daemon health check --------------------------------------------------

# Cache: timestamp of last successful health check. Used to avoid running
# the pre-flight on every message when the daemon is healthy.
_health_check_last_ok: float = 0.0


def health_check() -> tuple[bool, str]:
    """Run a quick `hermes chat -q ping` to verify the daemon is responsive.

    Returns (ok, message). Caches a successful result for HEALTH_CHECK_CACHE_S
    seconds so we don't re-probe on every message. Failed results are NOT
    cached — we re-probe next time.

    Designed to catch the case where the Hermes daemon is overloaded, hung,
    or otherwise unable to service a real prompt. Without this, a user
    message that takes longer than RESPONSE_TIMEOUT_S just fails silently
    after 2 minutes. With this, we fail fast (~15s) and surface a clearer
    error to the popup.
    """
    global _health_check_last_ok

    # Use cache for successful results
    now = _time.monotonic()
    if (now - _health_check_last_ok) < HEALTH_CHECK_CACHE_S:
        return (True, "cached")

    if not shutil.which(HERMES_BIN) and not Path(HERMES_BIN).exists():
        return (False, f"hermes binary not found at {HERMES_BIN!r}")

    try:
        proc = subprocess.run(
            [HERMES_BIN, "chat", "-q", "ping", "-Q", "-m", DEFAULT_MODEL],
            capture_output=True, text=True, timeout=HEALTH_CHECK_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return (False, f"health check timed out after {HEALTH_CHECK_TIMEOUT_S}s — daemon may be overloaded")
    except Exception as e:
        return (False, f"health check failed: {e}")

    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        return (False, f"health check exit {proc.returncode}: {err[:120]}")

    # Non-empty stdout counts as healthy
    out = (proc.stdout or "").strip()
    if not out:
        return (False, "health check returned empty stdout")

    _health_check_last_ok = now
    return (True, "ok")


def reset_health_check_cache() -> None:
    """Force the next respond() to re-probe the daemon."""
    global _health_check_last_ok
    _health_check_last_ok = 0.0


# --- response parsing -----------------------------------------------------

# Match SC_<UPPER> at line start, optionally followed by a JSON payload or
# bare args. Examples:
#   SC_CLICK {"selector": "#x"}
#   SC_GET_PAGE_INFO
#   SC_REPLY {"text": "hi"}
CMD_RE = re.compile(
    r'^\s*(SC_[A-Z][A-Z0-9_]*)\s*(\{.*?\})?\s*$',
    re.MULTILINE,
)


def parse_commands(text: str) -> tuple[str, list[dict]]:
    """Pull SC_* commands out of LLM response text.

    Returns (reply_text, commands).

    - reply_text: ONLY the contents of SC_REPLY commands, joined. Prose
      between/around commands is treated as internal thinking and dropped
      from the chat (the popup shows reply_text as what "the agent said").
      If you want thinking surfaced, emit it as SC_REPLY with a leading tag
      like "(thinking: ...)" — the popup can style it.

    - commands: list of {"type": "SC_X", ...payload} dicts ready to forward
      to the extension. SC_REPLY itself is NOT included — it's been hoisted
      into reply_text.
    """
    commands: list[dict] = []
    reply_parts: list[str] = []

    for m in CMD_RE.finditer(text):
        cmd_type = m.group(1)
        payload_raw = m.group(2)
        try:
            payload = json.loads(payload_raw) if payload_raw else {}
        except json.JSONDecodeError:
            payload = {}

        if cmd_type == "SC_REPLY":
            text_payload = payload.get("text", "").strip()
            if text_payload:
                reply_parts.append(text_payload)
            continue

        commands.append({"type": cmd_type, **payload})

    reply_text = "\n".join(reply_parts).strip()
    return reply_text, commands


# --- prompt construction --------------------------------------------------

def _build_prompt(user_msg: str, page_state: dict | None) -> str:
    """Prepend page state to the user's message. Hermes sees one big prompt."""
    parts: list[str] = []

    if page_state:
        # Compact page summary — title, URL, element count, focused element
        title = page_state.get("title", "?")
        url = page_state.get("url", "?")
        ready = page_state.get("readyState", "?")
        elem_count = page_state.get("elementCount", "?")
        has_shadow = page_state.get("hasShadowDOM", False)
        focused = page_state.get("focused", "")

        parts.append(f"[Site Control — tab: {title} ({url})]")
        parts.append(
            f"[Page: readyState={ready}, elements={elem_count}, "
            f"shadowDOM={'yes' if has_shadow else 'no'}"
            + (f", focused={focused}" if focused else "")
            + "]"
        )

        # If a screenshot was attached, reference it
        if page_state.get("screenshotPath"):
            parts.append(f"[Screenshot at: {page_state['screenshotPath']}]")

    parts.append("")
    parts.append(user_msg)
    return "\n".join(parts)


# --- the main call --------------------------------------------------------

def respond(user_msg: str, page_state: dict | None = None) -> tuple[str, list[dict]]:
    """Call Hermes and parse the response.

    Returns (reply_text, commands). On error, returns (error_msg, []) where
    error_msg is a short string suitable for showing in the popup.
    """
    if not shutil.which(HERMES_BIN) and not Path(HERMES_BIN).exists():
        return (f"(responder error: hermes binary not found at {HERMES_BIN!r})", [])

    # Pre-flight: probe the daemon before spending the full RESPONSE_TIMEOUT_S
    # on a request that may never return. Fail fast (15s) with a clearer
    # error if the daemon is unresponsive.
    ok, why = health_check()
    if not ok:
        log.warning("health check failed: %s", why)
        return (f"(responder health check failed: {why})", [])

    prompt = _build_prompt(user_msg, page_state)
    if len(prompt) > MAX_CONTEXT_CHARS:
        prompt = prompt[-MAX_CONTEXT_CHARS:]  # keep tail, drop oldest context

    cmd = [
        HERMES_BIN, "chat",
        "-q", prompt,
        "-s", SKILL_NAME,
        "-m", DEFAULT_MODEL,
        "-Q",  # quiet mode: suppress banner/spinner
    ]

    sid = _load_session_id()
    if sid:
        cmd.extend(["-r", sid])

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=RESPONSE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return (f"(responder timeout after {RESPONSE_TIMEOUT_S}s)", [])
    except Exception as e:
        return (f"(responder error: {e})", [])

    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        return (f"(responder exit {proc.returncode}: {err[:200]})", [])

    response_text = (proc.stdout or "").strip()

    # Hermes prints "[session_id] <response>" in -Q mode when starting new sessions,
    # or just the response when resuming. Strip a leading bracketed session id.
    sid_match = re.match(r"^\[([a-f0-9-]+)\]\s*\n?(.*)$", response_text, re.DOTALL)
    if sid_match:
        new_sid = sid_match.group(1)
        response_text = sid_match.group(2).strip()
        if new_sid and new_sid != sid:
            _save_session_id(new_sid)

    return parse_commands(response_text)


# --- manual test ----------------------------------------------------------

if __name__ == "__main__":
    # Smoke test: `python3 hermes_responder.py "what's on this page?"`
    msg = sys.argv[1] if len(sys.argv) > 1 else "Say hello and run SC_REPLY."
    fake_state = {
        "title": "Example Domain",
        "url": "https://example.com",
        "readyState": "complete",
        "elementCount": 17,
        "hasShadowDOM": False,
    }
    reply, cmds = respond(msg, fake_state)
    print("=== REPLY ===")
    print(reply)
    print("=== COMMANDS ===")
    print(json.dumps(cmds, indent=2))
