#!/usr/bin/env python3
"""Follow every fleet worker's text log and index its verdicts as they happen.

The live half of ai-verdict-bridge.py: the same documents (same parser, same
ids), written within a second of the line instead of on the bridge's
5-minute cron, so fleet-alert-sender.py --follow can send a withheld alert
seconds after the worker withheld it. The cron bridge stays as the catch-up
for anything this missed while it was down; re-indexing the same id is a
no-op.

One `docker exec <worker> tail -F` per running fleet worker that lacks
AIMM_OPENSEARCH_URL, rescanned every minute as workers come and go. Each
verdict or alert line re-parses the worker's last few hundred lines, which
hold the listing, the prompt and the model's response it belongs to.

Kept alive by cron and flock (one copy per host):

    * * * * * flock -n $HOME/fleet-ai-bridge/follow.lock python3 $HOME/fleet-ai-bridge/fleet-log-follow.py >> $HOME/fleet-ai-bridge/follow.log 2>&1
"""

import importlib.util
import os
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("bridge", os.path.join(HERE, "ai-verdict-bridge.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

LOG = f"{bridge.LOG_DIR}/ai-marketplace-monitor.log"
BUFFER_LINES = 600
RESCAN_S = 60
TRIGGERS = (" concludes [", "] WITHHELD (")


def say(message: str) -> None:
    print(f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S} {message}", flush=True)


def follow(container: str, worker: str, alive: set) -> None:
    buffer: deque = deque(maxlen=BUFFER_LINES)
    shipped: set = set()
    # -F follows the name across the monitor's rotation.
    proc = subprocess.Popen(["docker", "exec", container, "tail", "-n", "0", "-F", LOG],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    say(f"{worker}: following")
    pending = 0
    try:
        for line in proc.stdout:
            buffer.append(line.rstrip("\n"))
            # A wrapped line completes on the next one or two, so parse those too.
            if any(t in line for t in TRIGGERS):
                pending = 3
            if pending == 0:
                continue
            pending -= 1
            docs = [(i, d) for i, d in bridge.parse(list(buffer), worker, time.time()) if i not in shipped]
            if not docs:
                continue
            try:
                bridge.index(docs)
                shipped.update(i for i, _ in docs)
                for _, d in docs:
                    if d["kind"] == "listing_alert":
                        say(f"{worker}: withheld {d['score']} {d['listing_id']} {d['title'][:60]}")
            except Exception as e:
                say(f"{worker}: index failed, the cron bridge will catch up: {e}")
    finally:
        proc.kill()
        alive.discard(container)
        say(f"{worker}: stopped following")


def main() -> int:
    alive: set = set()
    while True:
        try:
            for container, worker in bridge.workers():
                if container not in alive:
                    alive.add(container)
                    threading.Thread(target=follow, args=(container, worker, alive), daemon=True).start()
        except Exception as e:
            say(f"listing workers failed: {e}")
        time.sleep(RESCAN_S)


if __name__ == "__main__":
    sys.exit(main())
