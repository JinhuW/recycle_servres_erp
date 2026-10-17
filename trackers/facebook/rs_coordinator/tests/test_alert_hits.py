"""Alert hit tracking: sent-message reports, partner reactions, and the join.

The contract: the monitor's per-message reports are idempotent; reactions are
recorded raw and keyed by (chat, message, user) with removals keeping the row;
the hit-rate view counts an alerted listing once across its message parts and
calls it a hit only while at least one reaction currently stands; reactions on
messages we never recorded an alert for are kept and surfaced as unmatched,
never dropped.
"""

import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from rs_coordinator.db import Database
from rs_coordinator.telegram_consumer import handle_reaction, handle_update

ALERTS_CHAT = "-1004498115958"
WORKER_AUTH = {"Authorization": "Bearer test-token"}
ADMIN_AUTH = {"Authorization": "Bearer admin-token"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", "worker-token-secret")
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    monkeypatch.delenv("TELEGRAM_OPS_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)

    test_client = TestClient(app_module.app)
    test_client.db = deps_module.db
    yield test_client


def report_alert(client, message_id, listing_id="fb-1", part=1, parts=1, **extra):
    payload = {
        "worker_id": "homelab-monitor",
        "chat_id": ALERTS_CHAT,
        "message_id": message_id,
        "part": part,
        "parts": parts,
        "topic_id": 6,
        "priority": "high",
        "listing_id": listing_id,
        "item_name": "server_ram",
        "search_city": "denver",
        "ai_score": 4,
        "unit_count": 64,
        **extra,
    }
    return client.post("/v1/alerts/telegram", json=payload, headers=WORKER_AUTH)


def reaction_update(
    message_id,
    user_id=7001,
    new=("👀",),
    old=(),
    chat_id=ALERTS_CHAT,
    is_bot=False,
    anonymous=False,
):
    reaction = {
        "chat": {"id": int(chat_id)},
        "message_id": message_id,
        "date": 1756000000,
        "old_reaction": [{"type": "emoji", "emoji": e} for e in old],
        "new_reaction": [{"type": "emoji", "emoji": e} for e in new],
    }
    if anonymous:
        reaction["actor_chat"] = {"id": int(chat_id)}
    else:
        reaction["user"] = {"id": user_id, "is_bot": is_bot, "first_name": "Pat"}
    return reaction


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# -- the report endpoint -----------------------------------------------------


def test_alert_reports_are_idempotent(client):
    assert report_alert(client, 101).status_code == 200
    assert report_alert(client, 101).status_code == 200  # retried POST: no-op

    rows = client.get("/v1/stats/alert-hits", headers=ADMIN_AUTH).json()["rows"]
    assert rows == [
        {
            "day": today(),
            "priority": "high",
            "item_name": "server_ram",
            "search_city": "denver",
            "sent": 1,
            "hit": 0,
        }
    ]


def test_worker_token_required_to_report(client):
    res = client.post(
        "/v1/alerts/telegram",
        json={"worker_id": "x", "chat_id": ALERTS_CHAT, "message_id": 1},
    )
    assert res.status_code == 401


def test_admin_token_required_to_read(client):
    assert client.get("/v1/stats/alert-hits").status_code == 401
    assert client.get("/v1/stats/alert-hits", headers=WORKER_AUTH).status_code == 401


# -- reaction handling -------------------------------------------------------


def test_a_reaction_makes_a_hit_and_removal_unmakes_it(client):
    report_alert(client, 101)

    assert handle_reaction(client.db, ALERTS_CHAT, reaction_update(101))
    rows = client.get("/v1/stats/alert-hits", headers=ADMIN_AUTH).json()["rows"]
    assert rows[0]["sent"] == 1 and rows[0]["hit"] == 1

    # The partner removes the emoji: not a hit any more, but the row and the
    # event history survive.
    assert handle_reaction(
        client.db, ALERTS_CHAT, reaction_update(101, new=(), old=("👀",))
    )
    rows = client.get("/v1/stats/alert-hits", headers=ADMIN_AUTH).json()["rows"]
    assert rows[0]["hit"] == 0


def test_bot_anonymous_and_foreign_chat_reactions_are_ignored(client):
    report_alert(client, 101)

    assert not handle_reaction(client.db, ALERTS_CHAT, reaction_update(101, is_bot=True))
    assert not handle_reaction(client.db, ALERTS_CHAT, reaction_update(101, anonymous=True))
    assert not handle_reaction(
        client.db, ALERTS_CHAT, reaction_update(101, chat_id="-1009")
    )
    assert not handle_reaction(client.db, None, reaction_update(101))

    rows = client.get("/v1/stats/alert-hits", headers=ADMIN_AUTH).json()["rows"]
    assert rows[0]["hit"] == 0


def test_orphan_reactions_are_kept_and_counted_as_unmatched(client):
    # No alert_messages row: an alert sent before the ledger existed.
    assert handle_reaction(client.db, ALERTS_CHAT, reaction_update(999))

    body = client.get("/v1/stats/alert-hits", headers=ADMIN_AUTH).json()
    assert body["rows"] == []
    assert body["unmatched_reactions"] == 1


def test_multipart_alert_counts_once_and_any_part_hits(client):
    report_alert(client, 201, listing_id="fb-2", part=1, parts=2)
    report_alert(client, 202, listing_id="fb-2", part=2, parts=2)

    rows = client.get("/v1/stats/alert-hits", headers=ADMIN_AUTH).json()["rows"]
    assert rows[0]["sent"] == 1 and rows[0]["hit"] == 0

    # Reacting on the continuation part still credits the listing.
    handle_reaction(client.db, ALERTS_CHAT, reaction_update(202))
    rows = client.get("/v1/stats/alert-hits", headers=ADMIN_AUTH).json()["rows"]
    assert rows[0]["sent"] == 1 and rows[0]["hit"] == 1


def test_reaction_updates_flow_through_handle_update(client):
    report_alert(client, 101)
    update = {"update_id": 50, "message_reaction": reaction_update(101)}

    assert handle_update(client.db, None, ALERTS_CHAT, update) is None

    rows = client.get("/v1/stats/alert-hits", headers=ADMIN_AUTH).json()["rows"]
    assert rows[0]["hit"] == 1


# -- windowing and buckets ---------------------------------------------------


def test_window_excludes_old_days(tmp_path):
    db = Database(tmp_path / "hits.db")
    old_day = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat(
        timespec="seconds"
    )
    db.add_alert_message(
        {
            "chat_id": ALERTS_CHAT,
            "message_id": 1,
            "listing_id": "old",
            "priority": "low",
            "item_name": "server_ram",
            "search_city": "denver",
            "sent_at": old_day,
        }
    )
    db.add_alert_message(
        {
            "chat_id": ALERTS_CHAT,
            "message_id": 2,
            "listing_id": "new",
            "priority": "low",
            "item_name": "server_ram",
            "search_city": "denver",
        }
    )

    assert len(db.alert_hit_stats(days=14)) == 1
    assert len(db.alert_hit_stats(days=92)) == 2


def test_buckets_split_by_priority_item_and_city(tmp_path):
    db = Database(tmp_path / "hits.db")
    for message_id, priority, city in [
        (1, "high", "denver"),
        (2, "high", "colorado_springs"),
        (3, "medium", "denver"),
    ]:
        db.add_alert_message(
            {
                "chat_id": ALERTS_CHAT,
                "message_id": message_id,
                "listing_id": f"fb-{message_id}",
                "priority": priority,
                "item_name": "server_ram",
                "search_city": city,
            }
        )

    rows = db.alert_hit_stats()
    assert len(rows) == 3
    assert all(row["sent"] == 1 for row in rows)


def test_first_reacted_at_survives_reaction_churn(tmp_path):
    db = Database(tmp_path / "hits.db")
    handle_reaction(db, ALERTS_CHAT, reaction_update(101))

    with db.cursor() as cur:
        cur.execute("SELECT first_reacted_at FROM alert_reactions")
        first = cur.fetchone()["first_reacted_at"]
    assert first is not None

    # Removal keeps the original first_reacted_at; a re-add does not reset it.
    handle_reaction(db, ALERTS_CHAT, reaction_update(101, new=(), old=("👀",)))
    handle_reaction(db, ALERTS_CHAT, reaction_update(101, new=("🔥",)))
    with db.cursor() as cur:
        cur.execute("SELECT first_reacted_at, emoji FROM alert_reactions")
        row = cur.fetchone()
    assert row["first_reacted_at"] == first
    assert row["emoji"] == '["🔥"]'

    with db.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM alert_reaction_events")
        assert cur.fetchone()["n"] == 3
