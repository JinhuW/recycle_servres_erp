"""Funnel stats: per-page worker deltas become fleet-wide daily totals.

The contract: reports accumulate (never overwrite), zero-deltas leave no row,
the admin view sums across workers per UTC day, the window parameter actually
cuts old days off, and the coordinator counts its own two stages.
"""

import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

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


def report(client, reviewed, alerted, worker_id="denver-1"):
    return client.post(
        "/v1/stats/reviews",
        json={"worker_id": worker_id, "reviewed": reviewed, "alerted": alerted},
        headers=WORKER_AUTH,
    )


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


COUNTERS = (
    "searches", "cards", "title_pass", "opened", "keyword_pass", "fresh",
    "reviewed", "alerted", "coordinated", "sent",
)


def row(day, **counts):
    return {"day": day, **{c: counts.get(c, 0) for c in COUNTERS}}


def test_reports_accumulate_into_one_daily_row(client):
    assert report(client, 12, 1).status_code == 200
    assert report(client, 5, 0).status_code == 200

    res = client.get("/v1/stats/reviews", headers=ADMIN_AUTH)
    assert res.status_code == 200
    days = res.json()["days"]
    assert days == [row(today(), reviewed=17, alerted=1)]


def test_days_sum_across_workers(client):
    report(client, 10, 2, worker_id="denver-1")
    report(client, 7, 1, worker_id="columbus-1")

    days = client.get("/v1/stats/reviews", headers=ADMIN_AUTH).json()["days"]
    assert days == [row(today(), reviewed=17, alerted=3)]


def test_zero_delta_report_leaves_no_row(client):
    assert report(client, 0, 0).status_code == 200
    days = client.get("/v1/stats/reviews", headers=ADMIN_AUTH).json()["days"]
    assert days == []


def test_window_excludes_old_days(client):
    old_day = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")
    client.db.add_review_stats("denver-1", reviewed=99, alerted=9, day=old_day)
    report(client, 3, 0)

    days = client.get("/v1/stats/reviews?days=14", headers=ADMIN_AUTH).json()["days"]
    assert days == [row(today(), reviewed=3, alerted=0)]

    wide = client.get("/v1/stats/reviews?days=92", headers=ADMIN_AUTH).json()["days"]
    assert wide == [
        row(old_day, reviewed=99, alerted=9),
        row(today(), reviewed=3, alerted=0),
    ]


def test_worker_token_required_to_report(client):
    res = client.post("/v1/stats/reviews", json={"worker_id": "x", "reviewed": 1})
    assert res.status_code == 401


def test_admin_token_required_to_read(client):
    assert client.get("/v1/stats/reviews").status_code == 401
    assert client.get("/v1/stats/reviews", headers=WORKER_AUTH).status_code == 401


def test_negative_counts_rejected(client):
    res = client.post(
        "/v1/stats/reviews",
        json={"worker_id": "denver-1", "reviewed": -1, "alerted": 0},
        headers=WORKER_AUTH,
    )
    assert res.status_code == 422


def test_funnel_counters_accumulate(client):
    stages = {
        "searches": 6, "cards": 120, "title_pass": 30, "opened": 12,
        "keyword_pass": 8, "fresh": 5, "reviewed": 4, "alerted": 1,
    }
    for _ in range(2):
        res = client.post(
            "/v1/stats/reviews",
            json={"worker_id": "denver-1", **stages},
            headers=WORKER_AUTH,
        )
        assert res.status_code == 200

    days = client.get("/v1/stats/reviews", headers=ADMIN_AUTH).json()["days"]
    assert days == [row(today(), **{k: 2 * v for k, v in stages.items()})]


def test_unknown_counter_is_refused_by_the_database(client):
    with pytest.raises(ValueError):
        client.db.add_review_stats("denver-1", bogus=1)


def test_ingest_counts_listings_new_to_the_fleet(client):
    listing = {
        "id": "123", "marketplace": "facebook", "name": "server_ram",
        "title": "64GB DDR4 ECC x 20", "price": "$400",
        "post_url": "https://www.facebook.com/marketplace/item/123/",
    }
    body = {"worker_id": "denver-1", "listings": [listing]}
    for _ in range(2):
        assert client.post("/api/v1/listings", json=body, headers=WORKER_AUTH).status_code == 200

    days = client.get("/v1/stats/reviews", headers=ADMIN_AUTH).json()["days"]
    assert days == [row(today(), coordinated=1)]


def test_direct_alert_report_counts_once_per_alert(client):
    for part in (1, 2, 1):
        res = client.post(
            "/v1/alerts/telegram",
            json={"worker_id": "homelab-1", "chat_id": "-100", "message_id": 7 + part,
                  "part": part},
            headers=WORKER_AUTH,
        )
        assert res.status_code == 200

    # message 8 (part 1) counted once despite the retry; part 2 not at all.
    days = client.get("/v1/stats/reviews", headers=ADMIN_AUTH).json()["days"]
    assert days == [row(today(), coordinated=1, sent=1)]
