#!/usr/bin/env python3
"""Post the search funnel to Telegram, split by original vs newly-added cities.

Runs on the VM from cron. Reads the OpenSearch index the monitor ships to and
sends one digest to the chat that already carries worker-health pages.

WHY THE OLD/NEW SPLIT IS THE POINT. On 2026-08-26 coverage went from 28 city
centres to 127. A fleet-wide funnel cannot answer the only question that
expansion raises — whether the 99 new metros produce anything — because the 28
original cities would drown them either way. Every figure here is therefore
reported twice.

    python3 scripts/sweep-report.py                 # trailing 24h, send
    python3 scripts/sweep-report.py --hours 8       # a different window
    python3 scripts/sweep-report.py --dry-run       # print, send nothing
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict

OPENSEARCH = os.environ.get("RS_OPENSEARCH_URL", "http://localhost:9200")
INDEX = "fb-tracker-*"
SECRETS = Path(__file__).resolve().parent.parent / "configs" / "secrets.env"

# The city list as it stood BEFORE the 2026-08-26 nationwide expansion. Frozen
# on purpose: it is the baseline the new metros are measured against, so it
# must not track whatever master.toml happens to say today. Numeric ids are
# Worcester/Manchester/Hartford/New Haven/Springfield.
ORIGINAL_28 = {
    "dc", "nyc", "atlanta", "philly", "columbus", "richmond", "charlotte",
    "raleigh", "boston", "baltimore", "miami", "cleveland", "pittsburgh",
    "louisville", "virginiabeach", "providence", "buffalo", "rochester",
    "syracuse", "tampa", "orlando", "jacksonville", "bangor",
    "105596609473837", "112781448736001", "108119482550253",
    "108541499165950", "107634079257154",
}

# Gates a listing dies at, in the order the monitor applies them, so the digest
# reads as a funnel rather than an unordered tally.
SKIP_ORDER = [
    "missing_keywords_title", "antikeyword", "missing_keywords",
    "seller_rating", "already_notified",
    "unit_count_below_minimum", "below_threshold",
]


def search(body: Dict[str, Any]) -> Dict[str, Any]:
    request = urllib.request.Request(
        f"{OPENSEARCH}/{INDEX}/_search",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def funnel(hours: int) -> Dict[str, Any]:
    """One query, bucketed by city, so old and new are split from one scan."""
    body = {
        "size": 0,
        "query": {"range": {"@timestamp": {"gte": f"now-{hours}h"}}},
        "aggs": {
            "city": {
                "terms": {"field": "search_city.keyword", "size": 400},
                "aggs": {
                    "kind": {"terms": {"field": "kind.keyword", "size": 10}},
                    "reason": {"terms": {"field": "reason.keyword", "size": 12}},
                    "score": {"terms": {"field": "score", "size": 10}},
                },
            }
        },
    }
    return search(body)


def summarise(data: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    groups = {
        side: {"cities": set(), "kind": {}, "reason": {}, "score": {}}
        for side in ("original", "new")
    }
    for bucket in data["aggregations"]["city"]["buckets"]:
        city = bucket["key"]
        side = "original" if city in ORIGINAL_28 else "new"
        group = groups[side]
        group["cities"].add(city)
        for name, target in (("kind", "kind"), ("reason", "reason"), ("score", "score")):
            for sub in bucket[name]["buckets"]:
                key = sub["key"]
                group[target][key] = group[target].get(key, 0) + sub["doc_count"]
    return groups


def column(group: Dict[str, Any]) -> Dict[str, int]:
    kind, reason = group["kind"], group["reason"]
    return {
        "cities": len(group["cities"]),
        "searches": kind.get("search_start", 0),
        "skipped": kind.get("listing_skip", 0),
        "evaluated": kind.get("ai_eval", 0),
        "alerts": kind.get("listing_alert", 0),
        "units": reason.get("unit_count_below_minimum", 0),
        "threshold": reason.get("below_threshold", 0),
    }


def render(groups: Dict[str, Dict[str, Any]], hours: int) -> str:
    old, new = column(groups["original"]), column(groups["new"])
    lines = [
        f"Search funnel — last {hours}h",
        "",
        f"{'':<12}{'original':>10}{'new':>10}",
        f"{'cities':<12}{old['cities']:>10}{new['cities']:>10}",
        f"{'searches':<12}{old['searches']:>10}{new['searches']:>10}",
        f"{'skipped':<12}{old['skipped']:>10}{new['skipped']:>10}",
        f"{'AI evals':<12}{old['evaluated']:>10}{new['evaluated']:>10}",
        f"{'<5 units':<12}{old['units']:>10}{new['units']:>10}",
        f"{'score <4':<12}{old['threshold']:>10}{new['threshold']:>10}",
        f"{'ALERTS':<12}{old['alerts']:>10}{new['alerts']:>10}",
    ]

    for side, label in (("original", "original 28"), ("new", "new 99")):
        scores = groups[side]["score"]
        if scores:
            spread = "  ".join(
                f"{k}:{scores[k]}" for k in sorted(scores) if scores[k]
            )
            lines.append(f"\nscores {label}: {spread}")

    # A zero here is a finding, not an empty section — say so rather than
    # printing nothing and letting it read as "not measured".
    if not groups["new"]["cities"]:
        lines.append("\nNo new city searched in this window yet.")
    return "\n".join(lines)


def telegram_env() -> Dict[str, str]:
    """Prefer the real environment; fall back to the VM's secrets.env."""
    env = {}
    if SECRETS.exists():
        for line in SECRETS.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip()
    env.update({k: v for k, v in os.environ.items() if k.startswith("TELEGRAM_")})
    return env


def send(text: str) -> None:
    env = telegram_env()
    token, chat = env.get("TELEGRAM_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        raise SystemExit("no TELEGRAM_TOKEN / TELEGRAM_CHAT_ID available")
    params = {"chat_id": chat, "text": f"```\n{text}\n```", "parse_mode": "Markdown"}
    # Sends from this VM measure 0.7-4s against python-telegram-bot's 5s
    # default, so the timeout is deliberately generous.
    urllib.request.urlopen(
        f"https://api.telegram.org/bot{token}/sendMessage",
        urllib.parse.urlencode(params).encode(),
        timeout=30,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=int, default=24)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    text = render(summarise(funnel(args.hours)), args.hours)
    print(text)
    if not args.dry_run:
        # Never let a failed digest look like a healthy quiet day.
        try:
            send(text)
            print("\nsent to telegram", file=sys.stderr)
        except Exception as error:  # noqa: BLE001
            print(f"\ntelegram send FAILED: {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
