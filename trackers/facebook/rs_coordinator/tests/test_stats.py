"""Review stats: per-cycle worker deltas become fleet-wide daily totals.

The contract: reports accumulate (never overwrite), zero-deltas leave no row,
the admin view sums across workers per UTC day, and the window parameter
actually cuts old days off.
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


def test_reports_accumulate_into_one_daily_row(client):
    assert report(client, 12, 1).status_code == 200
    assert report(client, 5, 0).status_code == 200

    res = client.get("/v1/stats/reviews", headers=ADMIN_AUTH)
    assert res.status_code == 200
    days = res.json()["days"]
    assert days == [{"day": today(), "reviewed": 17, "alerted": 1}]


def test_days_sum_across_workers(client):
    report(client, 10, 2, worker_id="denver-1")
    report(client, 7, 1, worker_id="columbus-1")

    days = client.get("/v1/stats/reviews", headers=ADMIN_AUTH).json()["days"]
    assert days == [{"day": today(), "reviewed": 17, "alerted": 3}]


def test_zero_delta_report_leaves_no_row(client):
    assert report(client, 0, 0).status_code == 200
    days = client.get("/v1/stats/reviews", headers=ADMIN_AUTH).json()["days"]
    assert days == []


def test_window_excludes_old_days(client):
    old_day = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")
    client.db.add_review_stats("denver-1", reviewed=99, alerted=9, day=old_day)
    report(client, 3, 0)

    days = client.get("/v1/stats/reviews?days=14", headers=ADMIN_AUTH).json()["days"]
    assert days == [{"day": today(), "reviewed": 3, "alerted": 0}]

    wide = client.get("/v1/stats/reviews?days=92", headers=ADMIN_AUTH).json()["days"]
    assert wide == [
        {"day": old_day, "reviewed": 99, "alerted": 9},
        {"day": today(), "reviewed": 3, "alerted": 0},
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
