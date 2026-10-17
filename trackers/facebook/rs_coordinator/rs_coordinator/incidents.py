"""Fleet-wide incident dedup: one page per outage, however many workers see it.

Workers used to announce an AI outage themselves, one "DOWN" note per process
and a "recovered" note on the next evaluation that worked. With six workers
sharing one OpenRouter key, a flapping provider produced hundreds of paired
notes a day — ops learned to mute the channel, which is the one thing an alert
channel must never teach.

Workers now report the *fact* ("worker X sees the AI down" / "working again")
here, and this module decides when that fact is news. The rules are the same
shape as `health.transition_alert`: speak on a crossing, never on a condition.

  * The first `down` report for a key opens an incident and pages ops once.
    Further `down` reports from any worker while it is open are absorbed.
  * The incident closes when every worker that voted `down` has reported
    `up` (or its vote aged out — a worker that was stopped mid-outage must not
    hold the incident open forever). Closing sends one "recovered" note, and
    only if the opening was paged.
  * A key that re-opens within `cooldown` of its last page re-opens silently,
    and a silent open closes silently. So a provider that flaps all day costs
    at most two messages per cooldown window, fleet-wide, instead of two per
    listing per worker.

`apply` is pure: it takes the stored row (or None for a first report), returns the row to store
and the MarkdownV2 text to send (or None). The router owns the clock, the
database and the outbox; the tests own an injected clock.
"""

import json
import os
from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Tuple

from .health import _moment, _parse_ts
from .telegram_notify import escape_markdown

# One page per key per window. Six hours is long enough that a provider which
# flaps for an afternoon is one conversation, short enough that "it broke
# again tonight" is still reported as its own event.
DEFAULT_COOLDOWN = timedelta(hours=6)
# A `down` vote nobody has renewed or withdrawn in a day belongs to a worker
# that is no longer running; it stops counting toward "still open".
DEFAULT_VOTE_TTL = timedelta(hours=24)

DOWN = "down"
UP = "up"

# Human names for the keys workers report. An unknown key is shown verbatim,
# so a new kind of incident needs no coordinator release to be legible.
TITLES = {
    "ai_unavailable": "AI evaluation",
}


def _hours_env(name: str, default: timedelta) -> timedelta:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        hours = float(raw)
    except ValueError:
        return default
    return timedelta(hours=hours) if hours > 0 else default


def cooldown_from_env() -> timedelta:
    return _hours_env("RS_INCIDENT_COOLDOWN_HOURS", DEFAULT_COOLDOWN)


def vote_ttl_from_env() -> timedelta:
    return _hours_env("RS_INCIDENT_VOTE_TTL_HOURS", DEFAULT_VOTE_TTL)


def new_row(key: str) -> Dict[str, Any]:
    return {
        "key": key,
        "is_open": 0,
        "opened_at": None,
        "closed_at": None,
        "last_reported_at": None,
        "last_alerted_at": None,
        # Whether the *current* opening was paged; decides if closing speaks.
        "alerted": 0,
        "detail": None,
        "reporters": "{}",
    }


def _votes(row: Dict[str, Any], moment: datetime, ttl: timedelta) -> Dict[str, str]:
    """Live `down` votes: worker id -> ISO stamp of its latest report."""
    try:
        raw = json.loads(row.get("reporters") or "{}")
    except ValueError:
        raw = {}
    live: Dict[str, str] = {}
    for worker_id, stamp in (raw or {}).items():
        when = _parse_ts(stamp)
        if when is not None and moment - when < ttl:
            live[str(worker_id)] = str(stamp)
    return live


def title_for(key: str) -> str:
    return TITLES.get(key, key)


def _down_text(key: str, worker_id: str, detail: str | None, cooldown: timedelta) -> str:
    hours = cooldown.total_seconds() / 3600
    window = f"{hours:g}"
    lines = [
        f"*{escape_markdown(title_for(key))} DOWN*",
        f"First reported by {escape_markdown(worker_id)}",
    ]
    if detail:
        lines.append(escape_markdown(detail[:300]))
    lines.append(
        escape_markdown(
            f"Listings are withheld until it recovers. Further reports from any worker, "
            f"and any relapse within {window} h, stay quiet."
        )
    )
    return "\n".join(lines)


def _up_text(key: str) -> str:
    return (
        f"*{escape_markdown(title_for(key))} recovered*\n"
        + escape_markdown("Every worker that reported it is evaluating again.")
    )


def apply(
    key: str,
    row: Optional[Dict[str, Any]],
    worker_id: str,
    state: str,
    detail: str | None = None,
    now: datetime | None = None,
    cooldown: timedelta = DEFAULT_COOLDOWN,
    vote_ttl: timedelta = DEFAULT_VOTE_TTL,
) -> Tuple[Dict[str, Any], Optional[str]]:
    """Fold one worker report into the incident row; return (row, alert text)."""
    if state not in (DOWN, UP):
        raise ValueError(f"state must be '{DOWN}' or '{UP}', not {state!r}")
    moment = _moment(now)
    stamp = moment.isoformat()
    current = dict(row) if row else new_row(key)

    votes = _votes(current, moment, vote_ttl)
    text: Optional[str] = None
    current["last_reported_at"] = stamp

    if state == DOWN:
        votes[worker_id] = stamp
        if detail:
            current["detail"] = detail[:300]
        if not current.get("is_open"):
            current["is_open"] = 1
            current["opened_at"] = stamp
            current["closed_at"] = None
            last_paged = _parse_ts(current.get("last_alerted_at"))
            if last_paged is None or moment - last_paged >= cooldown:
                current["last_alerted_at"] = stamp
                current["alerted"] = 1
                text = _down_text(current["key"], worker_id, detail, cooldown)
            else:
                current["alerted"] = 0
        # Already open: absorbed. The vote refresh above is the only change.
    else:
        # A worker's first-ever report being `up` (fresh process, healthy AI)
        # is not a vote and closes nothing.
        votes.pop(worker_id, None)
        if current.get("is_open") and not votes:
            current["is_open"] = 0
            current["closed_at"] = stamp
            if current.get("alerted"):
                text = _up_text(current["key"])
            current["alerted"] = 0

    current["reporters"] = json.dumps(votes, sort_keys=True)
    return current, text
