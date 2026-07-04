#!/usr/bin/env python3
"""
LLM responder for the Site Control agent queue.

Watches /tmp/sc-llm-queue/inbox for *.json request files. For each one,
calls a configured LLM (or, if SC_LLM_BACKEND=hermes, hands it to a Hermes
session via session_search), writes the response to outbox/<id>.json.

Two backends:
  - "http"     — OpenAI-compatible chat completions endpoint
                 (Ollama, vLLM, llama.cpp, OpenAI, etc.)
  - "hermes"   — Write the request to a human-readable "todo" log and
                 read the response back when a human posts it. Use
                 during development.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

QUEUE = Path(os.environ.get("SC_QUEUE_DIR", "/tmp/sc-llm-queue"))


def respond(req: dict) -> dict:
    """Call the LLM and return an OpenAI-shaped response dict."""
    backend = os.environ.get("SC_LLM_BACKEND", "http")
    if backend == "http":
        url    = os.environ.get("SC_LLM_URL",   "http://127.0.0.1:11434/v1/chat/completions")
        model  = os.environ.get("SC_LLM_MODEL", "MiniMax-M3")
        key    = os.environ.get("SC_LLM_KEY",   "")
        body = {"model": model, "messages": req["messages"], "temperature": 0.2}
        if req.get("tools"):
            body["tools"] = req["tools"]
            body["tool_choice"] = "auto"
        headers = {"Content-Type": "application/json"}
        if key: headers["Authorization"] = "Bearer " + key
        r = urllib.request.Request(url, data=json.dumps(body).encode(),
                                   headers=headers, method="POST")
        with urllib.request.urlopen(r, timeout=120) as resp:
            return json.loads(resp.read())

    if backend == "hermes":
        # Hand the request to a human-readable "todo" file; a Hermes session
        # (or the operator) reads it, writes a response, and we pick it up.
        # This is mostly useful for debugging or when no LLM is running.
        return {
            "choices": [{"message": {
                "role": "assistant",
                "content": "(hermes backend not implemented in watcher; "
                           "set SC_LLM_BACKEND=http and SC_LLM_URL to a real LLM)"
            }}]
        }

    raise SystemExit(f"unknown backend: {backend}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="process one request and exit")
    ap.add_argument("--loop", action="store_true", help="process forever")
    args = ap.parse_args()

    inbox  = QUEUE / "inbox"
    outbox = QUEUE / "outbox"
    inbox.mkdir(parents=True, exist_ok=True)
    outbox.mkdir(parents=True, exist_ok=True)

    print(f"[llm-responder] watching {inbox}", flush=True)
    seen = set()
    while True:
        for f in sorted(inbox.glob("*.json")):
            if f.name in seen: continue
            try:
                req = json.loads(f.read_bytes())
            except Exception as e:
                print(f"[llm-responder] bad request {f}: {e}", file=sys.stderr)
                f.unlink(missing_ok=True); continue
            seen.add(f.name)
            rid = req.get("id", f.stem)
            print(f"[llm-responder] handling {rid}", flush=True)
            try:
                resp = respond(req)
                (outbox / f"{rid}.json").write_bytes(json.dumps(resp).encode())
                print(f"[llm-responder] {rid} done", flush=True)
            except Exception as e:
                err = {"error": str(e),
                       "choices": [{"message": {"role": "assistant",
                                                 "content": f"(LLM error: {e})"}}]}
                (outbox / f"{rid}.json").write_bytes(json.dumps(err).encode())
            if args.once:
                return
        if not args.loop and not seen:
            return
        time.sleep(0.5)


if __name__ == "__main__":
    main()