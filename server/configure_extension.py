#!/usr/bin/env python3
"""
Configure the Site Control extension with the bridge URL.

Run on the user's local machine (not the server) to print a snippet the user
pastes into chrome://extensions → Site Control → "service worker" console:

    chrome.storage.local.set({bridgeUrl: 'ws://127.0.0.1:7777/control?token=...'});

Or just run this and copy the JSON it prints.
"""
import argparse, os, secrets, subprocess
from pathlib import Path

TOKEN_FILE = Path.home() / ".hermes" / "site-control-token"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="127.0.0.1:7777",
                    help="host:port of the local bridge")
    ap.add_argument("--token", default=None,
                    help="auth token (defaults to ~/.hermes/site-control-token)")
    args = ap.parse_args()

    if args.token:
        token = args.token
    elif TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text().strip()
    else:
        sys.exit("no token — start the server first, or pass --token")

    url = f"ws://{args.server}/control?token={token}&role=extension"
    print(url)
    print()
    print("# paste this into the extension's service-worker console:")
    print(f'chrome.storage.local.set({{bridgeUrl: "{url}"}});')

    # Optional: if the user has jq, generate a one-liner
    jq = subprocess.run(["which", "jq"], capture_output=True, text=True)
    if jq.returncode == 0:
        print()
        print("# or via jq+curl: nothing — chrome.storage is local to the extension")


if __name__ == "__main__":
    main()