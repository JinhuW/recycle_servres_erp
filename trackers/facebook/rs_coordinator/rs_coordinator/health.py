"""Derived fleet health: liveness, session expiry, and alert transitions.

Workers report raw facts on every heartbeat (a state, a session expiry, an
error count). Turning those facts into "something is wrong here" is the control
plane's job, and it lives in this module rather than in the router so it can be
exercised against an injected clock instead of the wall clock.

The transition logic exists for one reason: a worker heartbeats every couple of
minutes, so alerting on a *condition* would fire hundreds of times for a single
stuck CAPTCHA and ops would learn to ignore the channel. Alerts fire on a
*change* only — `transition_alert` returns text once, when the fleet crosses a
line, and None for every heartbeat that merely restates it.

Heartbeat transitions cannot notice a worker that went *dead*, because a dead
worker sends no heartbeat to react to. That case is `liveness_sweep` below:
the background loop (background.py) walks `list_workers()` on an interval and
this module decides, statelessly, which rows have crossed a line since the last
alert — the `alerted_liveness` column on the row is the memory, so a
coordinator restart does not re-page ops about a worker it already reported.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from .schemas import WorkerState
from .telegram_notify import escape_markdown

# Liveness thresholds. The fleet searches on a 45-75 minute jittered interval,
# so silence for an hour is normal operation, not a fault. Two hours means a
# worker missed a whole cycle; six means it missed several and is not coming
# back without help. Tune these here rather than at the call sites.
STALE_AFTER = timedelta(hours=2)
DEAD_AFTER = timedelta(hours=6)

# A Facebook session that lapses unattended costs that worker days of downtime,
# and renewing it needs a human with access to the account. Two weeks of notice
# is enough to schedule that without it becoming a standing alarm.
EXPIRY_WARN_DAYS = 14.0

LIVE = "live"
STALE = "stale"
DEAD = "dead"
UNKNOWN = "unknown"

_SECONDS_PER_DAY = 86400.0


def _parse_ts(value: str | None) -> Optional[datetime]:
    """Parse an ISO timestamp, tolerating a 'Z' suffix and naive stamps.

    Workers are not all on the same release, so timestamps arrive both
    timezone-aware (what `db.utcnow` writes) and naive. Naive is read as UTC —
    the whole fleet runs on UTC — and an unparseable value returns None rather
    than raising, because a cosmetic format drift must never turn into a failed
    heartbeat.
    """
    if not value:
        return None
    text = str(value).strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _moment(now: datetime | None) -> datetime:
    """The instant to measure against — injected in tests, wall clock in prod."""
    if now is None:
        return datetime.now(timezone.utc)
    return now if now.tzinfo else now.replace(tzinfo=timezone.utc)


def _state_of(row: Dict[str, Any] | None) -> Optional[WorkerState]:
    """The row's state as an enum, or None if absent or from a newer worker."""
    raw = (row or {}).get("state")
    if not raw:
        return None
    try:
        return WorkerState(raw)
    except ValueError:
        return None


def liveness(last_heartbeat_at: str | None, now: datetime | None = None) -> str:
    """How recently a worker checked in: live / stale / dead / unknown.

    'unknown' is deliberately distinct from 'dead': a worker that has never
    reported is a deployment that never started, which is a different problem
    from one that stopped.
    """
    stamp = _parse_ts(last_heartbeat_at)
    if stamp is None:
        return UNKNOWN

    age = _moment(now) - stamp
    if age < STALE_AFTER:
        return LIVE
    if age < DEAD_AFTER:
        return STALE
    return DEAD


def session_days_left(session_expiry: str | None, now: datetime | None = None) -> Optional[float]:
    """Days until the stored session lapses. Negative once it already has.

    None means the worker has not told us when its session expires, which is
    not the same as "expires soon" — an unknown expiry must not raise an alarm
    on every worker that predates the field.
    """
    expiry = _parse_ts(session_expiry)
    if expiry is None:
        return None
    return (expiry - _moment(now)).total_seconds() / _SECONDS_PER_DAY


def needs_attention(row: Dict[str, Any], now: datetime | None = None) -> bool:
    """Whether a human should look at this worker.

    Three ways to earn it: it stopped reporting, it reported a non-HEALTHY
    state, or its session is inside the warning window. `now` is optional so
    callers keep the documented one-argument form.
    """
    if liveness(row.get("last_heartbeat_at"), now) == DEAD:
        return True

    state = _state_of(row)
    if state is not None and state.is_bad:
        return True

    days = session_days_left(row.get("session_expiry"), now)
    return days is not None and days <= EXPIRY_WARN_DAYS


def enrich(row: Dict[str, Any], now: datetime | None = None) -> Dict[str, Any]:
    """A worker row plus the fields the console needs but nobody stores.

    Derived on read instead of written on heartbeat, because liveness decays
    with the clock: a row written an hour ago is stale now without anything
    having changed in the database.
    """
    moment = _moment(now)
    days = session_days_left(row.get("session_expiry"), moment)
    return {
        **row,
        "liveness": liveness(row.get("last_heartbeat_at"), moment),
        "session_days_left": None if days is None else round(days, 2),
        "needs_attention": needs_attention(row, moment),
    }


def liveness_sweep(
    rows: List[Dict[str, Any]], now: datetime | None = None
) -> List[Tuple[str, str, Optional[str]]]:
    """Alerts for workers that fell silent, or came back, since the last sweep.

    Returns `(worker_id, alert_text, new_alerted_liveness)` triples; the caller
    sends the text and persists the marker, so each crossing alerts exactly
    once. Only DEAD is paged: STALE is one missed cycle, which the jittered
    search interval produces in normal operation, and UNKNOWN is a deployment
    that never started — visible in `rsc status`, but there is no "since" to
    have crossed. Text is MarkdownV2, already escaped.
    """
    moment = _moment(now)
    alerts: List[Tuple[str, str, Optional[str]]] = []
    for row in rows:
        worker_id = str(row.get("worker_id") or "")
        state = liveness(row.get("last_heartbeat_at"), moment)
        alerted = row.get("alerted_liveness")
        name = escape_markdown(worker_id)
        if state == DEAD and alerted != DEAD:
            beat = escape_markdown(str(row.get("last_heartbeat_at") or "never"))
            alerts.append(
                (
                    worker_id,
                    f"*Worker {name} stopped reporting*\nLast heartbeat: {beat}",
                    DEAD,
                )
            )
        elif state == LIVE and alerted == DEAD:
            alerts.append((worker_id, f"*Worker {name} is reporting again*", None))
    return alerts


def transition_alert(
    previous: Dict[str, Any] | None,
    incoming_state: str | None,
    worker_id: str,
    row: Dict[str, Any],
    now: datetime | None = None,
) -> Optional[str]:
    """Ops alert text for a meaningful change, or None to stay quiet.

    Alerting on the *condition* would page ops on every heartbeat for as long
    as a worker is stuck, so this compares the heartbeat against what the
    worker last reported and speaks only on a crossing:

      * entering a bad state from a good or unknown one, or escalating from one
        bad state into a different one (DEGRADED -> CHALLENGE_CAPTCHA matters);
      * recovering into HEALTHY from a bad state, so the channel closes its own
        loops instead of leaving ops guessing;
      * the session expiry crossing into the warning window.

    Expiry is measured twice — once as of the previous heartbeat, once as of
    now — rather than comparing the two expiry strings. A worker usually keeps
    reporting the same expiry while the deadline approaches, so comparing
    strings would never see the crossing; comparing days-remaining at the two
    instants fires exactly on the heartbeat that crosses it and never again.

    Returns MarkdownV2 already escaped, so the caller hands it straight to
    `TelegramNotifier.send` without a second escaping pass.
    """
    moment = _moment(now)
    previous_state = _state_of(previous)
    new_state: Optional[WorkerState] = None
    if incoming_state:
        try:
            new_state = WorkerState(incoming_state)
        except ValueError:
            # A worker on a newer release reporting a state we do not know is
            # not an emergency; the raw value is still stored on the row.
            new_state = None

    lines: List[str] = []
    name = escape_markdown(worker_id)

    if new_state is not None and new_state is not previous_state:
        prior = escape_markdown(previous_state.value if previous_state else "unknown")
        if new_state.is_bad:
            what = "needs a human" if new_state.needs_human else "is unhealthy"
            lines.append(f"*Worker {name} {escape_markdown(what)}*")
            lines.append(f"State: {escape_markdown(new_state.value)} \\(was {prior}\\)")
            account = row.get("account_id")
            if account:
                lines.append(f"Account: {escape_markdown(str(account))}")
            vnc = row.get("vnc_url")
            if vnc:
                lines.append(f"VNC: {escape_markdown(str(vnc))}")
        elif previous_state is not None and previous_state.is_bad:
            lines.append(f"*Worker {name} recovered*")
            lines.append(f"State: {escape_markdown(new_state.value)} \\(was {prior}\\)")

    # The previous heartbeat's own timestamp is the "before" instant; without
    # one (a worker's first report) there is nothing to have crossed, so both
    # readings are taken now and only an already-expiring session speaks up.
    before = _parse_ts((previous or {}).get("last_heartbeat_at")) or moment
    was = session_days_left((previous or {}).get("session_expiry"), before)
    remaining = session_days_left(row.get("session_expiry"), moment)
    crossed_in = was is None or was > EXPIRY_WARN_DAYS
    if remaining is not None and remaining <= EXPIRY_WARN_DAYS and crossed_in:
        if remaining <= 0:
            lines.append(f"*Session expired: {name}*")
        else:
            lines.append(
                f"*Session expiring: {name}*\n"
                f"Expires in {escape_markdown(f'{remaining:.1f}')} days"
            )

    return "\n".join(lines) if lines else None
