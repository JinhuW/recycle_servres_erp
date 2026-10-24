"""The city log: every city a worker searched, as one visit from its start to
its end.

`city_events` (db.py) holds the steps. The coordinator writes the ones it
sees: `handed` out by the queue, each `searched` page, each `alerted` listing,
and a lease `released` when the worker parked or restarted. The monitor reports
the rest: `started`, `finished` with the city's counts, or `stopped` and why.

Workers on older monitors report pages only. So a visit's end is read from the
monitor's own word when there is one, else from its lease, else from the
worker moving on: a worker searches one city at a time, so a step on another
city means it is done with this one. Pure: the route and `rsc queue log` hand
it the rows.
"""

from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional

# A page's funnel, in pipeline order: what `searched` carries and what a
# visit adds up.
COUNTS = ("cards", "title_pass", "opened", "keyword_pass", "fresh", "reviewed", "alerted")

# How long a visit may go without a step before it reads as gone quiet. A
# page takes a minute or two, so this is several missed pages.
QUIET_MINUTES = 30
MAX_VISITS = 500


def _ts(stamp: str) -> float:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def _has(visit: Dict[str, Any], *names: str) -> bool:
    return any(e["event"] in names for e in visit["events"])


def _first(visit: Dict[str, Any], name: str) -> Optional[Dict[str, Any]]:
    return next((e for e in visit["events"] if e["event"] == name), None)


def _last(visit: Dict[str, Any], name: str) -> Optional[Dict[str, Any]]:
    return next((e for e in reversed(visit["events"]) if e["event"] == name), None)


def _starts_anew(visit: Dict[str, Any], event: Dict[str, Any], quiet: float) -> bool:
    """Whether `event`, on the same worker, item and city as the visit, begins
    another visit rather than continuing this one."""
    if _ts(event["at"]) - _ts(visit["events"][-1]["at"]) > quiet:
        return True
    kind = event["event"]
    ended = _has(visit, "finished", "stopped", "released")
    if kind == "handed":
        return ended or _has(visit, "handed", "started")
    if kind == "started":
        return _has(visit, "started", "finished", "stopped") or (
            ended and not _has(visit, "handed")
        )
    if kind in ("searched", "alerted"):
        return _has(visit, "finished", "stopped")
    return False


def _totals(visit: Dict[str, Any]) -> Dict[str, Any]:
    """The monitor's own count of the city when it reported one, else the sum
    of the pages the coordinator saw."""
    report = _last(visit, "finished") or _last(visit, "stopped")
    if report is not None:
        detail = report["detail"]
        totals = {k: int(detail.get(k) or 0) for k in ("searches", *COUNTS)}
        if detail.get("empty") is not None:
            totals["empty"] = int(detail["empty"])
        return totals
    pages = [e["detail"] for e in visit["events"] if e["event"] == "searched"]
    totals = {"searches": len(pages)}
    totals.update({k: sum(int(p.get(k) or 0) for p in pages) for k in COUNTS})
    totals["empty"] = sum(1 for p in pages if not p.get("cards"))
    return totals


def _resolve(
    visit: Dict[str, Any],
    lease: Optional[Mapping[str, Any]],
    moved_on: bool,
    now: float,
    quiet: float,
) -> None:
    """Set the visit's outcome, reason and end from its steps, its lease, or
    the worker moving on."""
    last_at = visit["events"][-1]["at"]
    finished, stopped = _last(visit, "finished"), _last(visit, "stopped")
    released = _last(visit, "released")
    visit["reported"] = finished is not None or stopped is not None
    if finished is not None:
        visit.update(outcome="finished", ended_at=finished["at"])
    elif stopped is not None:
        detail = stopped["detail"]
        visit.update(
            outcome="stopped",
            reason=detail.get("reason"),
            wall=detail.get("wall"),
            error=detail.get("error"),
            ended_at=stopped["at"],
        )
    elif released is not None:
        visit.update(outcome="released", reason=released["detail"].get("reason"))
        visit["ended_at"] = released["at"]
    elif lease is not None and lease.get("closed_at"):
        # A queue worker on a monitor that does not report its cities: its
        # next ask closed the lease.
        visit.update(outcome="finished", ended_at=lease["closed_at"])
    elif lease is not None and _ts(lease["expires_at"]) <= now:
        visit.update(outcome="expired", ended_at=lease["expires_at"])
        visit["events"].append({"at": lease["expires_at"], "event": "expired", "detail": {}})
    elif moved_on or (not _has(visit, "handed", "started") and now - _ts(last_at) > quiet):
        # Pages only, from an older monitor, or a lost `finished`: the worker
        # went on to another city, or has said nothing for a while.
        visit.update(outcome="finished", ended_at=last_at)
    elif now - _ts(last_at) > quiet:
        visit.update(outcome="quiet", ended_at=None)
    else:
        visit.update(outcome="searching", ended_at=None)


def visits(
    events: Iterable[Mapping[str, Any]],
    leases: Iterable[Mapping[str, Any]],
    names: Mapping[str, str],
    now: float,
    quiet_minutes: float = QUIET_MINUTES,
) -> List[Dict[str, Any]]:
    """The visits in `events` (oldest first, as `city_events_since` returns
    them), newest first.

    `leases` are `city_leases_since` rows: a `handed` step finds its lease by
    worker, item, city and the second it was handed out. `names` maps a slug
    to its city name.
    """
    quiet = quiet_minutes * 60
    by_lease = {(r["worker_id"], r["item"], r["city"], r["leased_at"]): r for r in leases}
    found: List[Dict[str, Any]] = []
    current: Dict[str, Dict[str, Any]] = {}
    for row in events:
        event = {"at": row["at"], "event": row["event"], "detail": dict(row.get("detail") or {})}
        worker = row["worker_id"]
        visit = current.get(worker)
        same = visit is not None and (visit["item"], visit["city"]) == (row["item"], row["city"])
        if not same or _starts_anew(visit, event, quiet):
            if visit is not None:
                visit["moved_on"] = True
            visit = {
                "worker_id": worker,
                "item": row["item"],
                "city": row["city"],
                "moved_on": False,
                "events": [],
            }
            found.append(visit)
            current[worker] = visit
        visit["events"].append(event)

    out = []
    for visit in found:
        handed, started = _first(visit, "handed"), _first(visit, "started")
        lease = (
            by_lease.get((visit["worker_id"], visit["item"], visit["city"], handed["at"]))
            if handed is not None
            else None
        )
        visit.update(reason=None, wall=None, error=None)
        _resolve(visit, lease, visit.pop("moved_on"), now, quiet)
        report = _last(visit, "finished") or _last(visit, "stopped")
        started_at = visit["events"][0]["at"]
        if report is not None and report["detail"].get("seconds") is not None:
            seconds: Optional[int] = int(report["detail"]["seconds"])
        else:
            end = visit["ended_at"] or visit["events"][-1]["at"]
            seconds = max(0, round(_ts(end) - _ts(started_at)))
        via = "queue" if handed is not None else (started or {"detail": {}})["detail"].get("via")
        out.append(
            {
                "worker_id": visit["worker_id"],
                "item": visit["item"],
                "city": visit["city"],
                "name": names.get(visit["city"]),
                "via": via,
                "why": handed["detail"].get("why") if handed is not None else None,
                "outcome": visit["outcome"],
                "reason": visit["reason"],
                "wall": visit["wall"],
                "error": visit["error"],
                "reported": visit["reported"],
                "started_at": started_at,
                "ended_at": visit["ended_at"],
                "seconds": seconds,
                "totals": _totals(visit),
                "alerts": [
                    {"at": e["at"], **e["detail"]}
                    for e in visit["events"]
                    if e["event"] == "alerted"
                ],
                "events": visit["events"],
            }
        )
    out.sort(key=lambda v: v["started_at"], reverse=True)
    return out


def select(
    found: List[Dict[str, Any]],
    city: Optional[str] = None,
    item: Optional[str] = None,
    limit: int = MAX_VISITS,
) -> List[Dict[str, Any]]:
    """Narrowed after grouping, not before: a worker's steps on other cities
    are what end its visits here."""
    kept = [
        v
        for v in found
        if (city is None or v["city"] == city) and (item is None or v["item"] == item)
    ]
    return kept[:limit]


def _minutes(seconds: Optional[int]) -> str:
    if seconds is None:
        return "-"
    return f"{max(1, round(seconds / 60))} min" if seconds >= 30 else f"{seconds} s"


def summary(totals: Mapping[str, Any]) -> str:
    """The brief report: `3 searches, 84 cards, 9 opened, 5 reviewed, 1 alert`."""

    def n(count: int, one: str, many: str) -> str:
        return f"{count} {one if count == 1 else many}"

    parts = [
        n(totals.get("searches", 0), "search", "searches"),
        n(totals.get("cards", 0), "card", "cards"),
        f"{totals.get('opened', 0)} opened",
        f"{totals.get('reviewed', 0)} reviewed",
        n(totals.get("alerted", 0), "alert", "alerts"),
    ]
    if totals.get("empty"):
        parts.append(f"{totals['empty']} empty")
    return ", ".join(parts)


def outcome_text(visit: Mapping[str, Any]) -> str:
    outcome = visit["outcome"]
    if outcome == "stopped":
        reason = visit.get("reason") or "unknown"
        if visit.get("wall"):
            reason += f" ({visit['wall']})"
        return f"stopped: {reason}"
    if outcome == "released":
        return f"given back: {visit.get('reason') or 'unknown'}"
    if outcome == "finished" and not visit.get("reported"):
        return "finished (no report)"
    return {"quiet": "no word since", "searching": "searching now"}.get(outcome, outcome)


def event_text(event: Mapping[str, Any]) -> str:
    """One timeline line, after its time and step name."""
    kind, d = event["event"], event.get("detail") or {}
    if kind == "handed":
        return f"from the queue ({d.get('why') or '?'})"
    if kind == "started":
        via = {"queue": "from the queue", "own": "from its own list"}.get(d.get("via"), "")
        planned = d.get("searches")
        return " ".join(
            p for p in (f"{planned} searches planned" if planned is not None else "", via) if p
        )
    if kind == "searched":
        phrase = f'"{d["phrase"]}": ' if d.get("phrase") else ""
        return (
            f"{phrase}{d.get('cards', 0)} cards, {d.get('title_pass', 0)} past the title gate, "
            f"{d.get('opened', 0)} opened, {d.get('reviewed', 0)} reviewed, "
            f"{d.get('alerted', 0)} alerted"
        )
    if kind == "alerted":
        bits = [d.get("title") or d.get("listing_id") or "a listing"]
        if d.get("price"):
            bits.append(str(d["price"]))
        if d.get("score") is not None:
            bits.append(f"score {d['score']}")
        return ", ".join(bits)
    if kind in ("finished", "stopped"):
        text = f"{_minutes(d.get('seconds'))}: {summary(d)}"
        if kind == "stopped":
            reason = d.get("reason") or "unknown"
            if d.get("wall"):
                reason += f" ({d['wall']})"
            of = f" after {d.get('searches', 0)} of {d['of']} searches" if d.get("of") else ""
            text = f"{reason}{of}; {text}"
            if d.get("error"):
                text += f"; {d['error']}"
        return text
    if kind == "released":
        return f"the worker reported {d.get('reason') or 'something else'}; city back to the queue"
    if kind == "expired":
        return "no heartbeat; city back to the queue"
    return ""


def render(found: List[Dict[str, Any]], with_events: bool = False) -> List[str]:
    """`rsc queue log`: one line per visit, the timeline under it on request."""
    lines = []
    for v in found:
        span = v["started_at"][11:16]
        span += f"–{v['ended_at'][11:16]}" if v.get("ended_at") else "–…"
        where = v["name"] or v["city"]
        how = f"queue/{v['why']}" if v["via"] == "queue" and v.get("why") else v["via"] or "-"
        lines.append(
            f"{v['started_at'][:10]} {span:<11} {v['worker_id']:<11} {v['item'] or '-':<15} "
            f"{where:<24} {how:<15} {outcome_text(v):<26} {_minutes(v['seconds']):>7}  "
            f"{summary(v['totals'])}"
        )
        if with_events:
            for e in v["events"]:
                lines.append(f"    {e['at'][11:19]}  {e['event']:<9} {event_text(e)}")
    return lines
