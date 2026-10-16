"""Coordinator behaviour: dedupe across workers, config sharding, API contract."""

import importlib
import os
from pathlib import Path

import pytest
import tomli_w
import tomllib
from fastapi.testclient import TestClient

from rs_coordinator.db import Database
from rs_coordinator.dedupe import Verdict, classify, dedupe_key, parse_price
from rs_coordinator.sharding import (
    DEFAULT_CONTROL_PLANE_TOKEN_ENV,
    build_worker_config,
    check_region_coverage,
    check_region_overlap,
    generate_all,
    load_toml,
    write_worker_config,
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
    app_module.notifier.send = lambda text, message_thread_id=None: (
        sent.append(text),
        True,
    )[1]

    # Alerts are queued in the outbox by the request and delivered by the
    # background loop, which TestClient never starts. `drain()` runs one
    # delivery pass synchronously, so tests exercise the whole pipeline.
    from rs_coordinator.background import Background

    pump = Background(deps_module.get_db, app_module.notifier, app_module.ops_notifier)

    test_client = TestClient(app_module.app)
    test_client.sent = sent
    test_client.db = app_module.db
    test_client.drain = lambda: pump.drain_outbox(deps_module.get_db())
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
    assert first == {"accepted": 1, "duplicates": 0, "queued": 1}

    # A second worker whose region overlaps at the border reports the same item.
    payload_two = {"worker_id": "sw-1", "listings": [sample_listing()]}
    second = client.post("/api/v1/listings", json=payload_two, headers=AUTH).json()
    assert second == {"accepted": 0, "duplicates": 1, "queued": 0}

    client.drain()
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

    assert result["queued"] == 1
    client.drain()
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

    # A worker names its build; the row keeps it and healthz names the
    # coordinator's own, so the dashboard can show every build side by side.
    client.post(
        "/api/v1/heartbeat",
        json={"worker_id": "tx-1", "status": "ok", "version": "0.5.6 (d3e9a30)"},
        headers=AUTH,
    )
    workers = client.get("/api/v1/workers", headers=AUTH).json()["workers"]
    assert workers[0]["version"] == "0.5.6 (d3e9a30)"
    from rs_coordinator import __version__
    assert client.get("/healthz").json()["version"] == __version__

    client.post(
        "/api/v1/listings",
        json={"worker_id": "tx-1", "listings": [sample_listing(ai_score=5)]},
        headers=AUTH,
    )
    found = client.get("/api/v1/listings?min_score=5", headers=AUTH).json()["listings"]
    assert len(found) == 1
    assert client.get("/api/v1/listings?min_score=1", headers=AUTH).json()["listings"]


def test_relogin_request_rides_back_on_one_heartbeat(client):
    # An operator presses "Re-login"; the console forwards it to the admin
    # route, which queues the flag. (Queued directly here so the test needs no
    # admin token — the route itself is a one-line wrapper over request_relogin.)
    client.db.request_relogin("relogin-1")

    first = client.post(
        "/api/v1/heartbeat",
        json={"worker_id": "relogin-1", "status": "ok"},
        headers=AUTH,
    ).json()
    assert "relogin" in first["directives"]

    # Fire once: the very next heartbeat no longer carries it, so the worker
    # re-authenticates a single time per button press, not on every poll.
    second = client.post(
        "/api/v1/heartbeat",
        json={"worker_id": "relogin-1", "status": "ok"},
        headers=AUTH,
    ).json()
    assert "relogin" not in second["directives"]


def test_unknown_payload_fields_are_ignored(client):
    listing = sample_listing()
    listing["some_future_aimm_field"] = "whatever"
    result = client.post(
        "/api/v1/listings", json={"worker_id": "w1", "listings": [listing]}, headers=AUTH
    )
    assert result.status_code == 200


def test_the_alert_carries_the_ai_count(client):
    client.post(
        "/api/v1/listings",
        json={"worker_id": "denver-1", "listings": [sample_listing(ai_count="8 sticks")]},
        headers=AUTH,
    )
    client.drain()
    assert "Count: *8 sticks*" in client.sent[-1]

    stored = client.db.get_listing(dedupe_key("facebook", "123456789"))
    assert stored["ai_count"] == "8 sticks"


def test_the_alert_omits_a_missing_count(client):
    # Workers that predate the field send no ai_count; the alert must look
    # exactly as it did before the field existed.
    client.post(
        "/api/v1/listings",
        json={"worker_id": "denver-1", "listings": [sample_listing()]},
        headers=AUTH,
    )
    client.drain()
    assert "Count:" not in client.sent[-1]


def test_migration_adds_ai_count_to_a_preexisting_db(tmp_path):
    import sqlite3

    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE listings ("
        "dedupe_key TEXT PRIMARY KEY, marketplace TEXT NOT NULL, "
        "listing_id TEXT NOT NULL, ai_score INTEGER, ai_comment TEXT, "
        "first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)"
    )
    conn.commit()
    conn.close()

    db = Database(path)
    with db.cursor() as cur:
        columns = {row["name"] for row in cur.execute("PRAGMA table_info(listings)")}
    assert "ai_count" in columns


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


# -- the dedupe race -------------------------------------------------------


def test_only_one_of_two_racing_claims_wins(tmp_path):
    """The invariant the alert stream rests on, at the storage layer."""
    import threading

    db = Database(tmp_path / "race.db")
    start = threading.Barrier(8)
    won = []

    def claim():
        start.wait()
        if db.claim_listing(
            {
                "dedupe_key": "k",
                "marketplace": "facebook",
                "listing_id": "1",
                "first_seen_at": "2026-01-01T00:00:00+00:00",
                "last_seen_at": "2026-01-01T00:00:00+00:00",
            }
        ):
            won.append(True)

    threads = [threading.Thread(target=claim) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(won) == 1


def test_losing_the_race_is_a_duplicate_not_a_second_alert(client, monkeypatch):
    """A worker that read "absent" and then lost the insert must not alert.

    Both workers read before either writes, so both would classify NEW. Only
    the winner may alert; the loser has to notice and demote itself, not raise
    a UNIQUE violation that 500s the rest of its batch.
    """
    import rs_coordinator.deps as deps_module

    client.post(
        "/api/v1/listings",
        json={"worker_id": "denver-1", "listings": [sample_listing()]},
        headers=AUTH,
    )
    client.drain()
    assert len(client.sent) == 1

    # Make the *first* read of this request lie, exactly as a stale read does.
    real_get_listing = deps_module.db.get_listing
    calls = []

    def racing_get_listing(key):
        calls.append(key)
        return None if len(calls) == 1 else real_get_listing(key)

    monkeypatch.setattr(deps_module.db, "get_listing", racing_get_listing)

    response = client.post(
        "/api/v1/listings",
        json={"worker_id": "sw-1", "listings": [sample_listing()]},
        headers=AUTH,
    )
    assert response.status_code == 200
    assert response.json() == {"accepted": 0, "duplicates": 1, "queued": 0}
    client.drain()
    assert len(client.sent) == 1


def test_a_failing_listing_does_not_swallow_the_rest_of_the_batch(client, monkeypatch):
    import rs_coordinator.deps as deps_module

    real_record_sighting = deps_module.db.record_sighting

    def explode_on_the_first(key, worker_id, price, ai_score):
        if ai_score == 1:
            raise RuntimeError("simulated storage failure")
        return real_record_sighting(key, worker_id, price, ai_score)

    monkeypatch.setattr(deps_module.db, "record_sighting", explode_on_the_first)

    response = client.post(
        "/api/v1/listings",
        json={
            "worker_id": "denver-1",
            "listings": [
                sample_listing(id="111", ai_score=1),
                sample_listing(id="222", ai_score=5),
            ],
        },
        headers=AUTH,
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["accepted"], body["failed"]) == (1, 1)
    # The good listing after the bad one still landed and still alerted.
    assert client.db.get_listing(dedupe_key("facebook", "222"))
    client.drain()
    assert len(client.sent) == 1


def test_a_failed_statement_leaves_the_connection_usable(tmp_path):
    """No rollback means an open transaction on the one shared connection."""
    import sqlite3

    db = Database(tmp_path / "rollback.db")
    row = {
        "dedupe_key": "k",
        "marketplace": "facebook",
        "listing_id": "1",
        "first_seen_at": "2026-01-01T00:00:00+00:00",
        "last_seen_at": "2026-01-01T00:00:00+00:00",
    }
    db.insert_listing(row)
    with pytest.raises(sqlite3.IntegrityError):
        db.insert_listing(row)

    # A second connection must not find the database locked by the aborted write.
    other = sqlite3.connect(db.path, timeout=1)
    try:
        other.execute("INSERT INTO sightings (dedupe_key, worker_id, seen_at) VALUES ('k','w','t')")
        other.commit()
    finally:
        other.close()


# -- region coverage -------------------------------------------------------


def test_the_shipped_fleet_searches_every_curated_city():
    """The regions must cover [marketplace.facebook].search_city, all of it.

    That list is the measured one — every slug in it was verified against a
    live session and several were added because a specific listing was missed
    without them. A region set that covers less searches less than the
    single-machine config it replaced, and says nothing about it: a metro with
    no search_city entry is invisible however wide the radius next door.
    """
    master = load_toml(CONFIGS / "master.toml")
    fleet = load_toml(CONFIGS / "fleet.toml")

    assert check_region_coverage(master, fleet) == []


def test_the_louisville_case_is_covered():
    """The listing that established the rule: item 955960664200505, missed for
    four days because columbus (189 mi away) returns zero of its results."""
    master = load_toml(CONFIGS / "master.toml")
    covered = {
        city for region in master["region"].values() for city in region["search_city"]
    }
    assert {"louisville", "columbus"} <= covered


def test_a_gap_is_reported():
    master = {
        "marketplace": {"facebook": {"search_city": ["dc", "louisville"]}},
        "region": {"east": {"search_city": ["dc"]}},
    }
    fleet = {"worker": {"ne-1": {"region": "east"}}}

    gaps = check_region_coverage(master, fleet)
    assert len(gaps) == 1
    assert "louisville" in gaps[0]


def test_every_region_zips_its_city_columns():
    """search_city, city_name and radius are read positionally; a length
    mismatch mislabels cities or is rejected outright by aimm."""
    master = load_toml(CONFIGS / "master.toml")
    for name, region in master["region"].items():
        assert len(region["search_city"]) == len(region["city_name"]) == len(region["radius"]), name


@pytest.mark.skipif(
    not os.environ.get("AIMM_PYTHON"),
    reason="Set AIMM_PYTHON to the interpreter with ai-marketplace-monitor installed",
)
def test_a_worker_console_url_survives_generation(tmp_path):
    """fleet.toml's per-worker vnc_url is the operator's way into a stuck
    browser, and it used to produce a config aimm could not load at all."""
    master = load_toml(CONFIGS / "master.toml")
    config = build_worker_config(
        master,
        "denver-1",
        {"region": "rs_mountain", "vnc_url": "https://vnc.example.com/denver-1"},
    )

    assert config["marketplace"]["facebook"]["vnc_url"] == "https://vnc.example.com/denver-1"

    # aimm lives in its own venv, so the loader is exercised the same way the
    # validator test does it. The generated table is splatted straight into
    # FacebookMarketplaceConfig, so an unknown key is a TypeError at worker
    # start-up, not a warning — `rsc gen-configs` still prints "wrote ..." and
    # exits 0.
    import subprocess

    path = tmp_path / "worker-denver-1.toml"
    write_worker_config(config, path, "denver-1")
    result = subprocess.run(
        [
            os.environ["AIMM_PYTHON"],
            "-c",
            "import sys;from pathlib import Path;"
            "from ai_marketplace_monitor.config import Config;"
            "c=Config([Path(sys.argv[1])]);"
            "print(c.marketplace['facebook'].vnc_url)",
            str(path),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "OPENROUTER_API_KEY": "sk-test",
             "RS_COORDINATOR_URL": "http://127.0.0.1:8599", "RS_COORDINATOR_TOKEN": "tok"},
    )
    assert result.returncode == 0, result.stderr
    assert "https://vnc.example.com/denver-1" in result.stdout


# -- the worker's control-plane wiring -------------------------------------


def test_every_env_var_a_generated_config_reads_is_exported_by_the_compose_file():
    """A worker missing these starts, searches, and is silently half-dead.

    aimm builds its control-plane client only when the URL, the token and a
    worker id are all present, and utils.py degrades an unset `${VAR}` in the
    TOML to None with nothing more than a Python warning. So a variable the
    generated config names but the compose file never exports costs the fleet
    its heartbeat, its automatic 2FA, its escalation and its session backups,
    with every container reporting healthy.
    """
    import re

    compose = (Path(__file__).resolve().parents[2] / "deploy/docker-compose.worker.yml").read_text()
    master = load_toml(CONFIGS / "master.toml")
    fleet = load_toml(CONFIGS / "fleet.toml")

    # Set by compose itself, or by the operator's shell before `compose up`.
    provided_elsewhere = {"WORKER_ID"}

    for worker_id, worker in fleet["worker"].items():
        config = build_worker_config(master, worker_id, worker)
        referenced = set(re.findall(r"\$\{([A-Z0-9_]+)\}", tomli_w.dumps(config)))
        for name in sorted(referenced - provided_elsewhere):
            assert re.search(rf"^\s+{name}:", compose, re.MULTILINE), (
                f"{worker_id}'s config reads ${{{name}}}, which "
                "deploy/docker-compose.worker.yml never puts in the container"
            )


def test_the_control_plane_token_variable_is_reachable_from_compose():
    """Compose cannot build `RS_WORKER_TOKEN_${WORKER_ID}` — it has no string
    functions — so a name derived from the worker id can never be exported."""
    master = load_toml(CONFIGS / "master.toml")
    config = build_worker_config(master, "ne-1", {"region": "rs_northeast"})

    assert (
        config["marketplace"]["facebook"]["control_plane_token"]
        == f"${{{DEFAULT_CONTROL_PLANE_TOKEN_ENV}}}"
    )


def test_healthz_fails_when_the_database_is_unreachable(client, monkeypatch):
    """The Docker healthcheck asks this and nothing else.

    A healthz that never queried reported `ok` with a dead Postgres pool, so a
    coordinator accepting listings and losing them looked like a healthy
    container.
    """
    import rs_coordinator.deps as deps_module

    def dead_cursor():
        raise RuntimeError("connection pool exhausted")

    monkeypatch.setattr(deps_module.db, "cursor", dead_cursor)

    response = client.get("/healthz")
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert "connection pool exhausted" in body["database"]


def test_healthz_reports_the_database_when_it_is_reachable(client):
    body = client.get("/healthz").json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"
