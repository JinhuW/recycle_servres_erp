"""One alert per listing, fleet-wide: the claim a worker takes before sending.

The contract: the first claim on a listing sends and every other worker is
refused; the holder may retry an undelivered claim and anyone may take one its
holder abandoned past the lease; a delivered listing alerts again only below
the price it was alerted at; listings alerted before claims existed are
already claimed after a boot.
"""

import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from rs_coordinator import alert_claims
from rs_coordinator.db import Database
from rs_coordinator.tokens import mint_worker_token

WORKER_SECRET = "worker-token-secret"
T0 = datetime(2026, 10, 19, 15, 38, tzinfo=timezone.utc)


def auth(worker_id: str) -> dict:
    return {"Authorization": f"Bearer {mint_worker_token(worker_id, WORKER_SECRET)}"}


@pytest.fixture()
def db(tmp_path):
    return Database(tmp_path / "claims.db")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", WORKER_SECRET)
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)
    return TestClient(app_module.app)


def claim(db, worker, price="$60", listing="2171928597075513", at=T0):
    return alert_claims.claim(db, "facebook", listing, worker, price, now=at)


def test_the_first_claim_sends_and_a_second_worker_waits(db):
    assert claim(db, "va-2") == {"send": True, "verdict": "new"}
    assert claim(db, "homelab-1", at=T0 + timedelta(seconds=79)) == {
        "send": False,
        "verdict": "pending",
        "worker_id": "va-2",
    }


def test_once_delivered_every_other_worker_gets_a_duplicate(db):
    claim(db, "va-2")
    assert alert_claims.delivered(db, "facebook", "2171928597075513", "va-2", now=T0)

    later = claim(db, "nyc-1", at=T0 + timedelta(hours=28))
    assert later["send"] is False
    assert later["verdict"] == "duplicate"
    assert later["worker_id"] == "va-2"
    assert later["delivered_at"] == T0.isoformat(timespec="seconds")


def test_the_sender_itself_is_refused_once_delivered(db):
    # The same worker finding it again through another search (server_ram,
    # then enterprise_ssd) changes its local hash; that is not news.
    claim(db, "homelab-1")
    alert_claims.delivered(db, "facebook", "2171928597075513", "homelab-1", now=T0)
    assert claim(db, "homelab-1", at=T0 + timedelta(hours=2))["verdict"] == "duplicate"


def test_the_holder_retries_its_own_undelivered_claim(db):
    claim(db, "va-2")
    # Its Telegram send failed; the next sweep asks again.
    assert claim(db, "va-2", at=T0 + timedelta(hours=1))["send"] is True


def test_an_abandoned_claim_passes_on_after_the_lease(db):
    claim(db, "va-2")
    inside = T0 + alert_claims.CLAIM_LEASE - timedelta(seconds=1)
    assert claim(db, "homelab-1", at=inside)["verdict"] == "pending"

    after = T0 + alert_claims.CLAIM_LEASE + timedelta(seconds=1)
    assert claim(db, "homelab-1", at=after) == {"send": True, "verdict": "new"}
    # The original holder's late confirmation no longer closes it.
    assert not alert_claims.delivered(db, "facebook", "2171928597075513", "va-2", now=after)
    assert alert_claims.delivered(db, "facebook", "2171928597075513", "homelab-1", now=after)


def test_a_price_drop_alerts_once_fleet_wide(db):
    claim(db, "mw-1", price="$25")
    alert_claims.delivered(db, "facebook", "2171928597075513", "mw-1", now=T0)

    # Facebook shows a reduced price as "now | was".
    day2 = T0 + timedelta(days=1)
    assert claim(db, "mw-1", price="$20 | $25", at=day2) == {"send": True, "verdict": "discounted"}
    assert claim(db, "sc-1", price="$20 | $25", at=day2)["verdict"] == "pending"
    alert_claims.delivered(db, "facebook", "2171928597075513", "mw-1", now=day2)
    assert claim(db, "sc-1", price="$20 | $25", at=day2)["verdict"] == "duplicate"


def test_the_same_or_a_higher_price_is_not_a_drop(db):
    claim(db, "mw-1", price="$25")
    alert_claims.delivered(db, "facebook", "2171928597075513", "mw-1", now=T0)
    for price in ("$25", "$30", None, "Free"):
        assert claim(db, "sc-1", price=price, at=T0 + timedelta(days=1))["send"] is False


def test_listings_alerted_before_claims_existed_are_already_claimed(tmp_path):
    path = tmp_path / "upgrade.db"
    before = Database(path)
    before.add_alert_message(
        {
            "chat_id": "-100",
            "message_id": 1201,
            "worker_id": "homelab-monitor",
            "listing_id": "960689159823847",
            "sent_at": "2026-10-18T15:37:03+00:00",
        }
    )
    before.close()

    db = Database(path)  # the next boot seeds the claims
    refused = claim(db, "va-2", price="$200", listing="960689159823847")
    assert refused["verdict"] == "duplicate"
    assert refused["delivered_at"] == "2026-10-18T15:37:03+00:00"

    # The seeded row had no price; the first one seen becomes the baseline.
    assert claim(db, "va-2", price="$180", listing="960689159823847")["verdict"] == "discounted"


def test_seeding_twice_changes_nothing(tmp_path):
    path = tmp_path / "reboot.db"
    first = Database(path)
    first.add_alert_message(
        {"chat_id": "-100", "message_id": 7, "worker_id": "w", "listing_id": "L1"}
    )
    claim(first, "va-2", listing="L2")
    first.close()

    db = Database(path)
    Database(path)
    assert db.get_alert_claim("facebook", "L1")["delivered_at"] is not None
    assert db.get_alert_claim("facebook", "L2")["worker_id"] == "va-2"


def test_the_routes_use_the_token_s_worker(client):
    first = client.post(
        "/v1/alerts/claim",
        json={"listing_id": "1136713038794274", "price": "$1"},
        headers=auth("va-2"),
    )
    assert first.status_code == 200
    assert first.json()["send"] is True

    # A body claiming to be va-2 does not make homelab-1 the holder.
    second = client.post(
        "/v1/alerts/claim",
        json={"listing_id": "1136713038794274", "price": "$1", "worker_id": "va-2"},
        headers=auth("homelab-1"),
    )
    assert second.json() == {
        "send": False,
        "verdict": "pending",
        "worker_id": "va-2",
        "delivered_at": None,
    }

    done = client.post(
        "/v1/alerts/claim/delivered",
        json={"listing_id": "1136713038794274"},
        headers=auth("va-2"),
    )
    assert done.json() == {"delivered": True}
    third = client.post(
        "/v1/alerts/claim",
        json={"listing_id": "1136713038794274", "price": "$1"},
        headers=auth("homelab-1"),
    )
    assert third.json()["verdict"] == "duplicate"


def test_the_routes_refuse_a_missing_token(client):
    response = client.post("/v1/alerts/claim", json={"listing_id": "1"})
    assert response.status_code == 401
