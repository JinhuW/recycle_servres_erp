"""Conformance tests for the Postgres backend.

**Anything that needs a live database is skipped unless `RS_TEST_DATABASE_URL`
is set**, so this file stays green on a laptop with no Postgres. To run the
real thing:

    docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55439:5432 postgres:16
    RS_TEST_DATABASE_URL=postgresql://postgres:x@127.0.0.1:55439/postgres \
        pytest rs_coordinator/tests/test_postgres.py -q

The behavioural tests are *parametrized over both backends*: the same
assertions run against `Database(":memory:")` and against
`PostgresDatabase(url)`. That is the whole point — the two must be
indistinguishable to every caller. The SQLite half always runs; the Postgres
half skips without the env var.

Tests that need no database at all (backend selection, URL normalization,
schema translation) always run.
"""

import inspect
import os
import re
import threading
from contextlib import contextmanager

import pytest

from rs_coordinator import db as db_module
from rs_coordinator.db import SCHEMA, Database, open_database, postgres_url, utcnow
from rs_coordinator.pg import (
    ADVISORY_LOCK_KEY,
    PostgresDatabase,
    normalize_url,
    postgres_schema,
)

TEST_URL = os.environ.get("RS_TEST_DATABASE_URL")

requires_postgres = pytest.mark.skipif(
    not TEST_URL, reason="RS_TEST_DATABASE_URL is not set; no live Postgres to test against"
)

# Every table the schema creates, so a case never inherits rows a previous
# run left in a table nobody remembered to list.
TABLES = tuple(re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", SCHEMA))


def _drop_everything() -> None:
    """Wipe the test database so each case starts from nothing."""
    import psycopg

    with psycopg.connect(normalize_url(TEST_URL), autocommit=True) as conn:
        for table in TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")


def _fresh_postgres():
    _drop_everything()
    return PostgresDatabase(TEST_URL)


@pytest.fixture(params=["sqlite", "postgres"])
def backend(request):
    """A `Database` or a `PostgresDatabase`, empty, closed on teardown."""
    if request.param == "sqlite":
        handle = Database(":memory:")
    else:
        if not TEST_URL:
            pytest.skip("RS_TEST_DATABASE_URL is not set")
        handle = _fresh_postgres()
    try:
        yield handle
    finally:
        handle.close()


# -- shared conformance suite ----------------------------------------------
# Every test below runs against both backends and asserts identical results.


def test_alert_claims_decide_the_same_in_both_dialects(backend):
    from datetime import datetime, timedelta, timezone

    from rs_coordinator import alert_claims

    t0 = datetime(2026, 10, 19, 15, 38, tzinfo=timezone.utc)

    def ask(worker, price="$60", at=t0):
        return alert_claims.claim(backend, "facebook", "L1", worker, price, now=at)

    assert ask("va-2")["verdict"] == "new"
    assert ask("homelab-1")["verdict"] == "pending"
    assert ask("va-2")["send"] is True
    assert alert_claims.delivered(backend, "facebook", "L1", "va-2", now=t0)
    assert ask("nyc-1")["verdict"] == "duplicate"
    assert ask("nyc-1", price="$59.99 | $60", at=t0 + timedelta(days=1))["verdict"] == "discounted"
    assert ask("ne-1", at=t0 + timedelta(days=1))["verdict"] == "pending"
    stale = t0 + timedelta(days=1) + alert_claims.CLAIM_LEASE + timedelta(seconds=1)
    assert ask("ne-1", price="$59.99 | $60", at=stale)["verdict"] == "new"
    # Exact, not float4-rounded: a REAL column would read back 59.9900016…
    # and the same price would count as a drop below itself.
    assert backend.get_alert_claim("facebook", "L1")["price_value"] == 59.99



def _listing(key: str, seen: str, score: int) -> dict:
    return {
        "dedupe_key": key,
        "marketplace": "facebook",
        "listing_id": key.split(":")[-1],
        "item_name": "DDR4 ECC RDIMM",
        "title": "32GB DDR4 ECC",
        "price": "$45",
        "location": "Denver, CO",
        "post_url": f"https://example.test/{key}",
        "condition": "used",
        "seller": "someone",
        "description": "pulled from a dell r640",
        "image": None,
        "listing_hash": "abc123",
        "ai_score": score,
        "ai_comment": "worth a look",
        "first_seen_at": seen,
        "last_seen_at": seen,
        "first_worker_id": "denver-1",
        "notified_at": None,
    }


def test_outbound_retry_cap(backend):
    first = backend.enqueue_outbound("t1", "denver-1", "hello", "operator")
    second = backend.enqueue_outbound("t1", "denver-1", "again", "operator")

    assert backend.mark_outbound(first, "failed", "not visible") == "queued"
    assert backend.mark_outbound(first, "failed", "not visible") == "queued"
    assert backend.mark_outbound(first, "failed", "not visible") == "failed"
    row = backend.get_outbound(first)
    assert (row["status"], row["attempts"], row["last_error"]) == ("failed", 3, "not visible")

    assert backend.mark_outbound(second, "failed", "no composer", permanent=True) == "failed"
    assert backend.get_outbound(second)["attempts"] == 1

    third = backend.enqueue_outbound("t1", "denver-1", "sent one", "operator")
    assert backend.mark_outbound(third, "sent") == "sent"
    assert backend.mark_outbound(third, "failed", "late") == "sent"
    assert backend.get_outbound(third)["sent_at"] is not None
    assert [row["id"] for row in backend.pending_outbound()] == []


def test_listing_insert_get_update(backend):
    backend.insert_listing(_listing("facebook:1", "2026-01-01T00:00:00+00:00", 7))

    row = backend.get_listing("facebook:1")
    assert row is not None
    assert row["marketplace"] == "facebook"
    assert row["ai_score"] == 7
    assert row["price"] == "$45"
    # NULL columns come back as a present key holding None, not as a missing key.
    assert "image" in row and row["image"] is None

    assert backend.get_listing("facebook:nope") is None

    backend.update_listing("facebook:1", {"price": "$40", "ai_score": 9})
    updated = backend.get_listing("facebook:1")
    assert updated["price"] == "$40"
    assert updated["ai_score"] == 9
    assert updated["title"] == "32GB DDR4 ECC"  # untouched


def test_query_listings_filters_and_orders(backend):
    backend.insert_listing(_listing("facebook:old", "2026-01-01T00:00:00+00:00", 3))
    backend.insert_listing(_listing("facebook:mid", "2026-02-01T00:00:00+00:00", 8))
    backend.insert_listing(_listing("facebook:new", "2026-03-01T00:00:00+00:00", 5))

    # Newest first.
    keys = [r["dedupe_key"] for r in backend.query_listings()]
    assert keys == ["facebook:new", "facebook:mid", "facebook:old"]

    # `since` is a *string* comparison on an ISO timestamp — the whole reason
    # the Postgres columns stay TEXT.
    since = [r["dedupe_key"] for r in backend.query_listings(since="2026-02-01T00:00:00+00:00")]
    assert since == ["facebook:new", "facebook:mid"]

    assert [r["dedupe_key"] for r in backend.query_listings(min_score=5)] == [
        "facebook:new",
        "facebook:mid",
    ]
    assert len(backend.query_listings(limit=1)) == 1
    assert backend.query_listings(since="2099-01-01T00:00:00+00:00") == []


def test_sighting_counts(backend):
    assert backend.count_sightings("facebook:1") == 0
    backend.record_sighting("facebook:1", "denver-1", "$45", 7)
    backend.record_sighting("facebook:1", "boulder-1", "$45", 7)
    backend.record_sighting("facebook:2", "denver-1", None, None)
    assert backend.count_sightings("facebook:1") == 2
    assert backend.count_sightings("facebook:2") == 1
    assert isinstance(backend.count_sightings("facebook:1"), int)


def test_worker_upsert_coalesces(backend):
    backend.upsert_worker("denver-1", status="running", region="rs_mountain", heartbeat=True)
    first = backend.get_worker("denver-1")
    assert first["region"] == "rs_mountain"
    assert first["last_heartbeat_at"]

    # A later call that mentions neither region nor heartbeat must not blank them.
    backend.upsert_worker("denver-1", status="idle")
    second = backend.get_worker("denver-1")
    assert second["region"] == "rs_mountain"
    assert second["status"] == "idle"
    assert second["last_heartbeat_at"] == first["last_heartbeat_at"]

    assert backend.get_worker("nobody") is None
    backend.upsert_worker("aurora-1")
    assert [w["worker_id"] for w in backend.list_workers()] == ["aurora-1", "denver-1"]


def test_update_worker_health_is_partial(backend):
    backend.update_worker_health(
        "denver-1", {"state": "HEALTHY", "error_count": 0, "browser_ok": 1, "vnc_url": "vnc://x"}
    )
    backend.update_worker_health("denver-1", {"error_count": 3})

    row = backend.get_worker("denver-1")
    assert row["state"] == "HEALTHY"  # untouched by the second call
    assert row["error_count"] == 3
    assert row["vnc_url"] == "vnc://x"
    # Stored as 1/0 ints, not native booleans — callers do `bool(row[...])`
    # but the CLI also prints the raw value.
    assert row["browser_ok"] == 1
    assert not isinstance(row["browser_ok"], bool)

    # Unknown keys are dropped, and an all-unknown update is a silent no-op.
    backend.update_worker_health("denver-1", {"not_a_column": "x"})
    assert backend.get_worker("denver-1")["error_count"] == 3


def test_account_round_trip_with_bytes_blob(backend):
    blob = b"\x00\x01sealed-secret\xff\xfe"
    backend.put_account(
        "denver",
        {
            "worker_id": "denver-1",
            "fb_username": "ops@example.test",
            "region": "rs_mountain",
            "proxy": "http://proxy:8080",
            "vnc_url": "vnc://denver",
            "allow_password_login": 1,
            "secret_blob": blob,
        },
    )

    row = backend.get_account_row("denver")
    assert row["secret_blob"] == blob
    # Must be real `bytes`: vault.decrypt and the == above both depend on it.
    assert isinstance(row["secret_blob"], bytes)
    assert row["allow_password_login"] == 1
    assert row["created_at"] and row["updated_at"]

    assert backend.account_row_for_worker("denver-1")["account_id"] == "denver"
    assert backend.account_row_for_worker("ghost-1") is None
    assert backend.get_account_row("ghost") is None

    # An update keeps created_at and replaces the blob.
    backend.put_account("denver", {"secret_blob": b"rotated", "allow_password_login": 0})
    rotated = backend.get_account_row("denver")
    assert rotated["secret_blob"] == b"rotated"
    assert rotated["created_at"] == row["created_at"]
    assert rotated["allow_password_login"] == 0

    listed = backend.list_accounts()
    assert len(listed) == 1
    assert "secret_blob" not in listed[0]  # never leaves the database
    assert listed[0]["fb_username"] == "ops@example.test"

    assert backend.delete_account("denver") is True
    assert backend.delete_account("denver") is False
    assert backend.list_accounts() == []


def test_challenge_lifecycle(backend):
    cid = backend.insert_challenge({"worker_id": "denver-1", "kind": "captcha"})
    assert isinstance(cid, int)

    opened = backend.get_challenge(cid)
    assert opened["status"] == "open"
    assert opened["worker_id"] == "denver-1"
    assert [c["id"] for c in backend.list_challenges("open")] == [cid]
    assert [c["id"] for c in backend.list_challenges("all")] == [cid]

    backend.update_challenge(cid, {"screenshot_path": "/tmp/shot.png"})
    assert backend.get_challenge(cid)["screenshot_path"] == "/tmp/shot.png"
    backend.update_challenge(cid, {})  # no-op, must not raise

    assert backend.resolve_challenge(cid, "jinhu") is True
    assert backend.get_challenge(cid)["status"] == "resolved"
    assert backend.get_challenge(cid)["resolved_by"] == "jinhu"
    assert backend.list_challenges("open") == []
    # Already resolved — a second resolve is a no-op, not an error.
    assert backend.resolve_challenge(cid, "jinhu") is False
    assert backend.resolve_challenge(999999, "jinhu") is False
    assert backend.get_challenge(999999) is None


def test_challenge_ids_are_generated_and_increase(backend):
    first = backend.insert_challenge({"worker_id": "denver-1", "kind": "captcha"})
    second = backend.insert_challenge({"worker_id": "denver-2", "kind": "2fa"})
    assert second > first


def test_snapshot_round_trip(backend):
    backend.upsert_snapshot("denver-1", {"account_id": "denver", "state_blob": b"sealed"})
    snap = backend.get_snapshot("denver-1")
    assert snap["state_blob"] == b"sealed"
    assert isinstance(snap["state_blob"], bytes)
    assert snap["account_id"] == "denver"
    assert snap["backed_up_at"]

    # One row per worker: a second backup replaces, never accumulates.
    backend.upsert_snapshot("denver-1", {"state_blob": b"rotated", "user_agent": "Mozilla/5.0"})
    replaced = backend.get_snapshot("denver-1")
    assert replaced["state_blob"] == b"rotated"
    assert replaced["user_agent"] == "Mozilla/5.0"
    with backend.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM session_snapshots")
        assert cur.fetchone()["n"] == 1

    assert backend.get_snapshot("nobody") is None


def test_code_audit(backend):
    assert backend.list_code_audit() == []
    backend.insert_code_audit("denver-1", "denver", "totp", "2fa prompt")
    backend.insert_code_audit(None, None, "password", None)

    audit = backend.list_code_audit()
    assert len(audit) == 2
    assert {row["kind"] for row in audit} == {"totp", "password"}
    assert len(backend.list_code_audit(limit=1)) == 1


def test_cursor_commits_on_exit(backend):
    with backend.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM listings")
        assert cur.fetchone()["n"] == 0

    backend.insert_listing(_listing("facebook:1", "2026-01-01T00:00:00+00:00", 1))
    with backend.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM listings")
        assert cur.fetchone()["n"] == 1


def test_review_stats_accumulate_every_counter(backend):
    backend.add_review_stats("denver-1", searches=3, cards=40, reviewed=2)
    backend.add_review_stats("denver-1", searches=1, opened=5, alerted=1)
    backend.add_review_stats("coordinator", sent=1)
    backend.add_review_stats("denver-1")  # nothing to add, no row touched

    (day,) = backend.review_stats_daily(1)
    assert {k: v for k, v in day.items() if k != "day" and v} == {
        "searches": 4, "cards": 40, "opened": 5, "reviewed": 2, "alerted": 1, "sent": 1,
    }
    assert all(isinstance(v, int) for k, v in day.items() if k != "day")


def test_search_cities_keep_one_row_per_worker_and_city(backend):
    backend.touch_search_city("mw-1", "chicago")
    first = backend.search_cities()[0]["last_at"]
    backend.touch_search_city("mw-1", "chicago")
    backend.touch_search_city("mw-1", "peoria")

    rows = backend.search_cities()
    assert [(r["worker_id"], r["city"]) for r in rows] == [("mw-1", "chicago"), ("mw-1", "peoria")]
    assert rows[0]["last_at"] >= first


def test_city_searches_append_in_order(backend):
    backend.log_city_search("mw-1", "chicago", cards=120, opened=9, reviewed=3, alerted=1)
    backend.log_city_search("nj-2b", "nyc")

    rows = backend.city_searches_since("0")
    assert [(r["worker_id"], r["city"], r["cards"], r["alerted"]) for r in rows] == [
        ("mw-1", "chicago", 120, 1),
        ("nj-2b", "nyc", 0, 0),
    ]
    assert backend.city_searches_since("9999") == []
    backend.log_city_search("mw-1", "peoria", cards=3, item="server_ram")
    assert backend.city_searches_since("0")[-1]["item"] == "server_ram"
    assert backend.city_search_log_start() == rows[0]["at"]


def test_city_leases_open_settle_extend(backend):
    t = "2026-10-23T13:00:00+00:00"
    later = "2026-10-23T13:30:00+00:00"
    backend.open_city_lease("nyc-1", "server_ram", "nyc", "home", t, later)
    backend.open_city_lease("nyc-1", "server_ram", "boston", "other", t, later)
    backend.open_city_lease("nyc-1", "enterprise_ssd", "nyc", "home", t, later)
    # Done with nyc for one item: it closes; the item's other live lease is given up.
    given_up = backend.settle_city_leases("nyc-1", "server_ram", "nyc", "2026-10-23T13:10:00+00:00")
    assert given_up == [{"item": "server_ram", "city": "boston", "leased_at": t}]
    rows = {(r["item"], r["city"]): r for r in backend.city_leases_since("0")}
    assert rows[("server_ram", "nyc")]["closed_at"] == "2026-10-23T13:10:00+00:00"
    assert rows[("server_ram", "boston")]["expires_at"] == "2026-10-23T13:10:00+00:00"
    assert rows[("enterprise_ssd", "nyc")]["closed_at"] is None
    moved = backend.extend_city_leases(
        "nyc-1", "2026-10-23T14:00:00+00:00", "2026-10-23T13:20:00+00:00"
    )
    assert [(m["item"], m["city"]) for m in moved] == [("enterprise_ssd", "nyc")]
    rows = {(r["item"], r["city"]): r for r in backend.city_leases_since("0")}
    assert rows[("enterprise_ssd", "nyc")]["expires_at"] == "2026-10-23T14:00:00+00:00"
    assert rows[("server_ram", "boston")]["expires_at"] == "2026-10-23T13:10:00+00:00"


def test_city_events_append_with_their_detail(backend):
    t = "2026-10-23T13:00:00+00:00"
    backend.log_city_event("nyc-1", "server_ram", "nyc", "handed", {"why": "home"}, t)
    backend.log_city_event("ne-1", None, "boston", "searched", {"cards": 3, "phrase": "dell"})
    backend.log_city_event("nyc-1", "server_ram", "nyc", "started")
    rows = backend.city_events_since("0")
    assert [(r["worker_id"], r["event"], r["detail"]) for r in rows] == [
        ("nyc-1", "handed", {"why": "home"}),
        ("ne-1", "searched", {"cards": 3, "phrase": "dell"}),
        ("nyc-1", "started", {}),
    ]
    assert rows[0]["at"] == t and rows[1]["item"] is None
    assert [r["event"] for r in backend.city_events_since("0", "nyc-1")] == ["handed", "started"]
    assert backend.city_events_since("9999") == []


def test_queue_config_is_one_json_row_per_key(backend):
    assert backend.queue_config("settings") is None
    backend.put_queue_config("settings", {"enrolled": ["nyc-1"]}, "rsc")
    backend.put_queue_config("settings", {"enrolled": ["*"], "budget_minutes": 300})
    stored = backend.queue_config("settings")
    assert stored["body"] == {"enrolled": ["*"], "budget_minutes": 300}
    assert stored["updated_by"] is None and stored["updated_at"]


def test_status_changes_append_and_move_the_marker(backend):
    backend.upsert_worker("mw-1", status="ok", heartbeat=True)
    backend.log_status_changes(
        "mw-1",
        [
            ("2026-10-18T10:00:00+00:00", "liveness", "live", "stale"),
            ("2026-10-18T14:00:00+00:00", "liveness", "stale", "dead"),
        ],
        "dead",
    )
    backend.log_status_changes("mw-1", [("2026-10-18T14:00:00+00:00", "state", None, "DEAD")], "dead")
    assert backend.get_worker("mw-1")["logged_liveness"] == "dead"

    rows = backend.status_events_since("2026-10-18T00:00:00+00:00", 10)
    # Newest first; a tie on `at` goes to the later insert.
    assert [(r["kind"], r["was"], r["became"]) for r in rows] == [
        ("state", None, "DEAD"),
        ("liveness", "stale", "dead"),
        ("liveness", "live", "stale"),
    ]
    assert rows[0]["worker_id"] == "mw-1"
    assert len(backend.status_events_since("2026-10-18T12:00:00+00:00", 10)) == 2
    assert len(backend.status_events_since("2026-10-18T00:00:00+00:00", 1)) == 1

    # A baseline alone moves the marker without a row.
    backend.log_status_changes("mw-1", [], None)
    assert backend.get_worker("mw-1")["logged_liveness"] is None
    assert len(backend.status_events_since("2026-10-18T00:00:00+00:00", 10)) == 3


def test_city_tier_config_saves_settings_and_replaces_pins(backend):
    assert backend.city_tier_config() == {
        "settings": {}, "pins": {}, "updated_at": None, "updated_by": None,
    }
    backend.put_city_tier_config({"top_pct": 10}, {"denver": 3, "boise": 1}, "alex")
    backend.put_city_tier_config(None, {"reno": 2}, None)
    config = backend.city_tier_config()
    assert config["settings"] == {"top_pct": 10}
    assert config["pins"] == {"reno": 2}
    assert config["updated_by"] == "alex" and config["updated_at"]


def _profile(key: str, device_id: str) -> dict:
    return {
        "identity_key": key, "device_id": device_id, "fb_uid": key.split(":")[1],
        "user_agent": None, "viewport_w": 1440, "viewport_h": 777, "screen_w": 1440,
        "screen_h": 900, "device_scale_factor": 1.25, "locale": "en-US",
        "timezone_id": "America/Denver", "source": "generated",
    }


def test_device_profiles_are_created_once_and_found_by_key_or_device(backend):
    assert backend.insert_device_profile(_profile("uid:1", "dev-1")) is True
    # A racing second create for the same account loses and writes nothing.
    assert backend.insert_device_profile(_profile("uid:1", "dev-2")) is False

    by_key = backend.get_device_profile("uid:1")
    assert by_key["device_id"] == "dev-1"
    assert by_key["device_scale_factor"] == 1.25
    assert backend.device_profile_by_device("dev-1")["identity_key"] == "uid:1"
    assert backend.get_device_profile("uid:2") is None

    assert backend.claim_device_cookies("uid:1", b"first") is True
    assert backend.claim_device_cookies("uid:1", b"second") is False
    assert backend.get_device_profile("uid:1")["device_cookies_blob"] == b"first"
    backend.update_device_profile("uid:1", {"device_cookies_blob": b"sealed"})
    assert backend.get_device_profile("uid:1")["device_cookies_blob"] == b"sealed"
    listed = backend.list_device_profiles()
    assert [(p["identity_key"], p["has_device_cookies"]) for p in listed] == [("uid:1", 1)]
    assert "device_cookies_blob" not in listed[0]


def test_rekeying_a_device_profile_never_overwrites_another(backend):
    backend.insert_device_profile(_profile("uid:1", "dev-1"))
    backend.insert_device_profile(_profile("uid:2", "dev-2"))

    assert backend.rekey_device_profile("uid:1", "uid:2") is False
    assert backend.rekey_device_profile("uid:1", "uid:3") is True
    assert backend.get_device_profile("uid:3")["device_id"] == "dev-1"
    assert backend.get_device_profile("uid:1") is None


def test_fleet_tables_round_trip(backend):
    backend.upsert_fleet_host("homelab", {})
    backend.upsert_fleet_host("homelab", {"capacity": 9, "authoritative": 1})
    assert backend.get_fleet_host("homelab")["capacity"] == 9
    assert [h["host_id"] for h in backend.list_fleet_hosts()] == ["homelab"]

    backend.put_assignment("va-1", {"host_id": "homelab", "image": "aimm:1", "state": "run"})
    backend.put_assignment("va-1", {"state": "stopped"})  # a partial update
    row = backend.get_assignment("va-1")
    assert (row["host_id"], row["image"], row["state"], row["generation"]) == ("homelab", "aimm:1", "stopped", 1)
    assert [a["worker_id"] for a in backend.list_assignments()] == ["va-1"]

    first = backend.insert_release({"version": "0.1.0", "image": "aimm:1", "state": "done"})
    second = backend.insert_release({"version": "0.2.0", "image": "aimm:2", "state": "rolling"})
    backend.update_release(second, {"current_worker": "va-1"})
    assert [r["id"] for r in backend.list_releases(limit=5)] == [second, first]
    assert backend.get_release(second)["current_worker"] == "va-1"

    backend.put_worker_config("va-1", "a = 1\n", "sha-1", "rsc")
    backend.put_worker_config("va-1", "a = 2\n", "sha-2", None)
    assert backend.get_worker_config("va-1")["toml"] == "a = 2\n"
    assert backend.list_worker_configs() == [
        {"worker_id": "va-1", "sha256": "sha-2", "updated_at": backend.get_worker_config("va-1")["updated_at"], "updated_by": None}
    ]
    assert backend.delete_worker_config("va-1") is True


def test_accounts_carry_a_facebook_uid(backend):
    backend.put_account("va-1", {"worker_id": "va-1", "fb_uid": "1000"})
    assert backend.get_account_row("va-1")["fb_uid"] == "1000"
    assert backend.list_accounts()[0]["fb_uid"] == "1000"


# -- Postgres-specific -----------------------------------------------------


@requires_postgres
def test_migration_adds_funnel_counters_to_old_review_stats():
    import psycopg

    _drop_everything()
    with psycopg.connect(normalize_url(TEST_URL), autocommit=True) as conn:
        conn.execute(
            "CREATE TABLE review_stats ("
            "  day TEXT NOT NULL, worker_id TEXT NOT NULL,"
            "  reviewed INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0,"
            "  updated_at TEXT NOT NULL, PRIMARY KEY (day, worker_id))"
        )
        conn.execute(
            "INSERT INTO review_stats VALUES (%s, 'denver-1', 7, 1, 'x')",
            (utcnow()[:10],),
        )

    handle = PostgresDatabase(TEST_URL)
    try:
        handle.add_review_stats("denver-1", searches=2)
        (day,) = handle.review_stats_daily(1)
        assert (day["reviewed"], day["alerted"], day["searches"], day["sent"]) == (7, 1, 2, 0)
    finally:
        handle.close()


@requires_postgres
def test_migration_adds_health_columns_to_a_preexisting_table():
    """A Postgres database created before the control plane upgrades in place."""
    import psycopg

    _drop_everything()
    with psycopg.connect(normalize_url(TEST_URL), autocommit=True) as conn:
        conn.execute(
            "CREATE TABLE workers ("
            "  worker_id TEXT PRIMARY KEY, region TEXT, status TEXT,"
            "  detail_json TEXT, last_heartbeat_at TEXT, last_listing_at TEXT)"
        )
        conn.execute("INSERT INTO workers (worker_id, region) VALUES ('denver-1', 'rs_mountain')")

    handle = PostgresDatabase(TEST_URL)
    try:
        with handle.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = 'workers'"
            )
            columns = {row["column_name"] for row in cur.fetchall()}
        assert {"state", "account_id", "session_expiry", "error_count", "vnc_url"} <= columns
        # The pre-existing row survives the migration.
        assert handle.get_worker("denver-1")["region"] == "rs_mountain"
    finally:
        handle.close()


@requires_postgres
def test_reopening_is_idempotent():
    _fresh_postgres().close()
    PostgresDatabase(TEST_URL).close()  # second open must not raise
    PostgresDatabase(TEST_URL).close()


@requires_postgres
def test_concurrent_open_does_not_deadlock(monkeypatch):
    """Several pods booting at once must serialize on the advisory lock."""
    _drop_everything()
    monkeypatch.setenv("RS_DATABASE_URL", TEST_URL)

    handles = []
    errors = []

    def boot():
        try:
            handles.append(open_database())
        except Exception as e:  # noqa: BLE001 - re-raised in the assertion below
            errors.append(e)

    threads = [threading.Thread(target=boot) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert not any(t.is_alive() for t in threads), "open_database() deadlocked"
    assert errors == []
    assert len(handles) == 4
    try:
        # All four see the same working schema.
        handles[0].upsert_worker("denver-1", status="running")
        assert handles[-1].get_worker("denver-1")["status"] == "running"
    finally:
        for handle in handles:
            handle.close()


@requires_postgres
def test_advisory_lock_is_released_after_open():
    """A leaked lock would wedge the next deploy, so prove it is given back."""
    import psycopg

    handle = _fresh_postgres()
    try:
        with psycopg.connect(normalize_url(TEST_URL), autocommit=True) as conn:
            cur = conn.execute(
                "SELECT count(*) AS n FROM pg_locks "
                "WHERE locktype = 'advisory' AND objid = %s",
                (ADVISORY_LOCK_KEY,),
            )
            assert cur.fetchone()[0] == 0
    finally:
        handle.close()


# -- backend selection (no database required) ------------------------------


def test_open_database_defaults_to_sqlite(monkeypatch, tmp_path):
    monkeypatch.delenv("RS_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    handle = open_database(tmp_path / "coordinator.db")
    try:
        assert type(handle).__name__ == "Database"
        assert isinstance(handle, Database)
    finally:
        handle.close()


def test_open_database_selects_postgres_when_rs_database_url_is_set(monkeypatch):
    monkeypatch.setenv("RS_DATABASE_URL", "postgresql://u:p@db.example.test:5432/rs")
    monkeypatch.delenv("DATABASE_URL", raising=False)

    seen = {}

    class PostgresDatabase:  # stands in for the real one; no server needed
        def __init__(self, url):
            seen["url"] = url

    monkeypatch.setattr("rs_coordinator.pg.PostgresDatabase", PostgresDatabase)

    handle = open_database("ignored.db")
    assert type(handle).__name__ == "PostgresDatabase"
    assert seen["url"] == "postgresql://u:p@db.example.test:5432/rs"


def test_rs_database_url_wins_over_database_url(monkeypatch):
    monkeypatch.setenv("RS_DATABASE_URL", "postgresql://u@a.example.test/rs")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@b.example.test/other")
    assert postgres_url() == "postgresql://u@a.example.test/rs"


def test_database_url_is_the_fallback(monkeypatch):
    monkeypatch.delenv("RS_DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u@b.example.test/other")
    assert postgres_url() == "postgresql://u@b.example.test/other"


def test_blank_url_means_sqlite(monkeypatch, tmp_path):
    """Railway hands out empty strings for unset variables; treat them as unset."""
    monkeypatch.setenv("RS_DATABASE_URL", "   ")
    monkeypatch.setenv("DATABASE_URL", "")
    assert postgres_url() is None

    handle = open_database(tmp_path / "blank.db")
    try:
        assert isinstance(handle, Database)
    finally:
        handle.close()


def test_sqlite_path_falls_back_to_the_env_var(monkeypatch, tmp_path):
    monkeypatch.delenv("RS_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "from-env.db"))

    handle = open_database()
    try:
        assert handle.path == str(tmp_path / "from-env.db")
    finally:
        handle.close()


def test_db_module_exposes_the_factory():
    assert callable(db_module.open_database)
    assert db_module.DATABASE_URL_VARS == ("RS_DATABASE_URL", "DATABASE_URL")


# -- URL normalization (no database required) ------------------------------


def test_sslmode_require_is_appended_for_remote_hosts():
    out = normalize_url("postgresql://u:p@viaduct.proxy.rlwy.net:12345/railway")
    assert out == "postgresql://u:p@viaduct.proxy.rlwy.net:12345/railway?sslmode=require"


def test_an_explicit_sslmode_is_never_clobbered():
    for mode in ("disable", "verify-full", "prefer"):
        url = f"postgresql://u:p@viaduct.proxy.rlwy.net:12345/railway?sslmode={mode}"
        assert normalize_url(url) == url


def test_other_query_parameters_survive():
    out = normalize_url("postgresql://u@host.example.test/rs?application_name=rsc")
    assert "application_name=rsc" in out
    assert "sslmode=require" in out


def test_local_and_internal_hosts_are_left_in_plaintext():
    """Neither loopback nor Railway's private network offers TLS by default."""
    for url in (
        "postgresql://postgres:x@localhost:55432/postgres",
        "postgresql://postgres:x@127.0.0.1:5432/postgres",
        "postgresql://u:p@postgres.railway.internal:5432/railway",
    ):
        assert normalize_url(url) == url


def test_a_keyword_value_dsn_is_left_alone():
    dsn = "host=db.example.test port=5432 dbname=rs user=u"
    assert normalize_url(dsn) == dsn


def test_the_postgres_scheme_alias_is_handled():
    out = normalize_url("postgres://u:p@db.example.test:5432/rs")
    assert out.startswith("postgres://")
    assert out.endswith("?sslmode=require")


# -- schema translation (no database required) -----------------------------


def test_schema_translation():
    ddl = postgres_schema()

    # SQLite-only spellings are gone...
    assert "BLOB" not in ddl
    assert "AUTOINCREMENT" not in ddl
    # ...replaced by their Postgres equivalents.
    assert "secret_blob          BYTEA" in ddl
    assert "state_blob     BYTEA" in ddl
    assert ddl.count("INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY") == SCHEMA.count(
        "AUTOINCREMENT"
    )

    # Table and column names are untouched — a dedicated database means there
    # is nothing to rename around.
    for table in TABLES:
        assert f"CREATE TABLE IF NOT EXISTS {table}" in ddl

    # Deliberately NOT translated: timestamps stay TEXT and the 1/0 flags stay
    # INTEGER, because the code above compares them as strings and ints.
    assert "first_seen_at   TEXT NOT NULL" in ddl
    assert "allow_password_login INTEGER DEFAULT 0" in ddl
    assert "BOOLEAN" not in ddl
    assert "TIMESTAMP" not in ddl

    # And no migration bookkeeping table.
    assert "schema_migrations" not in ddl


def test_health_columns_are_valid_in_both_dialects():
    from rs_coordinator.db import WORKER_HEALTH_COLUMNS

    for _, decl in WORKER_HEALTH_COLUMNS:
        assert decl.split()[0] in {"TEXT", "INTEGER"}


def test_advisory_lock_key_is_project_specific():
    """778431 belongs to the reddit tracker; ours must not collide with it."""
    assert ADVISORY_LOCK_KEY == 914273


# -- API parity and SQL dialect (no database required) ---------------------


def _public_methods(cls):
    return {name for name, member in inspect.getmembers(cls, callable) if not name.startswith("_")}


def test_the_two_backends_expose_the_same_api():
    """Routers, deps and the CLI are written against one API. Keep it one API."""
    sqlite_api = _public_methods(Database)
    postgres_api = _public_methods(PostgresDatabase)
    assert sqlite_api == postgres_api

    for name in sorted(sqlite_api):
        def shape(cls):
            params = list(inspect.signature(getattr(cls, name)).parameters.values())[1:]
            return [(p.name, p.kind, p.default) for p in params]

        assert shape(Database) == shape(PostgresDatabase), f"{name} signature drifted"


class _RecordingCursor:
    """Stands in for a psycopg cursor so the SQL builders run with no server."""

    def __init__(self, log):
        self._log = log
        self.rowcount = 1

    def execute(self, sql, params=None):
        self._log.append(sql)

    def fetchone(self):
        return {"n": 0, "id": 1}

    def fetchall(self):
        return []

    def close(self):
        pass


class _OfflinePostgres(PostgresDatabase):
    """A PostgresDatabase with the pool removed — records SQL instead."""

    def __init__(self):  # noqa: D107 - deliberately skips the real __init__
        self.log = []

    @contextmanager
    def cursor(self):
        yield _RecordingCursor(self.log)


def test_no_sqlite_placeholders_survive_in_the_postgres_sql():
    """Every `?` and `:name` must have become `%s` / `%(name)s`.

    Exercised by calling each method against a fake cursor, so a missed
    placeholder is caught even without a live server.
    """
    handle = _OfflinePostgres()

    handle.get_listing("k")
    handle.insert_listing({"dedupe_key": "k", "marketplace": "facebook"})
    handle.update_listing("k", {"price": "$1"})
    handle.record_sighting("k", "w", "$1", 3)
    handle.query_listings(since="2026-01-01", min_score=1, limit=5)
    handle.count_sightings("k")
    handle.upsert_worker("w", status="running", region="r", detail={"a": 1}, heartbeat=True)
    handle.list_workers()
    handle.get_worker("w")
    handle.update_worker_health("w", {"state": "HEALTHY", "error_count": 1})
    handle.put_account("a", {"secret_blob": b"x"})
    handle.get_account_row("a")
    handle.account_row_for_worker("w")
    handle.list_accounts()
    handle.delete_account("a")
    handle.insert_challenge({"worker_id": "w", "kind": "captcha"})
    handle.update_challenge(1, {"vnc_url": "vnc://x"})
    handle.get_challenge(1)
    handle.list_challenges("open", limit=5)
    handle.resolve_challenge(1, "jinhu")
    handle.upsert_snapshot("w", {"state_blob": b"x"})
    handle.get_snapshot("w")
    handle.insert_code_audit("w", "a", "totp", "why")
    handle.list_code_audit(limit=5)
    handle.get_device_profile("uid:1")
    handle.device_profile_by_device("dev-1")
    handle.insert_device_profile({"identity_key": "uid:1", "device_id": "dev-1"})
    handle.update_device_profile("uid:1", {"locale": "en-US"})
    handle.rekey_device_profile("uid:1", "uid:2")
    handle.list_device_profiles()
    handle.claim_device_cookies("uid:1", b"x")
    handle.upsert_fleet_host("h", {"capacity": 2})
    handle.get_fleet_host("h")
    handle.list_fleet_hosts()
    handle.put_assignment("w", {"state": "run"})
    handle.get_assignment("w")
    handle.list_assignments()
    handle.insert_release({"version": "1.0.0", "image": "i", "state": "rolling"})
    handle.update_release(1, {"state": "done"})
    handle.get_release(1)
    handle.list_releases(limit=3)
    handle.put_worker_config("w", "a = 1", "sha", None)
    handle.get_worker_config("w")
    handle.list_worker_configs()
    handle.delete_worker_config("w")
    handle.insert_login_attempt({"worker_id": "w", "trigger": "boot"})
    handle.finish_login_attempt(1, "w", "failed", None)
    handle.list_login_attempts("w", 5)
    handle.lock_account("a", "lock page")
    handle.unlock_account("a")
    handle.count_code_audit("a", "password", "2026-01-01")
    for statement in ("insert", "retake", "drop", "baseline", "delivered"):
        handle.write_alert_claim(statement, {})
    handle.get_alert_claim("facebook", "1")

    assert len(handle.log) == 57
    for sql in handle.log:
        assert "?" not in sql, f"SQLite placeholder left in: {sql}"
        assert not re.search(r":\w", sql), f"named SQLite placeholder left in: {sql}"


def test_insert_challenge_uses_returning_instead_of_lastrowid():
    handle = _OfflinePostgres()
    assert handle.insert_challenge({"worker_id": "w", "kind": "captcha"}) == 1
    assert handle.log[0].endswith("RETURNING id")
