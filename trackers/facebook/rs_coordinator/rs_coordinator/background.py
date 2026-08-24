"""The coordinator's background loop: deliver the outbox, sweep fleet liveness.

One daemon thread, two duties, both idempotent and driven entirely by the
database — so a coordinator restart resumes exactly where the last process
stopped, and the loop can be exercised in tests by calling `tick()` directly
with no thread and no clock.

Why alerts are delivered here and not in the request handler:

* **Durability.** The handler enqueues in the same database the listing went
  into and returns. Telegram being down now delays the alert instead of losing
  it; the old inline send had no second chance, and a listing whose alert
  failed classified as a duplicate on every later sighting — silently gone.
* **Latency.** `TelegramNotifier` enforces a 1 msg/sec floor by sleeping. A
  ten-listing batch therefore held the worker's HTTP request for 11+ seconds —
  longer than the worker's own 10 s timeout, so the worker retried a request
  that had actually succeeded. The pacing now happens on this thread, where a
  sleep costs nobody anything.

Delivery failures back off exponentially (5 s doubling to a 15-minute ceiling)
and are retried forever: an alert the operator never got is strictly worse
than one that arrives late, and the backlog is visible in /healthz and
`rsc status` long before it could matter.
"""

import logging
import threading
from datetime import timedelta
from typing import Any, Callable

from . import health
from .db import AnyDatabase, utcnow
from .health import _moment, _parse_ts  # shared clock helpers, tested there
from .telegram_notify import TelegramNotifier
from .telegram_topics import ensure_topic

logger = logging.getLogger(__name__)

# How often the loop looks for due alerts. Cheap (one indexed SELECT), so it
# can stay tight enough that an alert normally leaves within a couple seconds.
POLL_INTERVAL = 2.0

# How often the fleet's liveness is swept. DEAD means six hours of silence, so
# ten minutes of detection latency is noise on that scale.
SWEEP_INTERVAL = 600.0

# Retry backoff: 5 s, 10 s, 20 s ... capped at 15 minutes.
BACKOFF_BASE = 5.0
BACKOFF_CAP = 900.0


def backoff_seconds(attempts: int) -> float:
    """Delay before the next attempt, given how many have already failed."""
    return min(BACKOFF_CAP, BACKOFF_BASE * (2**attempts))


class Background(threading.Thread):
    """Drain the alert outbox and sweep worker liveness until stopped.

    Takes a `db_getter` rather than a database: the database is opened lazily
    (deps.get_db), and an unreachable one at boot must leave this thread
    retrying quietly rather than dead — the coordinator's whole job is to not
    lose things while the world flaps.
    """

    def __init__(
        self: "Background",
        db_getter: Callable[[], AnyDatabase],
        notifier: TelegramNotifier,
        ops_notifier: TelegramNotifier,
        warroom_notifier: TelegramNotifier | None = None,
    ) -> None:
        super().__init__(name="rs-background", daemon=True)
        self._db = db_getter
        self._notifier = notifier
        self._ops_notifier = ops_notifier
        # Where per-buyer Messenger alerts go: a Topics-enabled war-room
        # supergroup, one forum topic per conversation. None when no war room is
        # configured — then buyer alerts fall back to the listings notifier's
        # General with no topic routing, exactly as before the router existed.
        self._warroom_notifier = warroom_notifier
        self._stop = threading.Event()
        self._last_sweep = 0.0

    def stop(self: "Background") -> None:
        self._stop.set()

    def run(self: "Background") -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the loop must outlive any one failure
                logger.exception("Background tick failed; will retry")
            self._stop.wait(POLL_INTERVAL)

    # -- one pass, callable synchronously from tests -----------------------

    def tick(self: "Background") -> None:
        db = self._db()
        self.drain_outbox(db)
        now = _moment(None).timestamp()
        if now - self._last_sweep >= SWEEP_INTERVAL:
            self._last_sweep = now
            self.sweep_liveness(db)

    def drain_outbox(self: "Background", db: AnyDatabase) -> None:
        for alert in db.due_alerts():
            kind = alert["kind"]
            message_thread_id = None
            if kind.startswith("ops"):
                sender = self._ops_notifier
            elif kind.startswith("message") and self._warroom_notifier is not None:
                # Per-buyer Messenger alert with a war room configured: route it
                # to the conversation's forum topic, opening one on first need.
                # For message alerts `dedupe_key` carries the FB thread id (see
                # routers/messages).
                sender = self._warroom_notifier
                ref = alert.get("dedupe_key")
                thread = db.get_thread(ref) if ref else None
                if thread:
                    message_thread_id = ensure_topic(db, sender, thread)
            else:
                # No war room (or a listing alert): the pre-router path — the
                # listings notifier's General, no topic.
                sender = self._notifier
            try:
                delivered = sender.send(alert["text"], message_thread_id=message_thread_id)
                error = "send returned False"
            except Exception as e:  # noqa: BLE001 - a failed send is a retry, never a crash
                delivered = False
                error = f"{type(e).__name__}: {e}"

            if delivered:
                db.mark_alert_delivered(alert["id"])
                # notified_at means "the alert actually reached Telegram", so a
                # Telegram inbox can be reconciled against the listings table.
                if kind.startswith("listing") and alert.get("dedupe_key"):
                    db.update_listing(alert["dedupe_key"], {"notified_at": utcnow()})
            else:
                retry_at = _retry_stamp(backoff_seconds(int(alert["attempts"] or 0)))
                db.mark_alert_failed(alert["id"], error, retry_at)
                logger.warning(
                    "Alert %s (%s) not delivered, attempt %s: %s",
                    alert["id"],
                    alert["kind"],
                    int(alert["attempts"] or 0) + 1,
                    error,
                )

    def sweep_liveness(self: "Background", db: AnyDatabase) -> None:
        """Page ops once when a worker falls silent, once when it returns.

        The alert goes through the outbox like everything else, so a dead
        worker discovered during a Telegram outage is still reported when
        Telegram returns. The marker is written at enqueue time — not
        delivery — so the sweep never queues the same crossing twice.
        """
        for worker_id, text, marker in health.liveness_sweep(db.list_workers()):
            db.enqueue_alert("ops_liveness", text)
            db.update_worker_health(worker_id, {"alerted_liveness": marker})


def _retry_stamp(delay: float) -> str:
    """An ISO timestamp `delay` seconds from now, in utcnow()'s exact format."""
    moment = _parse_ts(utcnow())
    assert moment is not None  # utcnow() is always parseable
    return (moment + timedelta(seconds=delay)).isoformat(timespec="seconds")
