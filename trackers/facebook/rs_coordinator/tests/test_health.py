"""Fleet health: derived liveness, session expiry, and alert-on-change.

The clock is injected everywhere rather than slept on, so a build machine under
load cannot flip a threshold. The API tests pin the property that keeps the ops
channel usable: a stuck worker is announced once, not once per heartbeat.
"""

import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from rs_coordinator import health
from rs_coordinator.health import (
    DEAD,
    DEAD_AFTER,
    EXPIRY_WARN_DAYS,
    LIVE,
    LIVENESS_CHANGE,
    STALE,
    STALE_AFTER,
    STATE_CHANGE,
    UNKNOWN,
    StatusChange,
    enrich,
    liveness,
    liveness_changes,
    liveness_log_sweep,
    needs_attention,
    session_days_left,
    state_change,
    transition_alert,
)

NOW = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)


def ago(**delta) -> str:
    return (NOW - timedelta(**delta)).isoformat(timespec="seconds")


def ahead(**delta) -> str:
    return (NOW + timedelta(**delta)).isoformat(timespec="seconds")


def worker_row(**overrides) -> dict:
    row = {
        "worker_id": "denver-1",
        "state": "HEALTHY",
        "status": "ok",
        "region": "rs_mountain",
        "account_id": "denver",
        "session_expiry": ahead(days=60),
        "last_heartbeat_at": ago(minutes=3),
        "error_count": 0,
    }
    row.update(overrides)
    return row


# -- liveness --------------------------------------------------------------


@pytest.mark.parametrize(
    "stamp,expected",
    [
        (ago(seconds=30), LIVE),
        # An hour of silence is a normal 45-75 minute search cycle, not a fault.
        (ago(minutes=75), LIVE),
        (ago(hours=1, minutes=59), LIVE),
        (ago(hours=2, minutes=1), STALE),
        (ago(hours=5), STALE),
        (ago(hours=6, minutes=1), DEAD),
        (ago(days=3), DEAD),
    ],
)
def test_liveness_thresholds(stamp, expected):
    assert liveness(stamp, NOW) == expected


def test_liveness_is_unknown_when_a_worker_never_reported():
    # Distinct from dead: a deployment that never started is a different bug
    # from one that stopped.
    assert liveness(None, NOW) == UNKNOWN
    assert liveness("", NOW) == UNKNOWN
    assert liveness("not-a-timestamp", NOW) == UNKNOWN


def test_naive_and_zulu_timestamps_are_read_as_utc():
    naive = NOW.replace(tzinfo=None).isoformat(timespec="seconds")
    zulu = NOW.replace(tzinfo=None).isoformat(timespec="seconds") + "Z"
    assert liveness(naive, NOW) == LIVE
    assert liveness(zulu, NOW) == LIVE


def test_thresholds_are_ordered():
    assert health.STALE_AFTER < health.DEAD_AFTER


# -- session expiry --------------------------------------------------------


def test_session_days_left():
    assert session_days_left(ahead(days=30), NOW) == pytest.approx(30.0, abs=0.01)
    assert session_days_left(ahead(hours=12), NOW) == pytest.approx(0.5, abs=0.01)
    # Already lapsed reads negative rather than clamping, so the console can
    # tell "expires today" from "expired a week ago".
    assert session_days_left(ago(days=7), NOW) == pytest.approx(-7.0, abs=0.01)
    assert session_days_left(None, NOW) is None
    assert session_days_left("garbage", NOW) is None


# -- needs_attention -------------------------------------------------------


def test_a_healthy_live_worker_needs_nothing():
    assert needs_attention(worker_row(), NOW) is False


def test_a_dead_worker_needs_attention():
    assert needs_attention(worker_row(last_heartbeat_at=ago(hours=9)), NOW) is True
    # Stale on its own is not worth waking anyone; it is one missed cycle.
    assert needs_attention(worker_row(last_heartbeat_at=ago(hours=3)), NOW) is False


@pytest.mark.parametrize(
    "state", ["DEGRADED", "SESSION_EXPIRED", "CHALLENGE_CAPTCHA", "CHECKPOINT", "DEAD"]
)
def test_any_bad_state_needs_attention(state):
    assert needs_attention(worker_row(state=state), NOW) is True


def test_expiring_session_needs_attention():
    assert needs_attention(worker_row(session_expiry=ahead(days=3)), NOW) is True
    assert (
        needs_attention(worker_row(session_expiry=ahead(days=EXPIRY_WARN_DAYS + 1)), NOW) is False
    )
    # An unreported expiry is unknown, not urgent.
    assert needs_attention(worker_row(session_expiry=None), NOW) is False


def test_an_unknown_state_from_a_newer_worker_is_not_an_alarm():
    assert needs_attention(worker_row(state="TELEPORTING"), NOW) is False


# -- enrich ----------------------------------------------------------------


def test_enrich_adds_derived_fields_without_dropping_the_row():
    enriched = enrich(worker_row(last_heartbeat_at=ago(hours=4)), NOW)
    assert enriched["worker_id"] == "denver-1"
    assert enriched["region"] == "rs_mountain"
    assert enriched["liveness"] == STALE
    assert enriched["session_days_left"] == pytest.approx(60.0, abs=0.01)
    assert enriched["needs_attention"] is False


def test_enrich_handles_a_row_that_never_reported():
    enriched = enrich({"worker_id": "new-1"}, NOW)
    assert enriched["liveness"] == UNKNOWN
    assert enriched["session_days_left"] is None
    assert enriched["needs_attention"] is False


# -- transition alerts -----------------------------------------------------


def test_entering_a_bad_state_alerts_once():
    previous = worker_row()
    row = worker_row(state="CHALLENGE_CAPTCHA", vnc_url="http://vnc.internal:6080")
    first = transition_alert(previous, "CHALLENGE_CAPTCHA", "denver-1", row, NOW)
    assert first is not None
    assert "CHALLENGE" in first and "needs a human" in first
    assert "vnc" in first

    # The worker is still stuck and keeps heartbeating; ops already knows.
    later = transition_alert(row, "CHALLENGE_CAPTCHA", "denver-1", row, NOW)
    assert later is None


def test_a_first_heartbeat_in_a_bad_state_alerts():
    row = worker_row(state="SESSION_EXPIRED")
    assert transition_alert(None, "SESSION_EXPIRED", "denver-1", row, NOW) is not None


def test_escalating_between_bad_states_alerts_again():
    previous = worker_row(state="DEGRADED")
    row = worker_row(state="CHECKPOINT")
    alert = transition_alert(previous, "CHECKPOINT", "denver-1", row, NOW)
    assert alert is not None
    assert "DEGRADED" in alert  # says what it came from


def test_steady_healthy_heartbeats_are_silent():
    row = worker_row()
    assert transition_alert(row, "HEALTHY", "denver-1", row, NOW) is None
    assert transition_alert(None, "HEALTHY", "denver-1", row, NOW) is None
    # A heartbeat that reports no state at all cannot be a state transition.
    assert transition_alert(row, None, "denver-1", row, NOW) is None


def test_recovery_closes_the_loop_once():
    previous = worker_row(state="CHALLENGE_CAPTCHA")
    row = worker_row(state="HEALTHY")
    alert = transition_alert(previous, "HEALTHY", "denver-1", row, NOW)
    assert alert is not None and "recovered" in alert
    assert transition_alert(row, "HEALTHY", "denver-1", row, NOW) is None


def test_expiry_warning_fires_on_the_crossing_and_not_after():
    """The reported expiry never changes; only the clock moves.

    Comparing the two expiry strings would never see this, which is why the
    crossing is measured as days-remaining at each heartbeat's own instant.
    """
    expiry = ahead(days=EXPIRY_WARN_DAYS + 1)
    row = worker_row(session_expiry=expiry)

    def heartbeat_at(moment):
        previous = worker_row(
            session_expiry=expiry,
            last_heartbeat_at=(moment - timedelta(minutes=5)).isoformat(timespec="seconds"),
        )
        return transition_alert(previous, "HEALTHY", "denver-1", row, moment)

    # The session drops under EXPIRY_WARN_DAYS one day from NOW.
    boundary = NOW + timedelta(days=1)

    # Comfortably outside the window: nothing to say.
    assert heartbeat_at(boundary - timedelta(hours=6)) is None

    # The first heartbeat past the boundary is the one that speaks.
    alert = heartbeat_at(boundary + timedelta(minutes=1))
    assert alert is not None and "expiring" in alert.lower()

    # …and every heartbeat after it is quiet again, forever.
    assert heartbeat_at(boundary + timedelta(minutes=6)) is None
    assert heartbeat_at(boundary + timedelta(days=3)) is None


def test_an_already_expired_session_is_reported_as_expired():
    row = worker_row(session_expiry=ago(days=2))
    alert = transition_alert(None, "HEALTHY", "denver-1", row, NOW)
    assert alert is not None and "expired" in alert.lower()


def test_alert_text_is_markdownv2_escaped():
    """Anything dynamic is escaped here, so the router never double-escapes."""
    row = worker_row(state="CHALLENGE_CAPTCHA", account_id="denver.main")
    alert = transition_alert(worker_row(), "CHALLENGE_CAPTCHA", "denver-1", row, NOW)
    assert r"denver\-1" in alert
    assert r"CHALLENGE\_CAPTCHA" in alert
    assert r"denver\.main" in alert
    # Reserved characters that survive unescaped are ones we wrote as markup.
    assert r"\(was" in alert
    assert alert.count("(") == alert.count(r"\(")


# -- status log --------------------------------------------------------------


def at(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def test_a_reported_state_moving_is_a_change():
    assert state_change("HEALTHY", "SESSION_EXPIRED", NOW) == StatusChange(
        at(NOW), STATE_CHANGE, "HEALTHY", "SESSION_EXPIRED"
    )
    assert state_change("SESSION_EXPIRED", "HEALTHY", NOW).became == "HEALTHY"
    # A state from a newer worker is still a change.
    assert state_change("HEALTHY", "SOMETHING_NEW", NOW).became == "SOMETHING_NEW"


def test_restating_or_omitting_a_state_is_not_a_change():
    assert state_change("HEALTHY", "HEALTHY", NOW) is None
    assert state_change("CHECKPOINT", None, NOW) is None


def test_a_first_healthy_report_is_not_a_change_but_a_first_bad_one_is():
    assert state_change(None, "HEALTHY", NOW) is None
    assert state_change(None, "CHECKPOINT", NOW) == StatusChange(
        at(NOW), STATE_CHANGE, None, "CHECKPOINT"
    )


def test_a_steady_worker_logs_nothing():
    assert liveness_changes(LIVE, ago(minutes=3), NOW, beat=True) == ([], LIVE)
    assert liveness_changes(LIVE, ago(minutes=3), NOW) == ([], LIVE)


def test_a_row_with_nothing_logged_takes_a_baseline_silently():
    # The deploy that adds the log must not list every worker.
    assert liveness_changes(None, ago(minutes=3), NOW, beat=True) == ([], LIVE)
    assert liveness_changes(None, ago(hours=3), NOW) == ([], STALE)


def test_a_first_ever_beat_is_logged():
    assert liveness_changes(None, None, NOW, beat=True) == (
        [StatusChange(at(NOW), LIVENESS_CHANGE, None, LIVE)],
        LIVE,
    )
    # No beat, no report: nothing to have crossed.
    assert liveness_changes(None, None, NOW) == ([], None)


def test_the_sweep_logs_a_silent_worker_at_the_moments_it_crossed():
    beat = NOW - timedelta(hours=3)
    assert liveness_changes(LIVE, at(beat), NOW) == (
        [StatusChange(at(beat + STALE_AFTER), LIVENESS_CHANGE, LIVE, STALE)],
        STALE,
    )
    beat = NOW - timedelta(hours=7)
    assert liveness_changes(STALE, at(beat), NOW) == (
        [StatusChange(at(beat + DEAD_AFTER), LIVENESS_CHANGE, STALE, DEAD)],
        DEAD,
    )
    assert liveness_changes(DEAD, at(beat), NOW) == ([], DEAD)


def test_a_beat_fills_in_a_gap_no_sweep_saw():
    beat = NOW - timedelta(hours=7)
    assert liveness_changes(LIVE, at(beat), NOW, beat=True) == (
        [
            StatusChange(at(beat + STALE_AFTER), LIVENESS_CHANGE, LIVE, STALE),
            StatusChange(at(beat + DEAD_AFTER), LIVENESS_CHANGE, STALE, DEAD),
            StatusChange(at(NOW), LIVENESS_CHANGE, DEAD, LIVE),
        ],
        LIVE,
    )


def test_a_return_the_log_did_not_see_is_dated_by_the_stamp_that_made_it():
    # A listing upload stamped the heartbeat a minute ago; the sweep finds
    # the row live while the log still says dead.
    assert liveness_changes(DEAD, ago(minutes=1), NOW) == (
        [StatusChange(ago(minutes=1), LIVENESS_CHANGE, DEAD, LIVE)],
        LIVE,
    )


def test_the_log_sweep_drops_a_retired_workers_baseline():
    rows = [
        worker_row(worker_id="se-1", retired_at=ago(hours=1), logged_liveness=LIVE,
                   last_heartbeat_at=ago(hours=8)),
        worker_row(worker_id="se-2", retired_at=ago(hours=1), logged_liveness=None),
        worker_row(worker_id="ne-1", logged_liveness=LIVE),
        worker_row(worker_id="mw-1", logged_liveness=LIVE, last_heartbeat_at=ago(hours=3)),
    ]
    assert liveness_log_sweep(rows, NOW) == [
        ("se-1", [], None),
        (
            "mw-1",
            [StatusChange(at(NOW - timedelta(hours=3) + STALE_AFTER), LIVENESS_CHANGE, LIVE, STALE)],
            STALE,
        ),
    ]


# -- API -------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "health.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_ADMIN_TOKEN", "admin-token")
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    monkeypatch.delenv("TELEGRAM_OPS_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    # The process singletons live in deps, so it has to pick up the test env
    # (DB path, tokens) before app re-imports them.
    importlib.reload(deps_module)
    importlib.reload(app_module)

    ops = []
    app_module.ops_notifier.send = lambda text: (ops.append(text), True)[1]

    test_client = TestClient(app_module.app)
    test_client.ops = ops
    test_client.db = app_module.db
    yield test_client


AUTH = {"Authorization": "Bearer test-token"}
ADMIN = {"Authorization": "Bearer admin-token"}


def heartbeat(client, **payload):
    body = {"worker_id": "denver-1", "status": "ok", **payload}
    response = client.post("/v1/heartbeat", json=body, headers=AUTH)
    assert response.status_code == 200
    return response.json()


def test_heartbeat_records_health_fields(client):
    heartbeat(
        client,
        state="HEALTHY",
        account_id="denver",
        session_expiry="2026-12-01T00:00:00+00:00",
        error_count=2,
        browser_ok=True,
        proxy_ok=False,
        vnc_url="http://vnc.internal:6080",
    )
    row = client.db.get_worker("denver-1")
    assert row["state"] == "HEALTHY"
    assert row["account_id"] == "denver"
    assert row["error_count"] == 2
    assert row["browser_ok"] == 1 and row["proxy_ok"] == 0
    assert row["vnc_url"] == "http://vnc.internal:6080"
    assert row["last_heartbeat_at"]


def test_a_stuck_worker_alerts_exactly_once(client):
    heartbeat(client, state="HEALTHY")
    assert client.ops == []

    heartbeat(client, state="CHALLENGE_CAPTCHA", vnc_url="http://vnc.internal:6080")
    assert client.db.get_worker("denver-1")["state"] == "CHALLENGE_CAPTCHA"
    assert len(client.ops) == 1
    assert "CHALLENGE" in client.ops[0]

    # The next cycle repeats the same bad state; the channel stays quiet.
    heartbeat(client, state="CHALLENGE_CAPTCHA", vnc_url="http://vnc.internal:6080")
    assert len(client.ops) == 1

    # Clearing it is worth exactly one more message.
    heartbeat(client, state="HEALTHY")
    assert len(client.ops) == 2
    assert "recovered" in client.ops[1]


def test_legacy_heartbeat_path_behaves_the_same(client):
    response = client.post(
        "/api/v1/heartbeat",
        json={"worker_id": "tx-1", "status": "ok", "region": "rs_texas", "state": "DEGRADED"},
        headers=AUTH,
    )
    assert response.status_code == 200
    assert client.db.get_worker("tx-1")["region"] == "rs_texas"
    assert len(client.ops) == 1


def test_a_broken_telegram_does_not_fail_the_heartbeat(client):
    def explode(text):
        raise RuntimeError("telegram is down")

    import rs_coordinator.deps as deps_module

    deps_module.ops_notifier.send = explode
    # The heartbeat is the fleet's only liveness signal; losing it because an
    # alert failed would hide the very outage the alert describes.
    heartbeat(client, state="CHECKPOINT")
    assert client.db.get_worker("denver-1")["state"] == "CHECKPOINT"


def test_admin_worker_view_reports_liveness_and_attention(client):
    heartbeat(client, state="HEALTHY", account_id="denver")
    workers = client.get("/v1/workers", headers=ADMIN).json()["workers"]
    assert len(workers) == 1
    assert workers[0]["worker_id"] == "denver-1"
    assert workers[0]["liveness"] == LIVE
    assert workers[0]["needs_attention"] is False
    assert workers[0]["state"] == "HEALTHY"


def test_admin_worker_view_flags_a_bad_state(client):
    heartbeat(client, state="SESSION_EXPIRED")
    worker = client.get("/v1/workers", headers=ADMIN).json()["workers"][0]
    assert worker["needs_attention"] is True


def test_admin_worker_view_flags_an_expiring_session(client):
    soon = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat(timespec="seconds")
    heartbeat(client, state="HEALTHY", session_expiry=soon)

    worker = client.get("/v1/workers", headers=ADMIN).json()["workers"][0]
    assert worker["needs_attention"] is True
    assert worker["session_days_left"] == pytest.approx(3.0, abs=0.1)
    # And ops heard about it once, on the heartbeat that first reported it.
    assert len(client.ops) == 1
    assert "expiring" in client.ops[0].lower()


def test_a_silent_worker_reads_as_stale_then_dead(client):
    heartbeat(client, state="HEALTHY")

    client.db.update_worker_health(
        "denver-1",
        {"last_heartbeat_at": (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()},
    )
    assert client.get("/v1/workers", headers=ADMIN).json()["workers"][0]["liveness"] == STALE

    client.db.update_worker_health(
        "denver-1",
        {"last_heartbeat_at": (datetime.now(timezone.utc) - timedelta(hours=9)).isoformat()},
    )
    worker = client.get("/v1/workers", headers=ADMIN).json()["workers"][0]
    assert worker["liveness"] == DEAD
    assert worker["needs_attention"] is True


def test_admin_worker_view_carries_relogin_progress(client):
    heartbeat(client, state="SESSION_EXPIRED")
    client.post("/v1/workers/denver-1/relogin", headers=ADMIN)
    queued = client.get("/v1/workers", headers=ADMIN).json()["workers"][0]
    assert queued["relogin_requested_at"]
    assert queued["relogin_last_requested_at"] == queued["relogin_requested_at"]
    assert queued["login_step"] is None

    heartbeat(client, login_step="typing", login_step_at="2099-01-01T00:00:00+00:00")
    worker = client.get("/v1/workers", headers=ADMIN).json()["workers"][0]
    assert worker["relogin_requested_at"] is None  # handed out with that heartbeat
    assert worker["login_step"] == "typing"
    assert worker["login_step_at"] == "2099-01-01T00:00:00+00:00"
    assert worker["relogin_last_requested_at"] == queued["relogin_last_requested_at"]


def test_admin_view_needs_the_admin_token(client):
    assert client.get("/v1/workers").status_code == 401
    assert client.get("/v1/workers", headers=AUTH).status_code == 401


def test_legacy_worker_listing_stays_raw(client):
    """Workers deployed before the control plane parse this shape."""
    heartbeat(client, state="HEALTHY", region="rs_mountain")
    workers = client.get("/api/v1/workers", headers=AUTH).json()["workers"]
    assert workers[0]["region"] == "rs_mountain"
    assert workers[0]["last_heartbeat_at"]
    assert "liveness" not in workers[0]


def status_changes(client, **params):
    response = client.get("/v1/stats/status-changes", params=params, headers=ADMIN)
    assert response.status_code == 200
    return [(r["kind"], r["was"], r["became"]) for r in response.json()["rows"]]


def test_heartbeats_log_status_changes_newest_first(client):
    heartbeat(client, state="HEALTHY")
    heartbeat(client, state="HEALTHY")
    heartbeat(client, state="SESSION_EXPIRED")
    heartbeat(client, state="SESSION_EXPIRED")

    assert status_changes(client) == [
        ("state", "HEALTHY", "SESSION_EXPIRED"),
        ("liveness", None, "live"),
    ]
    assert status_changes(client, limit=1) == [("state", "HEALTHY", "SESSION_EXPIRED")]


def test_a_beat_after_a_long_silence_logs_the_whole_gap(client):
    silent_since = datetime.now(timezone.utc) - timedelta(hours=7)
    client.db.update_worker_health(
        "denver-1",
        {
            "state": "HEALTHY",
            "logged_liveness": LIVE,
            "last_heartbeat_at": silent_since.isoformat(timespec="seconds"),
        },
    )
    heartbeat(client, state="HEALTHY")

    rows = client.get("/v1/stats/status-changes", headers=ADMIN).json()["rows"]
    assert [(r["was"], r["became"]) for r in rows] == [
        ("dead", "live"),
        ("stale", "dead"),
        ("live", "stale"),
    ]
    assert rows[2]["at"] == (silent_since + STALE_AFTER).isoformat(timespec="seconds")
    assert client.db.get_worker("denver-1")["logged_liveness"] == LIVE


def test_status_changes_need_the_admin_token(client):
    assert client.get("/v1/stats/status-changes", headers=AUTH).status_code in (401, 403)


# -- restore directive (RS-308) -----------------------------------------------
# The gentle counterpart to relogin: the cookie-first Assign seeds the slot a
# snapshot and asks the worker to restore it now, not force a password login.


def test_restore_session_queues_a_restore_directive(client):
    heartbeat(client, state="SESSION_EXPIRED")
    assert (
        client.post("/v1/workers/denver-1/restore-session", headers=ADMIN).json()["restore"]
        == "requested"
    )
    # Handed out once, then cleared — like relogin.
    assert "restore" in heartbeat(client)["directives"]
    assert "restore" not in heartbeat(client)["directives"]


def test_restore_is_distinct_from_relogin(client):
    heartbeat(client)
    client.post("/v1/workers/denver-1/relogin", headers=ADMIN)
    client.post("/v1/workers/denver-1/restore-session", headers=ADMIN)
    assert set(heartbeat(client)["directives"]) == {"relogin", "restore"}


def test_restore_session_needs_the_admin_token(client):
    assert client.post(
        "/v1/workers/denver-1/restore-session", headers=AUTH
    ).status_code in (401, 403)
