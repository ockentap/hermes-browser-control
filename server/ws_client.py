#!/usr/bin/env python3
"""Tiny CLI client for poking the bridge from the terminal."""
import argparse, asyncio, json, sys, time, uuid
import websockets

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--cmd", help="JSON command string, or omit for REPL")
    ap.add_argument("--timeout", type=float, default=10)
    ap.add_argument("--subscribe", action="store_true",
                    help="stay connected and print events")
    args = ap.parse_args()

    async with websockets.connect(args.url, ping_interval=20) as ws:
        welcome = json.loads(await ws.recv())
        print("#", welcome, file=sys.stderr)
        if args.subscribe:
            await ws.send(json.dumps({"type": "SUBSCRIBE_EVENTS"}))
            print("# subscribed", file=sys.stderr)
            while True:
                print(await ws.recv())
        if not args.cmd:
            # REPL
            while True:
                line = input("sc> ")
                if not line: continue
                if line in ("quit", "exit"): return
                msg = json.loads(line)
                msg.setdefault("id", str(uuid.uuid4()))
                await ws.send(json.dumps(msg))
                print(await ws.recv())
        # one-shot
        msg = json.loads(args.cmd)
        msg.setdefault("id", str(uuid.uuid4()))
        msg.setdefault("timeout", args.timeout)
        await ws.send(json.dumps(msg))
        print(await asyncio.wait_for(ws.recv(), args.timeout + 2))

asyncio.run(main())