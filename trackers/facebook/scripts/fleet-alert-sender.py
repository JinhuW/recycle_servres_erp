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

Topic: by the model's unit count, whatever the rating (50+ High, 10-49
Medium, 5-9 Low, uncounted General), as the monitor routes.

Alerts go oldest first, so one listing that keeps failing must not hold up
the rest: a failure is logged and counted on that listing alone, and after
5, or at once when Telegram rejects the message (400), it is parked and
never tried again. A parked report is dropped, since the message is already
in the chat. An outage (nothing answered, or Telegram refusing the bot)
still fails the whole pass, since every listing would fail the same way.

Runs on the homelab VM, where the coordinator, the secrets and OpenSearch are:

    python3 fleet-alert-sender.py --dry-run        # what would be sent
    python3 fleet-alert-sender.py --hours 24       # one pass (default: last 24 h)
    python3 fleet-alert-sender.py --follow         # a pass every 10 s, for good

With fleet-log-follow.py indexing withheld alerts as they are logged, --follow
sends one 10-15 s after the worker withheld it. Kept alive by cron and flock:

    * * * * * flock -n $HOME/fleet-ai-bridge/sender.lock python3 $HOME/fleet-ai-bridge/fleet-alert-sender.py --follow >> $HOME/fleet-ai-bridge/sender.log 2>&1
"""

import argparse
import importlib.util
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
PARK_AFTER = 5
# Counted after entity parsing, so the escaped text in UTF-16 units is a
# bound that always fits.
TELEGRAM_MAX = 4096
PRIORITY_EMOJI = {"high": "🔥", "medium": "⚡", "low": "🐢"}
CATEGORY_TAGS = [("ram", "RAM"), ("memory", "RAM"), ("cpu", "CPU"), ("processor", "CPU"), ("ssd", "SSD"),
                 ("storage", "SSD"), ("drive", "SSD"), ("networking", "SSD"), ("server", "Server")]
MARKDOWN_V2 = re.compile(r"([_*\[\]()~`>#+\-=|{}.!\\])")
FRACTION = re.compile(r"(\.\d+)")

_spec = importlib.util.spec_from_file_location("bridge", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                       "ai-verdict-bridge.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)


class TelegramError(RuntimeError):
    def __init__(self, code: int, description: str | None):
        super().__init__(f"telegram {code}: {description}")
        self.code = code


def escape(text: str) -> str:
    return MARKDOWN_V2.sub(r"\\\1", text)


def size(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def compose(title: str, body: str) -> str:
    """The MarkdownV2 message, cut to Telegram's limit. The cut falls on the
    raw text before escaping, so it never splits an escape, and it eats the
    body from just above the link, where the model's comment is."""
    head, _, link = body.rpartition("\n")
    text = f"*{escape(title)}*\n\n{escape(head)}\n{escape(link)}"
    if size(text) <= TELEGRAM_MAX:
        return text
    budget = TELEGRAM_MAX - size(f"*{escape(title)}*\n\n…\n{escape(link)}")
    keep = 0
    for ch in head:
        budget -= size(escape(ch))
        if budget < 0:
            break
        keep += 1
    return f"*{escape(title)}*\n\n{escape(head[:keep].rstrip())}…\n{escape(link)}"


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
    """One per listing, oldest first.

    Collapsed by listing and fetched newest first, so a window holding more
    withheld lines than one page cuts off the old, already-sent listings and
    never the new ones."""
    rows = search({"size": 10000, "sort": [{"@timestamp": "desc"}],
                   "collapse": {"field": "listing_id.keyword"}, "query": {"bool": {"filter": [
                       {"term": {"kind": "listing_alert"}}, {"term": {"withheld": True}},
                       {"range": {"@timestamp": {"gte": f"now-{hours}h"}}}]}}})
    return rows[::-1]


def verdict(listing_id: str) -> dict:
    """The newest verdict for the listing, preferring one that counted units,
    with the newest price: a relisting at a lower price is often evaluated
    from the cache, with no count, and the counted verdict is the old price's."""
    rows = search({"size": 20, "sort": [{"@timestamp": "desc"}], "query": {"bool": {"filter": [
        {"term": {"kind": "ai_eval"}}, {"term": {"listing_id.keyword": listing_id}}]}}})
    counted = next((r for r in rows if bridge.unit_count(r.get("unit_count")) is not None), rows[0] if rows else {})
    price = next((r["price"] for r in rows if (r.get("price") or "").strip()), None)
    return {**counted, "unit_count": bridge.unit_count(counted.get("unit_count")), "price": price}


def priority(count) -> str | None:
    """The monitor's `alert_priority`: by counted units, whatever the rating.
    Docs indexed before the bridge read counts as the monitor does can hold
    "12" or 0."""
    units = bridge.unit_count(count)
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
                raise TelegramError(e.code, answer.get("description")) from None
            time.sleep(wait + 1)
    raise TelegramError(429, "kept rate-limiting")


def coordinator(path: str, body: dict, worker: str, tokens: dict) -> dict:
    """Call the coordinator as `worker`. --follow runs for good, so a token
    the coordinator stopped accepting (a rotated secret) is minted again."""
    for retry in (False, True):
        if worker not in tokens:
            tokens[worker] = subprocess.run(
                ["docker", "exec", "rs-coordinator", "rsc", "mint-token", "--worker", worker],
                check=True, capture_output=True, text=True).stdout.strip()
        try:
            return call(f"{COORDINATOR}{path}", body, tokens[worker])
        except urllib.error.HTTPError as e:
            if e.code != 401 or retry:
                raise
            del tokens[worker]
    raise AssertionError


def report(entry: dict, tokens: dict) -> None:
    """Close the claim of an alert already in the chat and count its hit."""
    coordinator("/v1/alerts/claim/delivered", {"listing_id": entry["report"]["listing_id"]}, entry["worker"], tokens)
    coordinator("/v1/alerts/telegram", entry["report"], entry["worker"], tokens)
    del entry["report"]


def instant(stamp: str) -> datetime | None:
    """None for a stamp it cannot read. Before 3.11, fromisoformat takes no
    `Z` and only 3 or 6 fractional digits, and native workers write either."""
    text = FRACTION.sub(lambda m: m[1][:7].ljust(7, "0"), stamp.replace(" ", "T").replace("Z", "+00:00"))
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def handled(entry: dict, alert: dict) -> bool:
    """Whether this sighting is one the entry already answered. A worker that
    withholds the listing again later (it was repriced, say) is asked about
    anew, so the coordinator can grant a price drop as `discounted`. A
    sighting stamped no later, from a cached verdict, still counts as new at
    another price. A parked listing is answered for good; one that has only
    failed so far has answered nothing."""
    if entry.get("parked"):
        return True
    if "verdict" not in entry:
        return False
    if alert.get("price") and entry.get("price") and alert["price"] != entry["price"]:
        return False
    at, seen = instant(alert["@timestamp"]), instant(entry.get("seen") or entry["at"])
    return at is not None and seen is not None and at <= seen


def save(state: dict) -> None:
    with open(STATE, "w") as f:
        json.dump(state, f)


def outage(e: Exception) -> bool:
    """A failure every listing would hit: nothing answered, or Telegram
    refusing the bot itself (a revoked token, the bot out of the chat)."""
    if isinstance(e, TelegramError):
        return e.code in (401, 403, 404)
    return isinstance(e, OSError) and not isinstance(e, urllib.error.HTTPError)


def failed(state: dict, lid: str, e: Exception, stamp: str) -> None:
    entry = state.setdefault(lid, {})
    entry["fails"] = entry.get("fails", 0) + 1
    rejected = isinstance(e, TelegramError) and e.code == 400
    print(f"{stamp} {lid} failed ({entry['fails']}): {e}", flush=True)
    if rejected or entry["fails"] >= PARK_AFTER:
        entry["parked"] = str(e)
        dropped = entry.pop("report", None)
        print(f"{stamp} {lid} parked{', report dropped' if dropped else ''}: {e}", flush=True)
    save(state)


def run_once(hours: int, dry_run: bool, env: dict, tokens: dict) -> tuple[int, int]:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}
    topics = {"high": env.get("TELEGRAM_TOPIC_HIGH"), "medium": env.get("TELEGRAM_TOPIC_MEDIUM"),
              "low": env.get("TELEGRAM_TOPIC_LOW")}
    sent = skipped = 0
    # Sent on an earlier pass whose coordinator calls failed: the message is
    # in the chat, so only the report is retried, never the send.
    for lid, entry in list(state.items()):
        if "report" in entry and not entry.get("parked") and not dry_run:
            try:
                report(entry, tokens)
                save(state)
            except Exception as e:
                if outage(e):
                    raise
                failed(state, lid, e, stamp)
    for alert in withheld(hours):
        lid = alert["listing_id"]
        if lid in state and handled(state[lid], alert):
            continue
        posted = sent
        try:
            v = verdict(lid)
            # The withheld line's own price is the sighting's; the verdict's may be older.
            if alert.get("price"):
                v = {**v, "price": alert["price"]}
            level = priority(v.get("unit_count"))
            title, body = message(alert, v)
            if level:
                title = f"{PRIORITY_EMOJI[level]} {title}"
            if dry_run:
                print(f"{alert['@timestamp'][:16]} {alert['worker']:<16} {alert['score']} {level or 'general':<7} "
                      f"units={v.get('unit_count')} {lid} {alert['title'][:60]}")
                continue
            claim = coordinator("/v1/alerts/claim", {"listing_id": lid, "price": v.get("price")}, alert["worker"],
                                tokens)
            if not claim["send"]:
                # Pending is another worker's claim on a lease; it may lapse
                # undelivered, so the listing is asked about again next pass.
                if claim["verdict"] == "duplicate":
                    state[lid] = {**state.get(lid, {}), "verdict": claim["verdict"], "at": stamp,
                                  "seen": alert["@timestamp"], "price": v.get("price")}
                    state[lid].pop("fails", None)
                    skipped += 1
                continue
            result = telegram(env, compose(title, body), topics.get(level or ""))
            state[lid] = entry = {"verdict": claim["verdict"], "sent": result["message_id"], "at": stamp,
                                  "seen": alert["@timestamp"], "price": v.get("price"), "worker": alert["worker"],
                                  "report": {
                "chat_id": str(result["chat"]["id"]), "message_id": result["message_id"],
                "topic_id": int(topics[level]) if level and topics.get(level) else None, "priority": level,
                "listing_id": lid, "post_url": alert["url"], "item_name": alert.get("item"),
                "ai_score": alert["score"], "unit_count": v.get("unit_count"),
                "title": alert["title"][:300], "price": (v.get("price") or "")[:60] or None,
            }}
            save(state)
            sent += 1
            report(entry, tokens)
            save(state)
        except Exception as e:
            if outage(e) or dry_run:
                raise
            failed(state, lid, e, stamp)
        if sent > posted:
            time.sleep(SEND_GAP_S)
    if not dry_run:
        save(state)
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
            # One failed pass (OpenSearch, or an outage of the coordinator or
            # Telegram) is retried on the next. A message already sent is in
            # the state file, so the next pass only reports it; a claim left
            # before the send is this worker's own and answers `new` again.
            print(f"{stamp} pass failed: {e}", flush=True)
            if not args.follow:
                return 1
        if not args.follow:
            return 0
        time.sleep(FOLLOW_S)


if __name__ == "__main__":
    sys.exit(main())
