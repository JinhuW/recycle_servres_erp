#!/usr/bin/env python3
"""Verify every Facebook fleet worker after the daily sweep, and say so in Telegram.

Runs on the homelab VM from cron (see README "Daily fleet verification"). It
answers, per worker, the question `rsc status` cannot: not "is the container
up and heartbeating" but "did it actually sweep, see listings, and evaluate
them" — the difference between HEALTHY and productive. A checkpointed account
heartbeats HEALTHY all day while every search comes back empty.

Three sources, all local to the VM:

  * the coordinator (127.0.0.1:8500, RS_ADMIN_TOKEN from configs/secrets.env):
    heartbeat liveness, reported state, session expiry, open challenges;
  * OpenSearch (fb-tracker-* — the structured events the monitor ships; NOT
    the container's ai-marketplace-monitor.log, which an inotify loop floods):
    search_start / search_empty / ai_eval / listing_alert counts per worker
    since the scheduled sweep started;
  * docker: which rs-monitor* containers exist and whether they are running.

A worker earns ATTENTION when any of these holds — the container is missing or
not running; liveness is stale/dead; the reported state is not HEALTHY; the
session lapses within 14 days; a challenge is open; it started no search in
the window (missed the sweep); any search came back empty (a checkpointed or
flagged account under automation); or it searched but evaluated nothing (a
dud account that sees no listings). "unknown" liveness (registered, never
heartbeated) is a deployment that has not started and is reported as such,
not paged.

    python3 scripts/fleet-verify.py                 # verify, post to Telegram
    python3 scripts/fleet-verify.py --dry-run       # print only
    python3 scripts/fleet-verify.py --mute mw-1     # parked on purpose
    python3 scripts/fleet-verify.py --hours 6       # fixed window instead of
                                                    # "since the sweep start"

Exit status: 0 all clear, 2 something needs attention, 1 the check itself
failed (a source unreachable, Telegram send failed). Cron mail / the log
distinguishes "quiet because fine" from "quiet because broken".
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT / "configs" / "secrets.env"
COORDINATOR = os.environ.get("RS_COORDINATOR_URL", "http://127.0.0.1:8500")
OPENSEARCH = os.environ.get("RS_OPENSEARCH_URL", "http://127.0.0.1:9200")
INDEX = "fb-tracker-*"
# Mirrors rs_coordinator/health.py EXPIRY_WARN_DAYS.
EXPIRY_WARN_DAYS = 14.0
# The scheduled sweep, UTC, as [marketplace.facebook].start_at in master.toml.
DEFAULT_SWEEP_START = "10:00"


# --------------------------------------------------------------------- sources


def secrets_env() -> Dict[str, str]:
    """The VM's secrets.env, with the real environment winning on overlap."""
    env: Dict[str, str] = {}
    if SECRETS.exists():
        for line in SECRETS.read_text().splitlines():
            stripped = line.strip()
            if "=" in stripped and not stripped.startswith("#"):
                key, _, value = stripped.partition("=")
                env[key.strip()] = value.strip().strip('"').strip("'")
    for key, value in os.environ.items():
        if key.startswith(("TELEGRAM_", "RS_")):
            env[key] = value
    return env


def http_json(url: str, headers: Dict[str, str], body: Optional[Dict[str, Any]] = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def coordinator_rows(token: str) -> Dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    workers = http_json(f"{COORDINATOR}/v1/workers", headers)
    challenges = http_json(f"{COORDINATOR}/v1/challenges", headers)
    return {
        "workers": workers.get("workers", workers) if isinstance(workers, dict) else workers,
        "challenges": (
            challenges.get("challenges", challenges) if isinstance(challenges, dict) else challenges
        ),
    }


def funnel_since(since: dt.datetime) -> Dict[str, Dict[str, int]]:
    """Event counts per worker per kind since `since` (one aggregation query)."""
    body = {
        "size": 0,
        "query": {"range": {"@timestamp": {"gte": since.isoformat()}}},
        "aggs": {
            "worker": {
                "terms": {"field": "worker.keyword", "size": 50},
                "aggs": {"kind": {"terms": {"field": "kind.keyword", "size": 30}}},
            }
        },
    }
    data = http_json(f"{OPENSEARCH}/{INDEX}/_search", {}, body)
    out: Dict[str, Dict[str, int]] = {}
    for bucket in data["aggregations"]["worker"]["buckets"]:
        out[bucket["key"]] = {
            sub["key"]: sub["doc_count"] for sub in bucket["kind"]["buckets"]
        }
    return out


def docker_monitors() -> Dict[str, Dict[str, Any]]:
    """worker_id -> {container, running, status} for every rs-monitor* container."""
    names = subprocess.run(
        ["docker", "ps", "-a", "--filter", "name=rs-monitor", "--format", "{{.Names}}"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    if not names:
        return {}
    raw = subprocess.run(
        ["docker", "inspect", *names], capture_output=True, text=True, check=True
    ).stdout
    out: Dict[str, Dict[str, Any]] = {}
    for item in json.loads(raw):
        env = dict(kv.partition("=")[::2] for kv in item["Config"].get("Env", []))
        worker_id = env.get("RS_WORKER_ID") or item["Name"].lstrip("/")
        state = item["State"]
        out[worker_id] = {
            "container": item["Name"].lstrip("/"),
            "running": bool(state.get("Running")),
            "status": state.get("Status"),
            "started_at": state.get("StartedAt"),
        }
    return out


# -------------------------------------------------------------------- verdicts


def sweep_window_start(now: dt.datetime, sweep_start: str = DEFAULT_SWEEP_START) -> dt.datetime:
    """The most recent scheduled sweep start at or before `now`, minus 10 min
    of slack so the events the monitor logs while spinning up still count."""
    hour, minute = (int(part) for part in sweep_start.split(":"))
    start = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if start > now:
        start -= dt.timedelta(days=1)
    return start - dt.timedelta(minutes=10)


def assess(
    worker_id: str,
    row: Optional[Dict[str, Any]],
    counts: Dict[str, int],
    container: Optional[Dict[str, Any]],
    open_challenges: int,
    muted: bool = False,
) -> Dict[str, Any]:
    """One worker's verdict. Pure, so it is testable without the VM."""
    reasons: List[str] = []
    liveness = (row or {}).get("liveness") or "unknown"
    state = (row or {}).get("state") or "-"
    days_left = (row or {}).get("session_days_left")

    searches = counts.get("search_start", 0)
    empty = counts.get("search_empty", 0)
    evals = counts.get("ai_eval", 0)
    alerts = counts.get("listing_alert", 0)

    if container is None:
        reasons.append("no container")
    elif not container["running"]:
        reasons.append(f"container {container['status']}")

    if liveness in ("stale", "dead"):
        reasons.append(f"heartbeat {liveness}")
    if row is not None and state != "HEALTHY":
        reasons.append(f"state {state}")
    if days_left is not None and days_left <= EXPIRY_WARN_DAYS:
        reasons.append(f"session expires in {days_left:.0f}d")
    if open_challenges:
        reasons.append(f"{open_challenges} open challenge(s)")

    # Productivity gates only apply to a worker that was supposed to sweep.
    running = container is not None and container["running"]
    if running and liveness != "unknown":
        if searches == 0:
            reasons.append("no search in window")
        else:
            if empty:
                reasons.append(f"{empty} empty search(es) — checkpoint/flag?")
            if evals == 0:
                reasons.append("searched but evaluated nothing")

    if liveness == "unknown" and container is None:
        verdict = "NOT DEPLOYED"
    elif muted:
        verdict = "MUTED"
    elif reasons:
        verdict = "ATTENTION"
    else:
        verdict = "OK"

    return {
        "worker_id": worker_id,
        "verdict": verdict,
        "liveness": liveness,
        "state": state,
        "days_left": days_left,
        "searches": searches,
        "empty": empty,
        "evals": evals,
        "alerts": alerts,
        "reasons": reasons,
    }


def assess_fleet(
    rows: Iterable[Dict[str, Any]],
    funnel: Dict[str, Dict[str, int]],
    containers: Dict[str, Dict[str, Any]],
    challenges: Iterable[Dict[str, Any]],
    muted: Iterable[str] = (),
) -> List[Dict[str, Any]]:
    by_id = {str(r.get("worker_id")): r for r in rows}
    open_by_worker: Dict[str, int] = {}
    for challenge in challenges:
        if challenge.get("status") == "open":
            key = str(challenge.get("worker_id"))
            open_by_worker[key] = open_by_worker.get(key, 0) + 1
    muted_set = set(muted)
    ids = sorted(set(by_id) | set(containers))
    return [
        assess(
            worker_id,
            by_id.get(worker_id),
            funnel.get(worker_id, {}),
            containers.get(worker_id),
            open_by_worker.get(worker_id, 0),
            worker_id in muted_set,
        )
        for worker_id in ids
    ]


# ---------------------------------------------------------------------- render


def render(results: List[Dict[str, Any]], since: dt.datetime, now: dt.datetime) -> str:
    attention = [r for r in results if r["verdict"] == "ATTENTION"]
    ok = [r for r in results if r["verdict"] == "OK"]
    headline = (
        f"Fleet verify — {len(ok)}/{len(results)} OK"
        + (f", {len(attention)} need attention" if attention else "")
    )
    lines = [
        headline,
        f"window {since:%m-%d %H:%M} – {now:%m-%d %H:%M} UTC",
        "",
        f"{'worker':<10}{'verdict':<13}{'beat':<8}{'srch':>5}{'empty':>6}{'eval':>6}{'alrt':>5}",
    ]
    for r in results:
        lines.append(
            f"{r['worker_id']:<10}{r['verdict']:<13}{r['liveness']:<8}"
            f"{r['searches']:>5}{r['empty']:>6}{r['evals']:>6}{r['alerts']:>5}"
        )
    flagged = [r for r in results if r["reasons"]]
    if flagged:
        lines.append("")
        for r in flagged:
            lines.append(f"{r['worker_id']}: " + "; ".join(r["reasons"]))
    return "\n".join(lines)


def send_telegram(text: str, env: Dict[str, str]) -> None:
    # Same chat as the coordinator's ops alerts: the ops chat when one is set,
    # with TELEGRAM_TOPIC_OPS a topic in it.
    token = env.get("TELEGRAM_TOKEN")
    chat = env.get("TELEGRAM_OPS_CHAT_ID") or env.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        raise RuntimeError("no TELEGRAM_TOKEN / TELEGRAM_CHAT_ID available")
    params: Dict[str, str] = {
        "chat_id": chat,
        "text": f"```\n{text}\n```",
        "parse_mode": "Markdown",
    }
    topic = env.get("TELEGRAM_TOPIC_OPS")
    if topic:
        params["message_thread_id"] = topic
    # Sends from the VM measure 0.7-4s against a 5s default; be generous.
    urllib.request.urlopen(
        f"https://api.telegram.org/bot{token}/sendMessage",
        urllib.parse.urlencode(params).encode(),
        timeout=30,
    ).read()


# ------------------------------------------------------------------------ main


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="print, send nothing")
    parser.add_argument("--hours", type=float, help="fixed lookback instead of since-sweep")
    parser.add_argument("--sweep-start", default=DEFAULT_SWEEP_START, help="HH:MM UTC")
    parser.add_argument("--mute", action="append", default=[], metavar="WORKER",
                        help="report but never page this worker (parked on purpose)")
    args = parser.parse_args(argv)

    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    since = (
        now - dt.timedelta(hours=args.hours)
        if args.hours
        else sweep_window_start(now, args.sweep_start)
    )

    env = secrets_env()
    token = env.get("RS_ADMIN_TOKEN")
    if not token:
        print("fleet-verify: no RS_ADMIN_TOKEN in secrets.env or environment", file=sys.stderr)
        return 1

    try:
        coord = coordinator_rows(token)
        funnel = funnel_since(since)
        containers = docker_monitors()
    except (urllib.error.URLError, subprocess.CalledProcessError, KeyError) as error:
        print(f"fleet-verify: source unreachable: {error}", file=sys.stderr)
        return 1

    results = assess_fleet(coord["workers"], funnel, containers, coord["challenges"], args.mute)
    text = render(results, since, now)
    print(text)

    if not args.dry_run:
        try:
            send_telegram(text, env)
            print("\nsent to telegram", file=sys.stderr)
        except Exception as error:  # noqa: BLE001 — a failed digest must not look like a quiet day
            print(f"\ntelegram send FAILED: {error}", file=sys.stderr)
            return 1

    return 2 if any(r["verdict"] == "ATTENTION" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
