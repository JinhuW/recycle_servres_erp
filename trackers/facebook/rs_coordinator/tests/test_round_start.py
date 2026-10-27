"""Starting the city round by hand, instead of at the workers' start times.

The contract: a start opens every enrolled worker's window for a window's
length and makes due any city not searched in the last `start_fresh_hours`;
it wakes, through a one-shot `sweep` directive, only the enrolled workers that
are up and on a monitor that acts on one, and names the others that will
start at their usual time; outside a started round nothing changes.
"""

import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from rs_coordinator import city_queue
from rs_coordinator.city_queue import DAY, State
from rs_coordinator.tokens import mint_worker_token

ADMIN = {"Authorization": "Bearer admin-token"}
LEGACY = {"Authorization": "Bearer test-token"}
SECRET = "worker-token-secret"
T0 = datetime(2026, 10, 24, tzinfo=timezone.utc).timestamp()
HOUR = 3600.0
DEFAULTS = city_queue.validate_settings({}, {})

CATALOG = [
    {"slug": "boston", "name": "Boston, MA", "region": "ne", "radius": 100},
    {"slug": "nyc", "name": "New York, NY", "region": "ne", "radius": 100},
    {"slug": "miami", "name": "Miami, FL", "region": "se", "radius": 100},
]


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat(timespec="seconds")


# -- the rules while a started round runs ---------------------------------------------


def test_a_start_lasts_one_window_and_says_so():
    start = {"at": iso(T0 + 2 * HOUR), "by": "Alex Chen"}
    assert "started" not in city_queue.with_start(DEFAULTS, start, T0 + HOUR)
    running = city_queue.with_start(DEFAULTS, start, T0 + 3 * HOUR)
    assert running["started"] == {
        "at": iso(T0 + 2 * HOUR),
        "by": "Alex Chen",
        "until": iso(T0 + 10 * HOUR),
        "fresh_hours": 2,
    }
    assert "started" not in city_queue.with_start(DEFAULTS, start, T0 + 10 * HOUR)
    assert "started" not in city_queue.with_start(DEFAULTS, None, T0)


def test_a_started_round_hands_out_what_was_not_searched_lately():
    roster = city_queue.validate_roster(
        {"catalog": CATALOG, "workers": {"nyc-1": {"home": ["nyc"], "start_at": ["13:00"]}}}
    )
    fleet = city_queue.build_fleet(roster, {}, DEFAULTS)
    state = State()
    now = T0 + 6 * HOUR
    state.record("ne-1", "nyc", now - 3 * HOUR, 5)
    state.record("ne-1", "boston", now - HOUR, 5)
    state.record("ne-1", "miami", now - 5 * HOUR, 5)
    # The daily rule: nothing searched in the last 20 h is due.
    assert city_queue.pick("nyc-1", now, fleet, state, DEFAULTS) == (None, "nothing_due")
    started = city_queue.with_start(DEFAULTS, {"at": iso(now - 60)}, now)
    assert city_queue.pick("nyc-1", now, fleet, state, started) == ("nyc", "home")
    state.record("nyc-1", "nyc", now, 5)
    # Boston, searched an hour ago, waits; Miami does not.
    assert city_queue.pick("nyc-1", now, fleet, state, started)[0] == "miami"


def test_a_started_round_opens_the_window():
    assert not city_queue.in_window(["13:00"], T0 + 3 * HOUR, 8)
    live = city_queue.Live(
        roster=city_queue.validate_roster(
            {"catalog": CATALOG, "workers": {"nyc-1": {"home": ["nyc"], "start_at": ["13:00"]}}}
        ),
        worker_rows=[],
        searches=[],
        seeded=[],
        leases=[],
        log_since=None,
        scores={},
        pins={},
    )
    settings = {**DEFAULTS, "enrolled": ["nyc-1"]}
    shut = city_queue.next_city("nyc-1", "server_ram", ["nyc"], ["13:00"], T0 + 3 * HOUR, settings, live)
    assert shut["reason"] == "outside_window"
    started = city_queue.with_start(settings, {"at": iso(T0 + 2 * HOUR)}, T0 + 3 * HOUR)
    answer = city_queue.next_city(
        "nyc-1", "server_ram", ["nyc"], ["13:00"], T0 + 3 * HOUR, started, live
    )
    assert answer["city"]["slug"] == "nyc"


def test_the_start_fresh_hours_are_a_setting():
    assert city_queue.validate_settings({"start_fresh_hours": 6}, {})["start_fresh_hours"] == 6
    for bad in (0, 25, "2", True):
        with pytest.raises(city_queue.QueueError):
            city_queue.validate_settings({"start_fresh_hours": bad}, {})


# -- the routes -------------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", SECRET)
    for name in ("TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_OPS_CHAT_ID"):
        monkeypatch.delenv(name, raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)
    test_client = TestClient(app_module.app)
    test_client.deps = deps_module
    yield test_client


def auth(wid):
    return {"Authorization": f"Bearer {mint_worker_token(wid, SECRET)}"}


def beat(client, wid, version, state="HEALTHY"):
    body = {"worker_id": wid, "state": state, "version": version}
    assert client.post("/v1/heartbeat", json=body, headers=LEGACY).status_code == 200


def directives(client, wid):
    res = client.post(f"/v1/workers/{wid}/directives", headers=auth(wid))
    assert res.status_code == 200
    return res.json()["directives"]


def later_today():
    # A start_at two hours ahead: the worker is outside its window now.
    return [(datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%H:%M")]


def setup(client):
    roster = {
        "catalog": CATALOG,
        "items": ["server_ram"],
        "workers": {
            wid: {"home": [home], "start_at": later_today()}
            for wid, home in (("nyc-1", "nyc"), ("homelab-1", "miami"), ("ne-1", "boston"))
        },
    }
    assert client.put("/v1/queue/roster", json=roster, headers=ADMIN).status_code == 200
    client.put("/v1/queue/settings", json={"enrolled": ["*"]}, headers=ADMIN)
    beat(client, "nyc-1", "0.13.18 (abc1234)")
    beat(client, "homelab-1", "0.13.17 (e045334)")
    beat(client, "ne-1", "0.13.18 (abc1234)", state="CHECKPOINT")


def test_the_preview_says_who_starts_now_and_who_at_its_usual_time(client):
    setup(client)
    assert client.get("/v1/queue/start", headers=LEGACY).status_code == 401
    preview = client.get("/v1/queue/start", headers=ADMIN).json()
    # ne-1 is parked: it starts nothing either way.
    assert (preview["wake"], preview["older"]) == (["nyc-1"], ["homelab-1"])
    assert preview["items"]["server_ram"] == {"due": 3, "queue": 3, "leased": 0}
    assert (preview["fresh_hours"], preview["window_hours"], preview["started"]) == (2, 8, None)
    # Previewing changes nothing.
    assert directives(client, "nyc-1") == []


def test_starting_wakes_the_workers_that_can_and_opens_the_window(client):
    setup(client)
    home = {"item": "server_ram", "home": ["nyc"], "start_at": later_today(), "done": None}
    ask = client.post("/v1/workers/nyc-1/next-city", json=home, headers=auth("nyc-1"))
    assert ask.json()["reason"] == "outside_window"

    res = client.post("/v1/queue/start", json={"updated_by": "Alex Chen"}, headers=ADMIN)
    assert res.status_code == 200
    started = res.json()["started"]
    assert started["by"] == "Alex Chen" and started["fresh_hours"] == 2
    assert res.json()["wake"] == ["nyc-1"]
    # One sweep, once, and only for the worker that acts on it.
    assert directives(client, "nyc-1") == ["sweep"]
    assert directives(client, "nyc-1") == []
    assert directives(client, "homelab-1") == []
    assert directives(client, "ne-1") == []

    ask = client.post("/v1/workers/nyc-1/next-city", json=home, headers=auth("nyc-1"))
    assert ask.json()["city"]["slug"] == "nyc"
    status = client.get("/v1/queue/status", headers=ADMIN).json()
    assert status["started"]["by"] == "Alex Chen" and "started" not in status["settings"]
    assert status["items"]["server_ram"]["leased"] == 1
    assert client.deps.db.queue_config("start")["updated_by"] == "Alex Chen"


def test_a_sweep_rides_the_heartbeat_too(client):
    setup(client)
    client.post("/v1/queue/start", json={}, headers=ADMIN)
    body = {"worker_id": "nyc-1", "state": "HEALTHY", "version": "0.13.18 (abc1234)"}
    res = client.post("/v1/heartbeat", json=body, headers=auth("nyc-1"))
    assert res.json()["directives"] == ["sweep"]
    assert directives(client, "nyc-1") == []


def test_rsc_queue_start(tmp_path, monkeypatch, capsys):
    from rs_coordinator import cli
    from rs_coordinator.db import open_database

    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "cli.db"))
    monkeypatch.delenv("RS_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    db = open_database()
    db.put_queue_config(
        "roster",
        {"catalog": CATALOG, "items": ["server_ram"], "workers": {"nyc-1": {"home": ["nyc"]}}},
        "test",
    )
    db.put_queue_config("settings", {"enrolled": ["nyc-1"]}, "test")
    db.upsert_worker("nyc-1", heartbeat=True)
    db.update_worker_health("nyc-1", {"state": "HEALTHY", "version": "0.13.18 (abc1234)"})
    assert cli.main(["queue", "start", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "would start now" in out and "nyc-1" in out and "3/3 due" in out
    assert db.queue_config("start") is None
    assert cli.main(["queue", "start"]) == 0
    assert "started now" in capsys.readouterr().out
    assert db.queue_config("start")["updated_by"] == "rsc"
    assert db.take_sweep("nyc-1") and not db.take_sweep("nyc-1")
    assert cli.main(["queue", "status"]) == 0
    assert "round started by hand" in capsys.readouterr().out
