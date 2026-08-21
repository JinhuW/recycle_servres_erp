"""Coordinator behaviour: dedupe across workers, config sharding, API contract."""

import importlib
import os
from pathlib import Path

import pytest
import tomllib
from fastapi.testclient import TestClient

from rs_coordinator.db import Database
from rs_coordinator.dedupe import Verdict, classify, dedupe_key, parse_price
from rs_coordinator.sharding import (
    build_worker_config,
    check_region_overlap,
    generate_all,
    load_toml,
)

CONFIGS = Path(__file__).resolve().parents[2] / "configs"


def sample_listing(**overrides):
    listing = {
        "marketplace": "facebook",
        "id": "123456789",
        "name": "rack_servers",
        "title": "Dell PowerEdge R740 lot of 4",
        "price": "$1200",
        "location": "Denver, CO",
        "post_url": "https://www.facebook.com/marketplace/item/123456789/",
        "condition": "Used - Good",
        "seller": "Some Seller",
        "description": "Four servers, decommissioned from a datacenter.",
        "image": "https://example.com/img.jpg",
        "listing_hash": "hash-v1",
        "ai_score": 5,
        "ai_comment": "Great deal: bulk lot well below market.",
        "status": "NOT_NOTIFIED",
    }
    listing.update(overrides)
    return listing


# -- dedupe ----------------------------------------------------------------


def test_dedupe_key_is_stable_and_distinct():
    assert dedupe_key("facebook", "1") == dedupe_key("facebook", "1")
    assert dedupe_key("facebook", "1") != dedupe_key("facebook", "2")


@pytest.mark.parametrize(
    "raw,expected",
    [("$1,200", 1200.0), ("1200 USD", 1200.0), ("Free", None), (None, None), ("", None)],
)
def test_parse_price(raw, expected):
    assert parse_price(raw) == expected


def test_classify_new_changed_discounted_duplicate():
    incoming = sample_listing()
    assert classify(incoming, None) is Verdict.NEW

    existing = {"price": "$1200", "listing_hash": "hash-v1"}
    assert classify(incoming, existing) is Verdict.DUPLICATE

    changed = sample_listing(listing_hash="hash-v2")
    assert classify(changed, existing) is Verdict.CHANGED

    cheaper = sample_listing(price="$900")
    assert classify(cheaper, existing) is Verdict.DISCOUNTED


def test_duplicate_is_the_only_silent_verdict():
    assert not Verdict.DUPLICATE.should_notify
    assert all(v.should_notify for v in Verdict if v is not Verdict.DUPLICATE)


# -- database --------------------------------------------------------------


def test_worker_upsert_preserves_unspecified_fields():
    db = Database(":memory:")
    db.upsert_worker("w1", status="ok", region="rs_texas", heartbeat=True)
    db.upsert_worker("w1", status="degraded", heartbeat=True)
    worker = db.list_workers()[0]
    # A heartbeat without a region must not wipe the region.
    assert worker["region"] == "rs_texas"
    assert worker["status"] == "degraded"


# -- API -------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    # The process singletons live in deps now, so it has to pick up the test
    # env (DB path, tokens) before app re-imports them.
    importlib.reload(deps_module)
    importlib.reload(app_module)

    sent = []
    app_module.notifier.send = lambda text: (sent.append(text), True)[1]

    test_client = TestClient(app_module.app)
    test_client.sent = sent
    test_client.db = app_module.db
    yield test_client


AUTH = {"Authorization": "Bearer test-token"}


def test_healthz_needs_no_auth(client):
    assert client.get("/healthz").json()["status"] == "ok"


def test_listings_endpoint_requires_valid_token(client):
    payload = {"worker_id": "w1", "listings": [sample_listing()]}
    assert client.post("/api/v1/listings", json=payload).status_code == 401
    assert (
        client.post(
            "/api/v1/listings", json=payload, headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )


def test_same_listing_from_two_workers_alerts_once(client):
    payload = {"worker_id": "denver-1", "listings": [sample_listing()]}
    first = client.post("/api/v1/listings", json=payload, headers=AUTH).json()
    assert first == {"accepted": 1, "duplicates": 0, "notified": 1}

    # A second worker whose region overlaps at the border reports the same item.
    payload_two = {"worker_id": "sw-1", "listings": [sample_listing()]}
    second = client.post("/api/v1/listings", json=payload_two, headers=AUTH).json()
    assert second == {"accepted": 0, "duplicates": 1, "notified": 0}

    assert len(client.sent) == 1
    key = dedupe_key("facebook", "123456789")
    assert client.db.count_sightings(key) == 2


def test_price_drop_triggers_a_second_alert(client):
    client.post(
        "/api/v1/listings",
        json={"worker_id": "denver-1", "listings": [sample_listing()]},
        headers=AUTH,
    )
    result = client.post(
        "/api/v1/listings",
        json={"worker_id": "denver-1", "listings": [sample_listing(price="$800")]},
        headers=AUTH,
    ).json()

    assert result["notified"] == 1
    assert "Price drop" in client.sent[-1]

    stored = client.db.get_listing(dedupe_key("facebook", "123456789"))
    assert stored["price"] == "$800"


def test_reporting_listings_marks_the_worker_alive(client):
    client.post(
        "/api/v1/listings",
        json={"worker_id": "denver-1", "listings": [sample_listing()]},
        headers=AUTH,
    )
    workers = client.get("/api/v1/workers", headers=AUTH).json()["workers"]
    assert workers[0]["worker_id"] == "denver-1"
    assert workers[0]["last_heartbeat_at"]


def test_heartbeat_and_listing_query(client):
    client.post(
        "/api/v1/heartbeat",
        json={"worker_id": "tx-1", "status": "ok", "region": "rs_texas"},
        headers=AUTH,
    )
    workers = client.get("/api/v1/workers", headers=AUTH).json()["workers"]
    assert workers[0]["region"] == "rs_texas"

    client.post(
        "/api/v1/listings",
        json={"worker_id": "tx-1", "listings": [sample_listing(ai_score=5)]},
        headers=AUTH,
    )
    found = client.get("/api/v1/listings?min_score=5", headers=AUTH).json()["listings"]
    assert len(found) == 1
    assert client.get("/api/v1/listings?min_score=1", headers=AUTH).json()["listings"]


def test_unknown_payload_fields_are_ignored(client):
    listing = sample_listing()
    listing["some_future_aimm_field"] = "whatever"
    result = client.post(
        "/api/v1/listings", json={"worker_id": "w1", "listings": [listing]}, headers=AUTH
    )
    assert result.status_code == 200


# -- sharding --------------------------------------------------------------


def test_worker_config_is_pinned_to_its_region():
    master = load_toml(CONFIGS / "master.toml")
    worker = {
        "region": "rs_south_central",
        "session": "sessions/sc-1.json",
        "proxy_env": "PROXY_SOUTH_CENTRAL",
    }
    config = build_worker_config(master, "sc-1", worker)

    facebook = config["marketplace"]["facebook"]
    assert facebook["search_region"] == "rs_south_central"
    # The Phase 1 single-city defaults must not linger and contradict the
    # region. radius/currency/city_name are zip-aligned with search_city and
    # aimm rejects them outright when it is absent.
    for city_bound_key in ("search_city", "radius", "currency", "city_name"):
        assert city_bound_key not in facebook

    # Auth is session-based: no credentials may reach a generated config.
    for credential_key in ("username", "password", "totp_secret"):
        assert credential_key not in facebook

    assert list(config["region"]) == ["rs_south_central"]
    assert config["monitor"]["proxy_server"] == ["${PROXY_SOUTH_CENTRAL}"]
    assert config["monitor"]["storage_state_path"] == "/data/fb_state.json"

    assert config["notification"]["coordinator"]["worker_id"] == "sc-1"
    # Alerts must go through the coordinator, never direct from a worker.
    for user in config["user"].values():
        assert user["notify_with"] == ["coordinator"]
        assert "telegram_token" not in user


def test_worker_pacing_override_is_applied():
    """A worker may search slower than master.toml — wc-1 carries five cities."""
    master = load_toml(CONFIGS / "master.toml")
    config = build_worker_config(
        master,
        "wc-1",
        {
            "region": "rs_west",
            "search_interval": "55m",
            "max_search_interval": "90m",
        },
    )
    facebook = config["marketplace"]["facebook"]
    assert facebook["search_interval"] == "55m"
    assert facebook["max_search_interval"] == "90m"


def test_worker_without_pacing_override_keeps_master_pacing():
    master = load_toml(CONFIGS / "master.toml")
    config = build_worker_config(master, "ne-1", {"region": "rs_northeast"})
    facebook = config["marketplace"]["facebook"]
    assert facebook["search_interval"] == master["marketplace"]["facebook"]["search_interval"]


def test_unknown_region_is_rejected():
    master = load_toml(CONFIGS / "master.toml")
    with pytest.raises(ValueError, match="not defined"):
        build_worker_config(master, "bad-1", {"region": "rs_atlantis"})


def test_generated_configs_are_valid_toml(tmp_path):
    written = generate_all(CONFIGS / "master.toml", CONFIGS / "fleet.toml", tmp_path)
    assert written
    for path in written:
        with open(path, "rb") as handle:
            config = tomllib.load(handle)
        assert config["marketplace"]["facebook"]["search_region"] in config["region"]


@pytest.mark.skipif(
    not os.environ.get("AIMM_PYTHON"),
    reason="Set AIMM_PYTHON to the interpreter with ai-marketplace-monitor installed",
)
def test_generated_configs_pass_the_real_aimm_validator(tmp_path):
    """Generated shards must satisfy aimm's own config validation.

    Its rules are cross-field (currency requires search_city, and so on), so
    valid TOML is not enough — only the real validator proves a worker will
    start.
    """
    import subprocess

    written = generate_all(CONFIGS / "master.toml", CONFIGS / "fleet.toml", tmp_path)
    env = {
        **os.environ,
        "OPENROUTER_API_KEY": "sk-test",
        "RS_COORDINATOR_URL": "http://127.0.0.1:8599",
        "RS_COORDINATOR_TOKEN": "tok",
        **{
            f"PROXY_{region}": "http://proxy.example.com:8080"
            for region in ("NORTHEAST", "SOUTHEAST", "MIDWEST", "SOUTH_CENTRAL", "WEST")
        },
    }
    # No Facebook credentials in the environment: a generated config must load
    # and validate without them.
    for stale in ("FACEBOOK_USERNAME", "FACEBOOK_PASSWORD", "FACEBOOK_TOTP_SECRET"):
        env.pop(stale, None)

    for path in written:
        result = subprocess.run(
            [
                os.environ["AIMM_PYTHON"],
                "-c",
                "import sys;from pathlib import Path;"
                "from ai_marketplace_monitor.config import Config;"
                "c=Config([Path(sys.argv[1])]);"
                "print(c.marketplace['facebook'].search_city)",
                str(path),
            ],
            capture_output=True,
            text=True,
            env=env,
        )
        assert result.returncode == 0, f"{path.name} rejected by aimm:\n{result.stderr}"
        # aimm prints the cities it expanded search_region into; they must be
        # this worker's region, not master.toml's Phase 1 default.
        with open(path, "rb") as handle:
            shard = tomllib.load(handle)
        region = shard["marketplace"]["facebook"]["search_region"]
        for city in shard["region"][region]["search_city"]:
            assert city in result.stdout, f"{path.name} did not search {city}"


def test_shipped_fleet_has_no_region_overlap():
    master = load_toml(CONFIGS / "master.toml")
    fleet = load_toml(CONFIGS / "fleet.toml")
    assert check_region_overlap(master, fleet) == []


def test_overlap_is_reported():
    master = {"region": {"a": {"search_city": ["denver"]}, "b": {"search_city": ["denver"]}}}
    fleet = {"worker": {"w1": {"region": "a"}, "w2": {"region": "b"}}}
    warnings = check_region_overlap(master, fleet)
    assert len(warnings) == 1
    assert "denver" in warnings[0]
