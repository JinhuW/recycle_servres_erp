#!/usr/bin/env python3
"""Open a VISIBLE browser on an existing worker session and stay open.

For manually warming up / inspecting an account whose automated Marketplace
searches come back empty. Loads the saved session (already logged in), routes
through the SAME proxy the worker uses (so Facebook sees the worker's IP), lands
on Marketplace, and STAYS OPEN until you close the browser window yourself — no
terminal input needed (this often runs without an interactive keyboard). It
saves the session every few seconds, so whatever warming Facebook does while you
browse is captured even when you just close the window.

    python3 scripts/browse-session.py --storage-state /tmp/fb_w3.json \
        --proxy "http://user:pass@isp.decodo.com:10003" [--minutes 30]
"""
import argparse, json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rs_poster"))
from rs_poster.session_cli import proxy_settings

ap = argparse.ArgumentParser()
ap.add_argument("--storage-state", required=True)
ap.add_argument("--proxy")
ap.add_argument("--minutes", type=int, default=30, help="Max minutes to stay open")
ap.add_argument("--stay-open", action="store_true", help="Accepted for symmetry with capture; browse-session always stays open")
args = ap.parse_args()

sess = Path(args.storage_state)
meta_path = sess.with_suffix(sess.suffix + ".meta.json")
meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

def save(ctx):
    try:
        ctx.storage_state(path=str(sess))
        return True
    except Exception:
        return False

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled"])
    ctx = browser.new_context(
        storage_state=str(sess),
        user_agent=meta.get("user_agent"),
        proxy=proxy_settings(args.proxy),
        viewport={"width": 1440, "height": 900},
    )
    page = ctx.new_page()
    page.goto("https://www.facebook.com/marketplace/", wait_until="domcontentloaded", timeout=60000)
    print(f"\nBrowser open on Marketplace (through the worker's proxy).", flush=True)
    print("Search, scroll, open a few listings to warm the account.", flush=True)
    print(f"CLOSE THE BROWSER WINDOW when done (auto-closes after {args.minutes} min).\n", flush=True)

    deadline = time.time() + args.minutes * 60
    while time.time() < deadline:
        try:
            if not browser.is_connected():
                break
            # is the context still alive? (user may have closed all pages/window)
            if not ctx.pages:
                break
        except Exception:
            break
        save(ctx)              # periodic save so warming is never lost
        time.sleep(5)

    save(ctx)
    try:
        browser.close()
    except Exception:
        pass
    print(f"Closed. Saved refreshed session to {sess}", flush=True)
