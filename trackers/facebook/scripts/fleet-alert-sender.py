#!/usr/bin/env python3
"""Send the Telegram alerts fleet workers withheld while their alerts were off.

A stopgap, beside ai-verdict-bridge.py. A fleet worker reads the alert switch
and the Telegram settings once, from its claim at boot, so a worker started
before `RS_ALERTS=on` logs `[Alert] WITHHELD` for every listing that passes the
gate. The bridge indexes those lines (`kind: listing_alert`, `withheld: true`)
with the verdicts beside them; this sends each one the way a worker would:

  1. claim the listing from the coordinator (`POST /v1/alerts/claim`) with the
     withholding worker's own token, so the fleet-wide dedupe holds: a listing
     another worker already alerted is skipped, and one sent here is not sent
     again by a worker later;
  2. post the worker's message (`_listing_alert` in the monitor: title, price,
     location, count, rating, the model's summary, link) to the alert chat;
  3. mark the claim delivered and report the message id (`/v1/alerts/telegram`)
     for the hit-rate stats.

Topic: rating 4 goes to the Low topic; rating 5 by the model's unit count
(50+ High, 10-49 Medium, 5-9 Low, uncounted General), as the monitor routes.

Runs on the homelab VM, where the coordinator, the secrets and OpenSearch are:

    python3 fleet-alert-sender.py --dry-run        # what would be sent
    python3 fleet-alert-sender.py --hours 24       # one pass (default: last 24 h)
    python3 fleet-alert-sender.py --follow         # a pass every 10 s, for good

With fleet-log-follow.py indexing withheld alerts as they are logged, --follow
sends one 10-15 s after the worker withheld it. Kept alive by cron and flock:

    * * * * * flock -n $HOME/fleet-ai-bridge/sender.lock python3 $HOME/fleet-ai-bridge/fleet-alert-sender.py --follow >> $HOME/fleet-ai-bridge/sender.log 2>&1
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

OPENSEARCH = os.environ.get("OPENSEARCH_URL", "http://127.0.0.1:9200")
COORDINATOR = os.environ.get("COORDINATOR_URL", "http://127.0.0.1:8500")
SECRETS = os.path.expanduser("~/recycle_servers/facebook_tracker/configs/secrets.env")
STATE = os.path.expanduser("~/fleet-ai-bridge/sender-state.json")
# Telegram allows about 20 messages a minute into one group.
SEND_GAP_S = 3.5
FOLLOW_S = 10
PRIORITY_EMOJI = {"high": "🔥", "medium": "⚡", "low": "🐢"}
CATEGORY_TAGS = [("ram", "RAM"), ("memory", "RAM"), ("cpu", "CPU"), ("processor", "CPU"), ("ssd", "SSD"),
                 ("storage", "SSD"), ("drive", "SSD"), ("networking", "SSD"), ("server", "Server")]
MARKDOWN_V2 = re.compile(r"([_*\[\]()~`>#+\-=|{}.!\\])")


def escape(text: str) -> str:
    return MARKDOWN_V2.sub(r"\\\1", text)


def secrets() -> dict:
    out = {}
    for line in open(SECRETS):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def call(url: str, body: dict | None = None, token: str | None = None) -> dict:
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


def search(query: dict) -> list[dict]:
    return [h["_source"] for h in call(f"{OPENSEARCH}/fb-tracker-*/_search", query)["hits"]["hits"]]


def withheld(hours: int) -> list[dict]:
    """One per listing, the first sighting, oldest first."""
    rows = search({"size": 5000, "sort": [{"@timestamp": "asc"}], "query": {"bool": {"filter": [
        {"term": {"kind": "listing_alert"}}, {"term": {"withheld": True}},
        {"range": {"@timestamp": {"gte": f"now-{hours}h"}}}]}}})
    first: dict[str, dict] = {}
    for r in rows:
        first.setdefault(r["listing_id"], r)
    return list(first.values())


def verdict(listing_id: str) -> dict:
    """The newest verdict for the listing, preferring one that counted units."""
    rows = search({"size": 20, "sort": [{"@timestamp": "desc"}], "query": {"bool": {"filter": [
        {"term": {"kind": "ai_eval"}}, {"term": {"listing_id.keyword": listing_id}}]}}})
    return next((r for r in rows if r.get("unit_count") is not None), rows[0] if rows else {})


def priority(score: int, units: int | None) -> str | None:
    if score == 4:
        return "low"
    if units is None:
        return None
    return "high" if units >= 50 else "medium" if units >= 10 else "low" if units >= 5 else None


def message(alert: dict, v: dict) -> tuple[str, str]:
    """The monitor's `_listing_alert`, line for line."""
    location = (v.get("location") or "").strip() or "Unknown"
    item_name = (alert.get("item") or v.get("item") or "").lower()
    tag = next((t for needle, t in CATEGORY_TAGS if needle in item_name), "Other")
    title = f"{location.replace(', ', ' - ')} - {tag}"
    item = " ".join((alert.get("title") or "").split())
    if len(item) > 100:
        item = item[:99].rstrip() + "…"
    lines = [item]
    if (v.get("price") or "").strip():
        lines.append(f"Price: {v['price'].strip()}")
    if location != "Unknown":
        lines.append(f"Location: {location}")
    if v.get("count_phrase"):
        lines.append(f"Count: {v['count_phrase']}")
    lines.append(f"AI rating: {alert['score']}/5")
    if (v.get("comment") or "").strip():
        lines.append(v["comment"].strip())
    lines.append(alert["url"].split("?")[0])
    return title, "\n".join(lines)


def telegram(env: dict, text: str, topic: str | None) -> dict:
    body = {"chat_id": env["TELEGRAM_CHAT_ID"], "text": text, "parse_mode": "MarkdownV2"}
    if topic:
        body["message_thread_id"] = int(topic)
    for _ in range(5):
        try:
            return call(f"https://api.telegram.org/bot{env['TELEGRAM_TOKEN']}/sendMessage", body)["result"]
        except urllib.error.HTTPError as e:
            answer = json.loads(e.read() or b"{}")
            wait = (answer.get("parameters") or {}).get("retry_after")
            if e.code != 429 or not wait:
                raise RuntimeError(f"telegram {e.code}: {answer.get('description')}") from None
            time.sleep(wait + 1)
    raise RuntimeError("telegram kept rate-limiting")


def worker_token(worker: str, cache: dict) -> str:
    if worker not in cache:
        cache[worker] = subprocess.run(["docker", "exec", "rs-coordinator", "rsc", "mint-token", "--worker", worker],
                                       check=True, capture_output=True, text=True).stdout.strip()
    return cache[worker]


def run_once(hours: int, dry_run: bool, env: dict, tokens: dict) -> tuple[int, int]:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}
    topics = {"high": env.get("TELEGRAM_TOPIC_HIGH"), "medium": env.get("TELEGRAM_TOPIC_MEDIUM"),
              "low": env.get("TELEGRAM_TOPIC_LOW")}
    sent = skipped = 0
    for alert in withheld(hours):
        lid = alert["listing_id"]
        if lid in state:
            continue
        v = verdict(lid)
        level = priority(alert["score"], v.get("unit_count"))
        title, body = message(alert, v)
        if level:
            title = f"{PRIORITY_EMOJI[level]} {title}"
        if dry_run:
            print(f"{alert['@timestamp'][:16]} {alert['worker']:<16} {alert['score']} {level or 'general':<7} "
                  f"units={v.get('unit_count')} {lid} {alert['title'][:60]}")
            continue
        token = worker_token(alert["worker"], tokens)
        claim = call(f"{COORDINATOR}/v1/alerts/claim", {"listing_id": lid, "price": v.get("price")}, token)
        if not claim["send"]:
            state[lid] = {"verdict": claim["verdict"], "at": stamp}
            skipped += 1
            continue
        text = f"*{escape(title)}*\n\n{escape(body)}"
        result = telegram(env, text, topics.get(level or ""))
        call(f"{COORDINATOR}/v1/alerts/claim/delivered", {"listing_id": lid}, token)
        call(f"{COORDINATOR}/v1/alerts/telegram", {
            "chat_id": str(result["chat"]["id"]), "message_id": result["message_id"],
            "topic_id": int(topics[level]) if level and topics.get(level) else None, "priority": level,
            "listing_id": lid, "post_url": alert["url"], "item_name": alert.get("item"),
            "ai_score": alert["score"], "unit_count": v.get("unit_count"),
            "title": alert["title"][:300], "price": (v.get("price") or "")[:60] or None,
        }, token)
        state[lid] = {"verdict": claim["verdict"], "sent": result["message_id"], "at": stamp}
        sent += 1
        with open(STATE, "w") as f:
            json.dump(state, f)
        time.sleep(SEND_GAP_S)
    if not dry_run:
        with open(STATE, "w") as f:
            json.dump(state, f)
    return sent, skipped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--follow", action="store_true", help=f"keep going, a pass every {FOLLOW_S} s")
    args = ap.parse_args()
    env = secrets()
    tokens: dict = {}
    while True:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        try:
            sent, skipped = run_once(args.hours, args.dry_run, env, tokens)
            if not args.dry_run and (sent or skipped or not args.follow):
                print(f"{stamp} sent {sent}, skipped {skipped} (already alerted or held by another worker)", flush=True)
        except Exception as e:
            # One failed pass (OpenSearch, the coordinator, Telegram) is retried
            # on the next; a claim it left undelivered is this worker's own and
            # answers `new` again.
            print(f"{stamp} pass failed: {e}", flush=True)
            if not args.follow:
                return 1
        if not args.follow:
            return 0
        time.sleep(FOLLOW_S)


if __name__ == "__main__":
    sys.exit(main())
