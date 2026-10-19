"""Workers the fleet runs: their configs live in the coordinator, not here.

A worker under rs-fleetd has no mounted file; its agent fetches its config
from the coordinator. What must stay true: a settings save and a cities edit
reach those configs exactly as they reach a mounted one, a mounted worker can
be handed to the fleet on the config it runs, and Watch reaches a fleet worker
only once a trusted host actually runs it.
"""

import tomllib

import httpx
import pytest
from fastapi.testclient import TestClient

import rs_console.app as console
from rs_console import settings

from test_settings import AUTH, MASTER


@pytest.fixture()
def env(monkeypatch, tmp_path, fake_fleet):
    (tmp_path / "master.toml").write_text(MASTER)
    mounted = tmp_path / "homelab.toml"
    mounted.write_text("# generated\n" + MASTER)
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("RS_CONSOLE_TOKEN", "console-token")
    monkeypatch.setenv("RS_COORDINATOR_URL", "http://upstream:8500")
    monkeypatch.setenv("RS_COORDINATOR_ADMIN_TOKEN", "admin-secret")
    monkeypatch.setenv("RS_MASTER_CONFIG", str(tmp_path / "master.toml"))
    monkeypatch.setenv("RS_MONITOR_CONFIG", str(mounted))
    monkeypatch.setenv("RS_WORKER_CONFIGS", f"homelab-1={mounted}")
    monkeypatch.setenv("RS_SETTINGS_STATE", str(state / "settings.json"))
    monkeypatch.setenv("RS_FLEET_CONFIG", str(tmp_path / "absent-fleet.toml"))
    monkeypatch.setenv("RS_VNC_TARGETS", "homelab-1=rs-monitor:5900,va-1=rs-monitor-va1:5900")

    fake_fleet.enabled = True
    fake_fleet.configs["nyc-2"] = "# published\n" + MASTER

    async def upstream(request):
        path = request.url.path
        if path == "/v1/fleet/configs":
            return httpx.Response(200, json={"configs": [{"worker_id": w} for w in fake_fleet.configs]})
        if path.startswith("/v1/fleet/configs/"):
            wid = path.rsplit("/", 1)[-1]
            return httpx.Response(200, json={"worker_id": wid, "toml": fake_fleet.configs[wid]})
        return httpx.Response(200, json={"workers": [], "accounts": []})

    real_client = httpx.AsyncClient

    class FakeClient(real_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(upstream)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(console.httpx, "AsyncClient", FakeClient)
    return {"client": TestClient(console.app), "mounted": mounted, "fleet": fake_fleet}


def test_a_settings_save_reaches_fleet_configs_too(env):
    res = env["client"].put("/v1/config/settings", json={"search": {"rating": 3}}, headers=AUTH)
    assert res.status_code == 200, res.text
    assert res.json()["changed"] == ["homelab.toml", "fleet:nyc-2"]
    published = env["fleet"].configs["nyc-2"]
    assert published.startswith("# published\n")  # rendered, not replaced
    assert tomllib.loads(published)["marketplace"]["facebook"]["rating"] == 3


def test_a_fleet_workers_cities_go_into_its_fleet_config_only(env):
    body = {"cities": [{"slug": "nyc", "name": "New York", "radius": 40}]}
    res = env["client"].put("/v1/workers/nyc-2/cities", json=body, headers=AUTH)
    assert res.status_code == 200, res.text
    assert res.json()["changed"] == ["fleet:nyc-2"]
    fb = tomllib.loads(env["fleet"].configs["nyc-2"])["marketplace"]["facebook"]
    assert fb["search_city"] == ["nyc"] and fb["city_name"] == ["New York"]
    assert "nyc" not in env["mounted"].read_text()


def test_a_worker_with_no_config_anywhere_is_a_404(env):
    body = {"cities": [{"slug": "nyc", "name": "New York", "radius": 40}]}
    assert env["client"].put("/v1/workers/ghost/cities", json=body, headers=AUTH).status_code == 404


def test_an_unreachable_coordinator_writes_nothing(env, monkeypatch):
    def down(*args, **kwargs):
        raise settings.FleetError("coordinator unreachable")

    monkeypatch.setattr(settings.FleetConfigs, "_call", down)
    before = env["mounted"].read_text()
    res = env["client"].put("/v1/config/settings", json={"search": {"rating": 2}}, headers=AUTH)
    assert res.status_code == 500
    assert env["mounted"].read_text() == before  # rendered first, nothing written


def test_the_fleet_document_shows_a_fleet_workers_config(env):
    doc = env["client"].get("/v1/fleet", headers=AUTH).json()
    assert "nyc-2" in {w["worker_id"] for w in doc["workers"]}
    assert doc["settings"]["editable"] is True


def test_publish_hands_a_mounted_worker_to_the_fleet_on_its_own_config(env):
    fleet = settings.FleetConfigs.from_env()
    assert settings.publish({"search": {"rating": 2}}, fleet, ["homelab-1"]) == ["homelab-1"]
    published = env["fleet"].configs["homelab-1"]
    assert published.startswith("# generated\n")
    assert tomllib.loads(published)["marketplace"]["facebook"]["rating"] == 2


def test_watch_reaches_fleet_workers_only_on_trusted_hosts(env):
    env["fleet"].state = {
        "hosts": [
            {"host_id": "homelab", "authoritative": 1, "vnc_host": None},
            {"host_id": "lan-box", "authoritative": 1, "vnc_host": "10.10.10.80"},
            {"host_id": "new-vm", "authoritative": 0, "vnc_host": None},
        ],
        "assignments": [
            {"worker_id": "va-1", "host_id": "homelab", "state": "run"},
            {"worker_id": "nyc-2", "host_id": "lan-box", "state": "run", "vnc_port": 5902},
            {"worker_id": "west-2", "host_id": "new-vm", "state": "run"},
            {"worker_id": "sc-1", "host_id": "homelab", "state": "stopped"},
        ],
    }
    targets = console._vnc_targets()
    assert targets["va-1"] == ("rs-worker-va-1", 5900)  # the fleet's container wins
    assert targets["nyc-2"] == ("10.10.10.80", 5902)
    assert targets["homelab-1"] == ("rs-monitor", 5900)  # still compose-run
    assert "west-2" not in targets and "sc-1" not in targets


def test_publish_without_names_only_refreshes_what_the_fleet_holds(env):
    fleet = settings.FleetConfigs.from_env()
    assert settings.publish({}, fleet) == []  # homelab-1 is not the fleet's yet
    settings.publish({}, fleet, ["homelab-1"])
    env["mounted"].write_text(env["mounted"].read_text().replace("rating = 4", "rating = 5"))
    assert settings.publish({}, fleet) == ["homelab-1"]
    assert tomllib.loads(env["fleet"].configs["homelab-1"])["marketplace"]["facebook"]["rating"] == 5
