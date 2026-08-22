"""The Messenger bridge: idempotent inbox sync, Telegram routing, auto-reply.

The properties under test mirror the listings channel's: re-reporting is free
(fingerprints, like dedupe keys), every alert rides the durable outbox, and
the auto-reply policy errs toward silence — off by default, one reply per
thread ever, humans always win.
"""

import importlib
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from rs_coordinator.autoreply import AutoReplyPolicy, policy_from_env
from rs_coordinator.dedupe import message_fingerprint

AUTH = {"Authorization": "Bearer test-token"}
ADMIN = {"Authorization": "Bearer admin-token"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "messages.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_ADMIN_TOKEN", "admin-token")
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    monkeypatch.delenv("RS_AUTOREPLY_ENABLED", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)

    test_client = TestClient(app_module.app)
    test_client.db = app_module.db
    yield test_client


def snapshot(thread_id="t1", messages=None, **overrides):
    thread = {
        "thread_id": thread_id,
        "counterpart": "Jamie Seller",
        "listing_title": "WTB: used server RAM",
        "last_message_at": "2026-08-21T12:00:00+00:00",
        "messages": messages
        if messages is not None
        else [
            {
                "direction": "in",
                "sender": "Jamie Seller",
                "text": "I have 32 sticks of DDR4 ECC, interested?",
                "sent_at": "2026-08-21T12:00:00+00:00",
            }
        ],
    }
    thread.update(overrides)
    return thread


def sync(client, *threads, worker_id="denver-1"):
    return client.post(
        "/v1/messages/sync",
        json={"worker_id": worker_id, "threads": list(threads)},
        headers=AUTH,
    )


def outbox_rows(client, kind=None):
    with client.db.cursor() as cur:
        cur.execute("SELECT * FROM outbox ORDER BY id")
        rows = [dict(row) for row in cur.fetchall()]
    return [r for r in rows if kind is None or r["kind"] == kind]


# -- sync --------------------------------------------------------------------


def test_sync_requires_a_token(client):
    response = client.post("/v1/messages/sync", json={"worker_id": "w", "threads": []})
    assert response.status_code == 401


def test_sync_stores_the_thread_and_routes_the_message_to_telegram(client):
    body = sync(client, snapshot()).json()
    assert body == {"threads": 1, "new_messages": 1, "queued_replies": 0}

    thread = client.db.get_thread("t1")
    assert thread["counterpart"] == "Jamie Seller"
    assert thread["worker_id"] == "denver-1"
    assert client.db.count_messages("t1") == 1

    (alert,) = outbox_rows(client, kind="message_in")
    assert "Jamie Seller" in alert["text"]
    assert "DDR4 ECC" in alert["text"]


def test_resyncing_the_same_thread_is_free(client):
    """Workers re-report whole threads every poll; only new messages count."""
    sync(client, snapshot())
    body = sync(client, snapshot()).json()
    assert body["new_messages"] == 0
    assert client.db.count_messages("t1") == 1
    assert len(outbox_rows(client, kind="message_in")) == 1


def test_outgoing_messages_are_recorded_but_never_alerted(client):
    messages = [
        {"direction": "in", "sender": "Jamie", "text": "hi", "sent_at": None},
        {"direction": "out", "sender": None, "text": "hello back", "sent_at": None},
    ]
    sync(client, snapshot(messages=messages))
    assert client.db.count_messages("t1") == 2
    assert len(outbox_rows(client, kind="message_in")) == 1


def test_a_fuller_snapshot_never_blanks_thread_fields(client):
    sync(client, snapshot())
    sync(client, snapshot(counterpart=None, listing_title=None))
    thread = client.db.get_thread("t1")
    assert thread["counterpart"] == "Jamie Seller"
    assert thread["listing_title"] == "WTB: used server RAM"


# -- auto-reply --------------------------------------------------------------


def test_autoreply_is_off_by_default(client):
    sync(client, snapshot())
    assert client.db.pending_outbound() == []


def test_autoreply_queues_once_and_tells_the_operator(client, monkeypatch):
    monkeypatch.setenv("RS_AUTOREPLY_ENABLED", "1")
    monkeypatch.setenv("RS_AUTOREPLY_HOURS", "0-0")  # always within hours

    body = sync(client, snapshot()).json()
    assert body["queued_replies"] == 1

    (reply,) = client.db.pending_outbound(worker_id="denver-1")
    assert reply["origin"] == "autoreply"
    assert "buying used server hardware" in reply["text"]
    assert client.db.get_thread("t1")["autoreplied_at"] is not None
    # The operator hears about it in the same channel as the message itself.
    assert len(outbox_rows(client, kind="message_autoreply")) == 1

    # A second inbound message must not earn a second automated reply.
    more = snapshot(
        messages=[{"direction": "in", "sender": "Jamie", "text": "hello?", "sent_at": None}]
    )
    assert sync(client, more).json()["queued_replies"] == 0
    assert len(client.db.pending_outbound(worker_id="denver-1")) == 1


def test_autoreply_stays_out_of_handled_conversations(client, monkeypatch):
    monkeypatch.setenv("RS_AUTOREPLY_ENABLED", "1")
    monkeypatch.setenv("RS_AUTOREPLY_HOURS", "0-0")

    # An outgoing message in the snapshot means a human (or a previous reply)
    # already answered in the Facebook UI.
    messages = [
        {"direction": "in", "sender": "Jamie", "text": "hi", "sent_at": None},
        {"direction": "out", "sender": None, "text": "typed by hand", "sent_at": None},
    ]
    assert sync(client, snapshot(messages=messages)).json()["queued_replies"] == 0

    # And a claimed thread is off limits even with no outgoing message stored.
    sync(client, snapshot(thread_id="t2"))
    client.db.set_thread_fields("t2", {"human_claimed": 1, "autoreplied_at": None})
    fresh = snapshot(
        thread_id="t2",
        messages=[{"direction": "in", "sender": "J", "text": "still there?", "sent_at": None}],
    )
    assert sync(client, fresh).json()["queued_replies"] == 0


# -- policy units ------------------------------------------------------------


def test_policy_daily_cap_and_hours():
    policy = AutoReplyPolicy(enabled=True, max_per_day=2, hours=(0, 0))
    thread = {"human_claimed": 0, "autoreplied_at": None}
    messages = [{"direction": "in", "text": "hi"}]
    assert policy.decide(thread, messages, sent_today=1) is not None
    assert policy.decide(thread, messages, sent_today=2) is None

    night = AutoReplyPolicy(enabled=True, hours=(14, 4))
    inside = datetime(2026, 8, 21, 15, 0, tzinfo=timezone.utc)
    wrapped = datetime(2026, 8, 21, 3, 0, tzinfo=timezone.utc)
    outside = datetime(2026, 8, 21, 9, 0, tzinfo=timezone.utc)
    assert night.decide(thread, messages, 0, now=inside) is not None
    assert night.decide(thread, messages, 0, now=wrapped) is not None
    assert night.decide(thread, messages, 0, now=outside) is None


def test_policy_from_env_defaults_off_and_survives_garbage():
    assert policy_from_env({}).enabled is False
    policy = policy_from_env(
        {
            "RS_AUTOREPLY_ENABLED": "true",
            "RS_AUTOREPLY_HOURS": "not-hours",
            "RS_AUTOREPLY_MAX_PER_DAY": "many",
        }
    )
    assert policy.enabled is True
    assert policy.hours == (14, 4)
    assert policy.max_per_day == 20


def test_message_fingerprint_distinguishes_what_matters():
    base = ("t1", "in", "Jamie", "hi", None)
    assert message_fingerprint(*base) == message_fingerprint(*base)
    assert message_fingerprint("t2", "in", "Jamie", "hi", None) != message_fingerprint(*base)
    assert message_fingerprint("t1", "out", "Jamie", "hi", None) != message_fingerprint(*base)
    assert message_fingerprint("t1", "in", "Jamie", "hi there", None) != message_fingerprint(*base)


# -- outbound lifecycle ------------------------------------------------------


def test_outbound_fetch_and_ack(client, monkeypatch):
    monkeypatch.setenv("RS_AUTOREPLY_ENABLED", "1")
    monkeypatch.setenv("RS_AUTOREPLY_HOURS", "0-0")
    sync(client, snapshot())

    fetched = client.get("/v1/messages/outbound", headers=AUTH).json()["outbound"]
    assert len(fetched) == 1
    assert fetched[0]["thread_id"] == "t1"

    ack = client.post(
        f"/v1/messages/outbound/{fetched[0]['id']}/ack",
        json={"status": "sent", "error": None},
        headers=AUTH,
    )
    assert ack.status_code == 200
    assert client.db.pending_outbound() == []
    assert client.db.get_outbound(fetched[0]["id"])["sent_at"] is not None


def test_acking_a_failure_keeps_the_error(client):
    sync(client, snapshot())
    outbound_id = client.db.enqueue_outbound("t1", "denver-1", "hello", "operator")
    client.post(
        f"/v1/messages/outbound/{outbound_id}/ack",
        json={"status": "failed", "error": "composer not found"},
        headers=AUTH,
    )
    row = client.db.get_outbound(outbound_id)
    assert row["status"] == "failed"
    assert row["last_error"] == "composer not found"
    assert row["sent_at"] is None


def test_ack_rejects_unknown_ids_and_statuses(client):
    assert (
        client.post(
            "/v1/messages/outbound/999/ack", json={"status": "sent"}, headers=AUTH
        ).status_code
        == 404
    )
    sync(client, snapshot())
    outbound_id = client.db.enqueue_outbound("t1", None, "x", "operator")
    assert (
        client.post(
            f"/v1/messages/outbound/{outbound_id}/ack",
            json={"status": "maybe"},
            headers=AUTH,
        ).status_code
        == 422
    )


# -- operator console --------------------------------------------------------


def test_operator_reply_queues_and_claims(client):
    sync(client, snapshot())
    response = client.post(
        "/v1/threads/t1/reply", json={"text": "Can do $200 for the lot."}, headers=ADMIN
    )
    assert response.status_code == 200

    (row,) = client.db.pending_outbound(worker_id="denver-1")
    assert row["origin"] == "operator"
    assert client.db.get_thread("t1")["human_claimed"] == 1


def test_console_routes_are_admin_only(client):
    sync(client, snapshot())
    assert client.get("/v1/threads", headers=AUTH).status_code == 401
    assert client.post("/v1/threads/t1/claim", headers=AUTH).status_code == 401
    assert client.get("/v1/threads", headers=ADMIN).status_code == 200
    assert client.post("/v1/threads/t1/claim", headers=ADMIN).status_code == 200
