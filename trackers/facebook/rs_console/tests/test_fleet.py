"""The fleet document: config joined to health, with nothing secret in it.

What must stay true: a proxy leaves as its env-var name and its URL with the
login cut out, never a username or password; the phase-1 monitor's config
row joins its heartbeat row by worker id; a coordinator outage degrades to `health.error` rather than a failed request;
and the dashboard shell itself is public while every data route stays
token-guarded.
"""

import asyncio
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi.testclient import TestClient

import rs_console.app as console
from rs_console import fleet

AUTH = {"Authorization": "Bearer console-token"}

MASTER = """
[ai.openrouter]
model = "openai/gpt-5.6-luna"
api_key = "SECRET-KEY"

[marketplace.facebook]
search_city = ["dc", "miami"]
city_name = ["Washington, DC", "Miami, FL"]
radius = [100, 100]
rating = 4
min_unit_count = 5
search_interval = "45m"
max_search_interval = "75m"
prompt = "judge the listing"

[region.rs_southeast]
full_name = "Southeast"
search_city = ["dc", "miami"]
city_name = ["Washington, DC", "Miami, FL"]
radius = [100, 100]

[region.rs_west]
full_name = "West Coast"
search_city = ["seattle"]
city_name = ["Seattle, WA"]
radius = [100]

[item.server_ram]
search_phrases = ["server ram memory ddr4"]
keywords = ["ram OR memory"]
antikeywords = ["single stick"]
description = "Bulk DDR4"

[item.server_cpu]
enabled = false
search_phrases = ["xeon lot"]
keywords = ["xeon"]
"""

FLEET = """
[worker.se-1]
region = "rs_southeast"
session = "sessions/se-1.json"
proxy_env = "PROXY_SOUTHEAST"
search_interval = "75m"

[worker.wc-1]
region = "rs_west"
session = "sessions/wc-1.json"
proxy_env = "PROXY_WEST"
"""

MONITOR = """
[monitor]
proxy_server = "${PROXY_HOMELAB}"
proxy_password = "hunter2-literal"

[ai.openrouter]
model = "openai/gpt-5.6-luna"
api_key = "SECRET-KEY"

[marketplace.facebook]
search_city = ["dc", "miami"]
city_name = ["Washington, DC", "Miami, FL"]
radius = [100, 100]
search_interval = "45m"
prompt = "judge the listing"
"""

PERSONAL_ACCOUNT = {
    "account_id": "personal",
    "worker_id": "homelab-1",
    "fb_username": "someone@example.com",
    "region": None,
    "vnc_url": None,
    "allow_password_login": False,
    "proxy_configured": True,
    "secrets": {"password": False, "totp_secret": True},
    "created_at": "2026-08-20T00:00:00Z",
    "updated_at": "2026-08-20T00:00:00Z",
}

HOMELAB_SESSION = {
    "worker_id": "homelab-1",
    "account_id": "personal",
    "fb_user_id": "100000000000001",
    "user_agent": "Mozilla/5.0 (Macintosh) Chrome/151.0.0.0 Safari/537.36",
    "session_expiry": "2027-09-06T00:51:29Z",
    "backed_up_at": "2026-09-06T00:51:30+00:00",
}

HOMELAB_ROW = {
    "worker_id": "homelab-1",
    "state": "HEALTHY",
    "status": "ok",
    "region": "dc",
    "liveness": "live",
    "needs_attention": False,
    "last_heartbeat_at": "2026-09-05T21:43:35+00:00",
    "relogin_last_requested_at": "2026-09-05T21:40:00+00:00",
    "login_step": "challenge",
    "login_step_at": "2026-09-05T21:40:31+00:00",
}


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("RS_CONSOLE_TOKEN", "console-token")
    monkeypatch.setenv("RS_COORDINATOR_URL", "http://upstream:8500")
    monkeypatch.setenv("RS_COORDINATOR_ADMIN_TOKEN", "admin-secret")
    monkeypatch.setenv("RS_MONITOR_CONFIG", str(tmp_path / "monitor.toml"))
    monkeypatch.setenv("RS_MASTER_CONFIG", str(tmp_path / "master.toml"))
    monkeypatch.setenv("RS_FLEET_CONFIG", str(tmp_path / "fleet.toml"))
    monkeypatch.setenv("RS_WORKER_ID", "homelab-1")
    monkeypatch.delenv("RS_MONITOR_WORKER_ID", raising=False)

    (tmp_path / "monitor.toml").write_text(MONITOR)
    (tmp_path / "master.toml").write_text(MASTER)
    (tmp_path / "fleet.toml").write_text(FLEET)

    calls = []
    upstream = {
        "response": httpx.Response(200, json={"workers": [HOMELAB_ROW]}),
        "accounts": httpx.Response(200, json={"accounts": [PERSONAL_ACCOUNT]}),
        "sessions": {"homelab-1": httpx.Response(200, json=HOMELAB_SESSION)},
        "cycles": httpx.Response(200, json={"rows": []}),
        "reviews": httpx.Response(200, json={"rows": []}),
        "cities": httpx.Response(200, json={"rows": []}),
        "changes": httpx.Response(200, json={"rows": []}),
        "rank": httpx.Response(404, json={"detail": "Not Found"}),
        "queue": httpx.Response(404, json={"detail": "Not Found"}),
        # The coordinator's fleet configs, by worker id; None answers like a
        # coordinator from before the fleet.
        "configs": None,
        "delay_s": 0.0,
    }
    flight = {"now": 0, "max": 0}

    async def fake_transport(request):
        calls.append(request)
        flight["now"] += 1
        flight["max"] = max(flight["max"], flight["now"])
        try:
            if upstream["delay_s"]:
                await asyncio.sleep(upstream["delay_s"])
            return route(request)
        finally:
            flight["now"] -= 1

    def route(request):
        path = request.url.path
        if upstream["configs"] is not None and path.startswith("/v1/fleet/configs"):
            if path == "/v1/fleet/configs":
                return httpx.Response(200, json={"configs": [{"worker_id": w} for w in upstream["configs"]]})
            wid = path.rsplit("/", 1)[-1]
            return httpx.Response(200, json={"worker_id": wid, "toml": upstream["configs"][wid]})
        if path == "/healthz":
            return httpx.Response(200, json={"status": "ok", "version": "0.5.6"})
        if path == "/v1/city-tiers/rank":
            return upstream["rank"]
        if path == "/v1/queue/status":
            return upstream["queue"]
        if path == "/v1/stats/search-cycles":
            return upstream["cycles"]
        if path == "/v1/stats/reviews/workers":
            return upstream["reviews"]
        if path == "/v1/stats/search-cities":
            return upstream["cities"]
        if path == "/v1/stats/status-changes":
            return upstream["changes"]
        if path == "/v1/accounts":
            return upstream["accounts"]
        if path.startswith("/v1/session/"):
            worker_id = path.split("/")[3]
            return upstream["sessions"].get(worker_id) or httpx.Response(404, json={"detail": "none"})
        return upstream["response"]

    real_client = httpx.AsyncClient

    class FakeClient(real_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(fake_transport)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(console.httpx, "AsyncClient", FakeClient)

    test_client = TestClient(console.app)
    test_client.calls = calls
    test_client.upstream = upstream
    test_client.flight = flight
    yield test_client


def test_fleet_requires_token(client):
    assert client.get("/v1/fleet").status_code == 401


def test_fleet_joins_config_to_health(client):
    res = client.get("/v1/fleet", headers=AUTH)
    assert res.status_code == 200
    doc = res.json()

    paths = [r.url.path for r in client.calls]
    assert paths[:2] == ["/healthz", "/v1/workers"]
    assert doc["versions"] == {"console": console.__version__, "coordinator": "0.5.6"}
    assert "/v1/accounts" in paths
    # One meta lookup per worker the document carries — config and live alike.
    assert sorted(p for p in paths if p.startswith("/v1/session/")) == [
        "/v1/session/homelab-1/meta", "/v1/session/se-1/meta", "/v1/session/wc-1/meta",
    ]
    assert all(r.headers["Authorization"] == "Bearer admin-secret" for r in client.calls)

    assert doc["health"] == {"ok": True, "error": None}
    assert doc["sources"] == {"master": True, "fleet": True, "monitor": True}
    assert doc["ai_model"] == "openai/gpt-5.6-luna"
    assert doc["search"]["rating"] == 4
    assert [i["name"] for i in doc["items"]] == ["server_ram", "server_cpu"]
    assert doc["items"][1]["enabled"] is False

    by_id = {w["worker_id"]: w for w in doc["workers"]}
    assert set(by_id) == {"homelab-1", "se-1", "wc-1"}

    # The phase-1 monitor: its own city list, recognised as a whole region,
    # joined to the heartbeat row the coordinator holds for it.
    monitor = by_id["homelab-1"]
    assert monitor["source"] == "monitor"
    assert monitor["region"] == {"key": "rs_southeast", "name": "Southeast", "scope": "region"}
    assert [c["slug"] for c in monitor["cities"]] == ["dc", "miami"]
    assert monitor["proxy_env"] == "PROXY_HOMELAB"
    assert monitor["health"]["liveness"] == "live"
    # Re-login progress reaches the ERP's Watch page as the coordinator says it.
    assert monitor["health"]["login_step"] == "challenge"
    assert monitor["health"]["login_step_at"] == "2026-09-05T21:40:31+00:00"
    assert monitor["health"]["relogin_last_requested_at"] == "2026-09-05T21:40:00+00:00"
    assert monitor["account"] == {
        "account_id": "personal",
        "fb_username": "someone@example.com",
        "fb_uid": None,
        "region": None,
        "vnc_url": None,
        "allow_password_login": False,
        "proxy_configured": True,
        "secrets": {"password": False, "totp_secret": True},
    }
    assert monitor["session"]["fb_user_id"] == "100000000000001"
    assert monitor["session"]["backed_up_at"] == "2026-09-06T00:51:30+00:00"

    # A sharded worker: region from fleet.toml, cities from master, pacing
    # override noted, no heartbeat yet.
    se = by_id["se-1"]
    assert se["cities"][1]["name"] == "Miami, FL"
    assert se["pacing"] == {"search_interval": "75m", "max_search_interval": "75m", "overridden": True}
    assert se["health"] is None
    assert se["account"] is None and se["session"] is None
    assert by_id["wc-1"]["pacing"]["overridden"] is False


def test_fleet_leaks_no_secret(client):
    text = client.get("/v1/fleet", headers=AUTH).text
    for secret in ("SECRET-KEY", "hunter2-literal", "admin-secret", "judge the listing"):
        assert secret not in text


def test_fleet_survives_coordinator_outage(client):
    client.upstream["response"] = httpx.Response(503, json={"error": "down"})
    doc = client.get("/v1/fleet", headers=AUTH).json()
    assert doc["health"] == {"ok": False, "error": "coordinator returned 503"}
    assert all(w["health"] is None for w in doc["workers"])
    assert all(w["account"] is None and w["session"] is None for w in doc["workers"])
    assert len(doc["workers"]) == 3
    # No point asking for accounts or sessions when the workers call failed.
    assert [r.url.path for r in client.calls] == ["/healthz", "/v1/workers"]


def test_fleet_asks_the_coordinator_concurrently_within_a_bound(client):
    client.upstream["delay_s"] = 0.02
    client.upstream["configs"] = {f"fl-{n}": "# published\n" + MASTER for n in range(24)}
    started = time.monotonic()
    doc = client.get("/v1/fleet", headers=AUTH).json()
    elapsed = time.monotonic() - started

    assert doc["health"] == {"ok": True, "error": None}
    assert len(doc["workers"]) == 27
    metas = [r for r in client.calls if r.url.path.startswith("/v1/session/")]
    assert len(metas) == 27
    # Concurrent, never past the bound, and far from one call after another.
    assert 1 < client.flight["max"] <= console.FLEET_CONCURRENCY
    assert elapsed < len(client.calls) * 0.02 / 2


def test_fleet_is_partial_the_same_way_when_accounts_fail(client, monkeypatch):
    # The accounts call failing stops the document where it always stopped:
    # health rows in, no account, no session, no today.
    real = console.httpx.AsyncClient

    class FailingAccounts(real):
        async def get(self, url, *args, **kwargs):
            if url == "/v1/accounts":
                raise httpx.ConnectError("down")
            return await super().get(url, *args, **kwargs)

    monkeypatch.setattr(console.httpx, "AsyncClient", FailingAccounts)
    doc = client.get("/v1/fleet", headers=AUTH).json()
    assert doc["health"] == {"ok": False, "error": "Coordinator is unreachable"}
    monitor = next(w for w in doc["workers"] if w["worker_id"] == "homelab-1")
    assert monitor["health"]["liveness"] == "live"
    assert all(w["account"] is None and w["session"] is None for w in doc["workers"])
    assert all(w["today"] is None for w in doc["workers"])


def test_fleet_tolerates_an_older_coordinator_without_accounts(client):
    client.upstream["accounts"] = httpx.Response(404, json={"detail": "Not Found"})
    doc = client.get("/v1/fleet", headers=AUTH).json()
    assert doc["health"]["ok"] is True
    monitor = next(w for w in doc["workers"] if w["worker_id"] == "homelab-1")
    assert monitor["account"] is None
    assert monitor["session"]["fb_user_id"] == "100000000000001"


def test_fleet_reports_unconfigured_worker(client):
    client.upstream["response"] = httpx.Response(
        200, json={"workers": [{"worker_id": "ghost-9", "state": "DEAD", "liveness": "dead"}]}
    )
    doc = client.get("/v1/fleet", headers=AUTH).json()
    ghost = next(w for w in doc["workers"] if w["worker_id"] == "ghost-9")
    assert ghost["source"] == "unconfigured"
    assert ghost["health"]["state"] == "DEAD"


def test_fleet_with_only_monitor_mounted(client, monkeypatch, tmp_path):
    monkeypatch.setenv("RS_MASTER_CONFIG", str(tmp_path / "absent.toml"))
    monkeypatch.setenv("RS_FLEET_CONFIG", str(tmp_path / "absent.toml"))
    doc = client.get("/v1/fleet", headers=AUTH).json()
    assert doc["sources"] == {"master": False, "fleet": False, "monitor": True}
    assert [w["worker_id"] for w in doc["workers"]] == ["homelab-1"]
    # With no regions to match against, the monitor's list is just a list.
    assert doc["workers"][0]["region"]["scope"] == "custom"
    assert doc["search"]["search_interval"] == "45m"


def test_dashboard_shell_is_public(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "fleet.js" in res.text
    assert client.get("/static/fleet.js").status_code == 200


# -- pure helpers -------------------------------------------------------------


def test_env_name_accepts_only_placeholders():
    assert fleet.env_name("${PROXY_WEST}") == "PROXY_WEST"
    assert fleet.env_name(["${PROXY_WEST}"]) == "PROXY_WEST"
    assert fleet.env_name("http://user:pass@proxy:8080") is None
    assert fleet.env_name([]) is None
    assert fleet.env_name(None) is None


def test_cities_tolerates_short_arrays():
    block = {"search_city": ["dc", "miami"], "city_name": ["Washington, DC"], "radius": [100]}
    assert fleet.cities(block) == [
        {"slug": "dc", "name": "Washington, DC", "radius_km": 100},
        {"slug": "miami", "name": "miami", "radius_km": None},
    ]


def test_monitor_scope_names_subsets_and_everything():
    region_list = [
        {"key": "a", "name": "A", "cities": [{"slug": "x"}, {"slug": "y"}]},
        {"key": "b", "name": "B", "cities": [{"slug": "z"}]},
    ]
    assert fleet._match_region(["x"], region_list)["scope"] == "subset"
    assert fleet._match_region(["x", "y", "z"], region_list) == {
        "key": None, "name": "All regions", "scope": "all",
    }
    assert fleet._match_region([], region_list)["scope"] == "empty"


# -- today and the daily search budget ----------------------------------------


def test_fleet_carries_each_workers_today_and_plan(client):
    now = datetime.now(timezone.utc)
    started = (now - timedelta(minutes=50)).isoformat(timespec="seconds")
    moved = (now - timedelta(minutes=5)).isoformat(timespec="seconds")
    client.upstream["cycles"] = httpx.Response(200, json={"rows": [
        {"worker_id": "se-1", "at": started, "item": "server_ram"},
    ]})
    # Dated with Eastern's local date, the day se-1 is counted in.
    eastern = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    client.upstream["reviews"] = httpx.Response(200, json={"rows": [
        {"day": eastern, "worker_id": "se-1", "searches": 7, "reviewed": 4, "alerted": 1,
         "updated_at": moved},
    ]})
    client.upstream["cities"] = httpx.Response(200, json={"rows": [
        {"worker_id": "se-1", "city": "atlanta", "last_at": moved},
    ]})
    doc = client.get("/v1/fleet", headers=AUTH).json()
    paths = [r.url.path for r in client.calls]
    assert "/v1/stats/search-cycles" in paths and "/v1/stats/reviews/workers" in paths
    assert "/v1/stats/search-cities" in paths

    by_id = {w["worker_id"]: w for w in doc["workers"]}
    se = by_id["se-1"]
    assert se["timezone"] == "America/New_York"
    assert by_id["wc-1"]["timezone"] == "America/Los_Angeles"
    # One enabled phrase (server_cpu is disabled) in two cities; the fixture's
    # master has no start_at, so there is no daily budget.
    assert se["plan"] == {"phrases": 1, "cities": 2, "runs_per_day": None, "per_day": None}
    assert se["today"]["searches"] == 7
    assert (se["today"]["posts"], se["today"]["alerts"]) == (4, 1)
    assert se["today"]["last_at"] is not None
    assert se["today"]["cities"] == ["atlanta"]
    assert by_id["wc-1"]["today"]["cities"] == []
    # A worker with no searches counted says so with null, not zero.
    assert by_id["wc-1"]["today"]["searches"] is None
    assert by_id["wc-1"]["today"]["posts"] == 0


def test_fleet_today_is_null_against_an_older_coordinator(client):
    client.upstream["cycles"] = httpx.Response(404, json={"detail": "Not Found"})
    client.upstream["reviews"] = httpx.Response(404, json={"detail": "Not Found"})
    client.upstream["cities"] = httpx.Response(404, json={"detail": "Not Found"})
    doc = client.get("/v1/fleet", headers=AUTH).json()
    assert doc["health"]["ok"] is True
    assert all(w["today"] is None for w in doc["workers"])


def test_fleet_carries_the_weeks_status_changes(client):
    change = {"worker_id": "se-1", "at": "2026-09-05T20:00:00+00:00", "kind": "state",
              "was": "HEALTHY", "became": "SESSION_EXPIRED"}
    client.upstream["changes"] = httpx.Response(200, json={"rows": [change]})
    doc = client.get("/v1/fleet", headers=AUTH).json()
    asked = [r for r in client.calls if r.url.path == "/v1/stats/status-changes"]
    assert asked and asked[0].url.params["days"] == "7"
    assert doc["status_changes"] == [change]


def test_fleet_status_changes_are_null_against_an_older_coordinator(client):
    client.upstream["changes"] = httpx.Response(404, json={"detail": "Not Found"})
    doc = client.get("/v1/fleet", headers=AUTH).json()
    assert doc["health"]["ok"] is True
    assert doc["status_changes"] is None


def test_fleet_marks_each_city_with_how_often_it_is_searched(client):
    client.upstream["rank"] = httpx.Response(200, json={
        "settings": {"top_pct": 20, "mid_pct": 20, "per_day": [3, 2, 1], "window_days": 30},
        "workers": {"se-1": [
            {"slug": "dc", "score": 4, "computed": 3, "pin": None, "per_day": 3},
            {"slug": "miami", "score": 0, "computed": 1, "pin": 2, "per_day": 2},
        ]},
    })
    doc = client.get("/v1/fleet", headers=AUTH).json()
    rank_call = next(r for r in client.calls if r.url.path == "/v1/city-tiers/rank")
    assert rank_call.method == "POST"
    asked = __import__("json").loads(rank_call.content)["workers"]
    assert asked["se-1"] == ["dc", "miami"]

    se = next(w for w in doc["workers"] if w["worker_id"] == "se-1")
    assert [(c["slug"], c["per_day"], c["pin"], c["score"]) for c in se["cities"]] == [
        ("dc", 3, None, 4), ("miami", 2, 2, 0),
    ]
    assert doc["city_tiers"]["per_day"] == [3, 2, 1]
    wc = next(w for w in doc["workers"] if w["worker_id"] == "wc-1")
    assert all("per_day" not in c for c in wc["cities"])


QUEUE_STATUS = {
    "at": "2026-10-24T14:00:00+00:00",
    "everyone": False,
    "settings": {"enrolled": ["se-1"], "per_day": 1, "budget_minutes": 360, "window_hours": 8,
                 "lease_minutes": 30, "regions": "any"},
    "items": {"server_ram": {"cities": 2, "queue": 2, "searched": 1, "leased": 1, "due": 0,
                             "later": 0, "held": 0}},
    "cities": [{"slug": "dc", "name": "Washington, DC", "region": "rs_southeast", "home": ["se-1"],
                "held_by": None, "items": {"server_ram": {"state": "searched",
                                                          "at": "2026-10-24T13:10:00+00:00", "by": "se-1"}}}],
    "workers": [{"worker_id": "se-1", "enrolled": True, "capable": True, "version": "0.13.16",
                 "quarantined": False, "minutes_today": 42, "budget_minutes": 360, "handed_today": 2,
                 "handed": ["dc", "miami"], "open": [{"item": "server_ram", "city": "miami",
                                                       "leased_at": "2026-10-24T13:55:00+00:00"}]}],
    "quarantined": [],
    "roster_updated_at": "2026-10-24T13:50:00+00:00",
}


def test_fleet_carries_todays_round_and_each_workers_part(client):
    client.upstream["queue"] = httpx.Response(200, json=QUEUE_STATUS)
    doc = client.get("/v1/fleet", headers=AUTH).json()
    queue = doc["queue"]
    assert queue["settings"] == {"enrolled": ["se-1"], "per_day": 1, "budget_minutes": 360,
                                 "window_hours": 8}
    assert queue["items"]["server_ram"]["searched"] == 1 and queue["cities"][0]["slug"] == "dc"
    assert queue["everyone"] is False and queue["roster_updated_at"] == "2026-10-24T13:50:00+00:00"
    se = next(w for w in doc["workers"] if w["worker_id"] == "se-1")
    assert se["queue"]["minutes_today"] == 42 and se["queue"]["open"][0]["city"] == "miami"
    wc = next(w for w in doc["workers"] if w["worker_id"] == "wc-1")
    assert wc["queue"] is None


def test_fleet_queue_is_null_against_an_older_coordinator(client):
    doc = client.get("/v1/fleet", headers=AUTH).json()
    assert doc["queue"] is None and all(w["queue"] is None for w in doc["workers"])


def test_fleet_leaves_cities_unmarked_against_an_older_coordinator(client):
    doc = client.get("/v1/fleet", headers=AUTH).json()
    assert doc["health"]["ok"] is True
    assert "city_tiers" not in doc
    assert all("per_day" not in c for w in doc["workers"] for c in w["cities"])


def test_apply_tiers_recounts_the_budget_capped_at_the_slots():
    doc = {"workers": [{
        "worker_id": "se-1",
        "cities": [{"slug": "dc"}, {"slug": "miami"}, {"slug": "tampa"}],
        "plan": fleet.search_plan([{"search_phrases": ["a", "b"]}], 3, ["02:00", "10:00"]),
    }]}
    rows = [
        {"slug": "dc", "score": 9, "pin": None, "per_day": 3},
        {"slug": "miami", "score": 1, "pin": None, "per_day": 2},
        {"slug": "tampa", "score": 0, "pin": None, "per_day": 1},
    ]
    fleet.apply_tiers(doc, {"settings": {}, "workers": {"se-1": rows}})
    # Two phrases x (dc twice — two slots is the cap — + miami twice + tampa once).
    assert doc["workers"][0]["plan"]["per_day"] == 2 * (2 + 2 + 1)


def test_search_plan_counts_enabled_phrases_cities_and_runs():
    item_list = [
        {"name": "ram", "enabled": True, "search_phrases": ["a", "b"]},
        {"name": "ssd", "enabled": True, "search_phrases": ["c"]},
        {"name": "cpu", "enabled": False, "search_phrases": ["d", "e"]},
    ]
    assert fleet.search_plan(item_list, 5, ["10:00"]) == {
        "phrases": 3, "cities": 5, "runs_per_day": 1, "per_day": 15,
    }
    assert fleet.search_plan(item_list, 5, ["10:00", "18:00"])["per_day"] == 30
    # An interval loop has no daily budget, and neither does an empty region.
    assert fleet.search_plan(item_list, 5, None)["per_day"] is None
    assert fleet.search_plan(item_list, 0, ["10:00"])["per_day"] is None


def test_worker_today_buckets_by_the_regions_local_day():
    # 13:40 in Denver (MDT, UTC-6).
    now = datetime(2026, 10, 17, 19, 40, tzinfo=timezone.utc)
    cycles = [
        # 23:30 Denver yesterday: not today, though it is the same UTC day.
        {"worker_id": "denver-1", "at": "2026-10-17T05:30:00+00:00", "item": "server_ram"},
        {"worker_id": "denver-1", "at": "2026-10-17T13:25:00+00:00", "item": "server_ram"},
        {"worker_id": "denver-1", "at": "2026-10-17T16:10:00Z", "item": "enterprise_ssd"},
        {"worker_id": "ne-1", "at": "2026-10-17T19:00:00+00:00", "item": "server_ram"},
    ]
    reviews = [
        {"day": "2026-10-17", "worker_id": "denver-1", "searches": 31, "reviewed": 23,
         "alerted": 2, "updated_at": "2026-10-17T19:31:00+00:00"},
        {"day": "2026-10-16", "worker_id": "denver-1", "searches": 36, "reviewed": 50,
         "alerted": 9, "updated_at": "2026-10-16T22:00:00+00:00"},
    ]
    assert fleet.worker_today("denver-1", "America/Denver", cycles, reviews, now) == {
        "day": "2026-10-17",
        "first_at": "2026-10-17T13:25:00Z",
        "last_at": "2026-10-17T19:31:00Z",
        "cycles": 2,
        "searches": 31,
        "posts": 23,
        "alerts": 2,
        "cities": None,
    }

    # Cities searched in Denver's today, not yesterday evening's, nor another worker's.
    cities = [
        {"worker_id": "denver-1", "city": "denver", "last_at": "2026-10-17T15:02:00+00:00"},
        {"worker_id": "denver-1", "city": "boulder", "last_at": "2026-10-17T05:30:00+00:00"},
        {"worker_id": "ne-1", "city": "boston", "last_at": "2026-10-17T19:00:00+00:00"},
    ]
    assert fleet.worker_today("denver-1", "America/Denver", cycles, reviews, now, cities)["cities"] == ["denver"]
    assert fleet.worker_today("denver-1", "America/Denver", cycles, reviews, now, [])["cities"] == []

    # No counters served: the window still draws from cycles, counts unknown.
    today = fleet.worker_today("denver-1", "America/Denver", cycles, None, now)
    assert today["searches"] is None and today["cycles"] == 2
    assert today["posts"] is None
    assert today["last_at"] == "2026-10-17T16:10:00Z"

    # Searches counted yesterday but none yet today: a real zero.
    early = datetime(2026, 10, 17, 7, 0, tzinfo=timezone.utc)  # 01:00 Denver
    assert fleet.worker_today("denver-1", "America/Denver", [], reviews[1:], early)["searches"] == 0


def test_fleet_shows_proxy_url_and_exit_without_any_login(client, monkeypatch, tmp_path):
    (tmp_path / "monitor.toml").write_text(MONITOR.replace(
        'proxy_password = "hunter2-literal"',
        'proxy_username = "${PROXY_HOMELAB_USER}"\nproxy_password = "${PROXY_HOMELAB_PASS}"',
    ))
    monkeypatch.setenv("PROXY_HOMELAB", "http://isp.example.com:10001")
    monkeypatch.setenv("PROXY_HOMELAB_USER", "user-secret")
    monkeypatch.setenv("PROXY_HOMELAB_PASS", "pass-secret")
    monkeypatch.setenv("PROXY_SOUTHEAST", "http://inline:inline-secret@se.example.com:8080")
    monkeypatch.delenv("PROXY_WEST", raising=False)

    asked = []

    async def resolve(keys):
        keys = list(keys)
        asked.extend(keys)
        return {k: {"ip": "203.0.113.1", "city": "Ashburn", "region": "Virginia", "country": "US", "org": "AS1"}
                for k in keys if k[0]}

    monkeypatch.setattr(console.proxy_exit, "resolve", resolve)
    res = client.get("/v1/fleet", headers=AUTH)
    assert res.status_code == 200
    by_id = {w["worker_id"]: w for w in res.json()["workers"]}

    exit_ = {"ip": "203.0.113.1", "city": "Ashburn", "region": "Virginia", "country": "US", "org": "AS1"}
    assert by_id["homelab-1"]["proxy"] == {"url": "http://isp.example.com:10001", **exit_}
    assert by_id["se-1"]["proxy"] == {"url": "http://se.example.com:8080", **exit_}
    # Named in fleet.toml but unset: the VM's own IP, still looked up (not
    # answered by this stub, so it reads pending).
    assert by_id["wc-1"]["proxy"] == {"url": None, "pending": True}
    assert by_id["wc-1"]["proxy_env"] == "PROXY_WEST"

    # The lookup dials with the login; the document never carries it.
    assert ("http://isp.example.com:10001", "user-secret", "pass-secret") in asked
    assert ("http://inline:inline-secret@se.example.com:8080", None, None) in asked
    assert (None, None, None) in asked
    for leak in ("user-secret", "pass-secret", "inline-secret", "proxy_user_env", "proxy_pass_env"):
        assert leak not in res.text


def test_proxies_health_lists_bought_ports_with_no_worker_config(client, monkeypatch):
    # Every legacy launch retired: no config names a proxy or its login, so
    # an idle port takes the login its var's name prefix holds.
    monkeypatch.setenv("PROXY_HOMELAB_NYC2", "http://isp.example.com:10012")
    monkeypatch.setenv("PROXY_HOMELAB_USER", "user-secret")
    monkeypatch.setenv("PROXY_HOMELAB_PASS", "pass-secret")
    monkeypatch.setenv("PROXY_OTHER", "socks5://other.example.com:1080")
    client.upstream["response"] = httpx.Response(200, json={"workers": []})
    asked = []

    async def check(keys):
        keys = list(keys)
        asked.extend(keys)
        return {k: {"ok": True, "latency_ms": 300} for k in keys}

    monkeypatch.setattr(console.proxy_exit, "check", check)
    res = client.get("/v1/proxies/health", headers=AUTH)
    assert res.status_code == 200
    assert [(r["url"], r["workers"]) for r in res.json()["proxies"]] == [
        ("http://isp.example.com:10012", []),
        ("socks5://other.example.com:1080", []),
    ]
    assert sorted(asked, key=str) == [
        ("http://isp.example.com:10012", "user-secret", "pass-secret"),
        ("socks5://other.example.com:1080", None, None),
    ]
    assert "user-secret" not in res.text and "pass-secret" not in res.text


def test_proxies_health_probes_each_port_once_without_any_login(client, monkeypatch, tmp_path):
    assert client.get("/v1/proxies/health").status_code == 401
    (tmp_path / "monitor.toml").write_text(MONITOR.replace(
        'proxy_password = "hunter2-literal"',
        'proxy_username = "${PROXY_HOMELAB_USER}"\nproxy_password = "${PROXY_HOMELAB_PASS}"',
    ))
    monkeypatch.setenv("PROXY_HOMELAB", "http://isp.example.com:10001")
    monkeypatch.setenv("PROXY_HOMELAB_USER", "user-secret")
    monkeypatch.setenv("PROXY_HOMELAB_PASS", "pass-secret")
    # wc-1 dials the same port; se-1 has its own but is retired.
    monkeypatch.setenv("PROXY_WEST", "http://inline:inline-secret@isp.example.com:10001")
    monkeypatch.setenv("PROXY_SOUTHEAST", "http://se.example.com:8080")
    retired = {**HOMELAB_ROW, "worker_id": "se-1", "retired_at": "2026-10-22T15:00:00Z"}
    client.upstream["response"] = httpx.Response(200, json={"workers": [HOMELAB_ROW, retired]})

    asked = []

    async def check(keys):
        keys = list(keys)
        asked.extend(keys)
        return {k: {"ok": True, "latency_ms": 420, "ip": "203.0.113.1", "city": "Ashburn",
                    "region": "Virginia", "country": "US", "org": "AS1"} for k in keys}

    # Ports bought but dialed by no live worker, one of them twice; a login
    # var and a non-proxy value add nothing.
    monkeypatch.setenv("PROXY_HOMELAB_NYC2", "http://isp.example.com:10012")
    monkeypatch.setenv("PROXY_HOMELAB_WC", "http://isp.example.com:10012")
    monkeypatch.setenv("PROXY_NOTES", "ftp://files.example.com:21")

    monkeypatch.setattr(console.proxy_exit, "check", check)
    res = client.get("/v1/proxies/health", headers=AUTH)
    assert res.status_code == 200
    rows = {r["url"]: r for r in res.json()["proxies"]}
    assert list(rows) == ["http://isp.example.com:10001", "http://isp.example.com:10012", "http://se.example.com:8080"]
    row = rows["http://isp.example.com:10001"]
    assert row["workers"] == ["homelab-1", "wc-1"]
    assert row["ok"] is True and row["latency_ms"] == 420 and row["ip"] == "203.0.113.1"
    assert row["checked_at"].endswith("Z")
    assert rows["http://isp.example.com:10012"]["workers"] == []
    assert rows["http://se.example.com:8080"]["workers"] == []
    # One dial per port, with the login (an idle port borrows its host's);
    # the answer never carries it.
    assert sorted(asked) == [
        ("http://isp.example.com:10001", "user-secret", "pass-secret"),
        ("http://isp.example.com:10012", "user-secret", "pass-secret"),
        ("http://se.example.com:8080", None, None),
    ]
    for leak in ("user-secret", "pass-secret", "inline-secret"):
        assert leak not in res.text
