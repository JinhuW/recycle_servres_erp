"""The alert outbox: a Telegram outage delays alerts instead of losing them.

The scenario all of this exists for: a listing cleared the rating threshold
while Telegram was down. Before the outbox, the listing row was committed and
the send attempted exactly once, inline — so the alert was gone (the next
sighting classified as DUPLICATE) and nothing recorded that it had ever been
owed. Every test here is some corner of "the alert is owed until it is paid".
"""

from datetime import datetime, timedelta, timezone

from rs_coordinator import health
from rs_coordinator.background import Background, backoff_seconds
from rs_coordinator.db import Database, utcnow


class StubNotifier:
    """Scriptable stand-in: returns (or raises) each queued outcome in turn."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.sent = []
        # Set so telegram_topics.ensure_topic treats it as "not configured" and
        # never tries to open a real forum topic during a drain.
        self.token = None
        self.chat_id = None

    def send(self, text, message_thread_id=None):
        outcome = self.outcomes.pop(0) if self.outcomes else True
        if isinstance(outcome, Exception):
            raise outcome
        if outcome:
            self.sent.append(text)
        return outcome


def make_pump(db, notifier=None, ops=None):
    return Background(lambda: db, notifier or StubNotifier([]), ops or StubNotifier([]))


def past(hours=0.0, seconds=0.0):
    moment = datetime.now(timezone.utc) - timedelta(hours=hours, seconds=seconds)
    return moment.isoformat(timespec="seconds")


# -- delivery ---------------------------------------------------------------


def test_a_queued_alert_is_delivered_and_marked(tmp_path):
    db = Database(tmp_path / "outbox.db")
    db.enqueue_alert("listing_new", "hello")
    notifier = StubNotifier([True])

    make_pump(db, notifier).drain_outbox(db)

    assert notifier.sent == ["hello"]
    assert db.outbox_backlog() == 0
    assert db.due_alerts() == []


def test_only_delivered_listing_alerts_count_as_sent(tmp_path):
    db = Database(tmp_path / "outbox.db")
    db.enqueue_alert("listing_new", "first")
    db.enqueue_alert("listing_new", "second")
    db.enqueue_alert("ops_worker_down", "ops")

    make_pump(db, StubNotifier([True, False])).drain_outbox(db)

    (day,) = db.review_stats_daily(1)
    assert day["sent"] == 1


def test_a_failed_send_is_retried_not_lost(tmp_path):
    db = Database(tmp_path / "outbox.db")
    alert_id = db.enqueue_alert("listing_new", "hello")
    pump = make_pump(db, StubNotifier([False]))

    pump.drain_outbox(db)

    # Still owed: attempts counted, error recorded, next attempt in the future.
    assert db.outbox_backlog() == 1
    (row,) = [a for a in _all_outbox(db) if a["id"] == alert_id]
    assert row["attempts"] == 1
    assert row["last_error"] == "send returned False"
    assert row["next_attempt_at"] > utcnow()

    # Once due again, a healthy Telegram gets it.
    db.mark_alert_failed(alert_id, "still down", past(seconds=1))
    notifier = StubNotifier([True])
    make_pump(db, notifier).drain_outbox(db)
    assert notifier.sent == ["hello"]
    assert db.outbox_backlog() == 0


def test_a_raising_notifier_neither_crashes_nor_loses_the_alert(tmp_path):
    db = Database(tmp_path / "outbox.db")
    db.enqueue_alert("listing_new", "hello")

    make_pump(db, StubNotifier([RuntimeError("bad status line")])).drain_outbox(db)

    assert db.outbox_backlog() == 1
    (row,) = _all_outbox(db)
    assert "RuntimeError" in row["last_error"]


def test_a_backed_off_alert_is_not_hammered(tmp_path):
    db = Database(tmp_path / "outbox.db")
    db.enqueue_alert("listing_new", "hello")
    notifier = StubNotifier([False])
    pump = make_pump(db, notifier)

    pump.drain_outbox(db)
    pump.drain_outbox(db)  # immediately again — next_attempt_at is not due

    (row,) = _all_outbox(db)
    assert row["attempts"] == 1


def test_delivery_survives_a_process_restart(tmp_path):
    first = Database(tmp_path / "outbox.db")
    first.enqueue_alert("listing_new", "hello")
    first.close()

    reopened = Database(tmp_path / "outbox.db")
    notifier = StubNotifier([True])
    make_pump(reopened, notifier).drain_outbox(reopened)
    assert notifier.sent == ["hello"]


def test_delivering_a_listing_alert_stamps_notified_at(tmp_path):
    """notified_at means "actually reached Telegram", so the chat and the table
    reconcile one to one — the same property the [Alert] verdict line has."""
    db = Database(tmp_path / "outbox.db")
    now = utcnow()
    db.claim_listing(
        {
            "dedupe_key": "k1",
            "marketplace": "facebook",
            "listing_id": "1",
            "first_seen_at": now,
            "last_seen_at": now,
        }
    )
    db.enqueue_alert("listing_new", "hello", dedupe_key="k1")

    make_pump(db, StubNotifier([True])).drain_outbox(db)
    assert db.get_listing("k1")["notified_at"] is not None

    # And not before delivery.
    db.enqueue_alert("listing_new", "again", dedupe_key="k1")
    db.update_listing("k1", {"notified_at": None})
    make_pump(db, StubNotifier([False])).drain_outbox(db)
    assert db.get_listing("k1")["notified_at"] is None


def test_ops_alerts_go_to_the_ops_notifier(tmp_path):
    db = Database(tmp_path / "outbox.db")
    db.enqueue_alert("ops_liveness", "worker down")
    db.enqueue_alert("listing_new", "a find")
    listings, ops = StubNotifier([True]), StubNotifier([True])

    make_pump(db, listings, ops).drain_outbox(db)

    assert listings.sent == ["a find"]
    assert ops.sent == ["worker down"]


def test_backoff_grows_and_caps():
    delays = [backoff_seconds(n) for n in range(12)]
    assert delays == sorted(delays)
    assert delays[0] == 5.0
    assert delays[-1] == 900.0


# -- liveness sweep ---------------------------------------------------------


def test_a_dead_worker_is_paged_once_and_recovery_closes_the_loop(tmp_path):
    db = Database(tmp_path / "sweep.db")
    db.upsert_worker("denver-1", status="ok", heartbeat=True)
    db.update_worker_health("denver-1", {"last_heartbeat_at": past(hours=7)})
    pump = make_pump(db)

    pump.sweep_liveness(db)
    pump.sweep_liveness(db)  # the second sweep must stay quiet

    alerts = [a for a in _all_outbox(db) if a["kind"] == "ops_liveness"]
    assert len(alerts) == 1
    assert "stopped reporting" in alerts[0]["text"]
    assert db.get_worker("denver-1")["alerted_liveness"] == health.DEAD

    # The worker comes back: one recovery alert, marker cleared.
    db.update_worker_health("denver-1", {"last_heartbeat_at": utcnow()})
    pump.sweep_liveness(db)
    pump.sweep_liveness(db)
    alerts = [a for a in _all_outbox(db) if a["kind"] == "ops_liveness"]
    assert len(alerts) == 2
    assert "reporting again" in alerts[1]["text"]
    assert db.get_worker("denver-1")["alerted_liveness"] is None


def test_stale_and_never_seen_workers_do_not_page(tmp_path):
    db = Database(tmp_path / "sweep.db")
    db.upsert_worker("ne-1", status="ok", heartbeat=True)
    db.update_worker_health("ne-1", {"last_heartbeat_at": past(hours=3)})  # STALE
    db.upsert_worker("wc-1", status="ok")  # never heartbeated: UNKNOWN

    make_pump(db).sweep_liveness(db)

    assert [a for a in _all_outbox(db) if a["kind"] == "ops_liveness"] == []


def test_the_sweep_logs_a_silent_worker_going_stale_then_dead(tmp_path):
    db = Database(tmp_path / "sweep.db")
    db.upsert_worker("denver-1", status="ok", heartbeat=True)
    pump = make_pump(db)
    pump.sweep_liveness(db)  # baseline: live, nothing logged
    assert db.get_worker("denver-1")["logged_liveness"] == health.LIVE

    db.update_worker_health("denver-1", {"last_heartbeat_at": past(hours=3)})
    pump.sweep_liveness(db)
    pump.sweep_liveness(db)  # the second sweep must not log it again
    db.update_worker_health("denver-1", {"last_heartbeat_at": past(hours=7)})
    pump.sweep_liveness(db)

    rows = db.status_events_since(past(hours=24), 10)
    assert [(r["was"], r["became"]) for r in rows] == [("stale", "dead"), ("live", "stale")]
    assert db.get_worker("denver-1")["logged_liveness"] == health.DEAD


def _all_outbox(db):
    with db.cursor() as cur:
        cur.execute("SELECT * FROM outbox ORDER BY id")
        return [dict(row) for row in cur.fetchall()]
