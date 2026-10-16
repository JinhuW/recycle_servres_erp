"""The fleet document: config joined to health, with nothing secret in it.

What must stay true: proxies leave only as env-var *names*, never values;
the phase-1 monitor's config row joins its heartbeat row by worker id; a
coordinator outage degrades to `health.error` rather than a failed request;
and the dashboard shell itself is public while every data route stays
token-guarded.
"""

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
    }

    async def fake_transport(request):
        calls.append(request)
        path = request.url.path
        if path == "/healthz":
            return httpx.Response(200, json={"status": "ok", "version": "0.5.6"})
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
    assert monitor["account"] == {
        "account_id": "personal",
        "fb_username": "someone@example.com",
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
