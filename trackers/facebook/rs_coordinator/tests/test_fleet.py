"""The fleet: one worker per ready slot, upgraded one at a time, never twice.

What these fence: a host only ever sees its own workers; placement is sticky
and never moves a worker on its own; a release waits for each worker to come
back no worse than it left, and stops — reverting that one worker and nobody
else — when one does not.
"""

import importlib
import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from rs_coordinator import fleet
from rs_coordinator.health import _moment, liveness_sweep
from rs_coordinator.tokens import (
    mint_host_token,
    mint_worker_token,
    verify_host_token,
    verify_worker_token,
)
from rs_coordinator.vault import generate_key

ADMIN_TOKEN = "test-admin-token"
SECRET = "test-hmac-secret"
ADMIN = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
CONFIG = '[marketplace.facebook]\nsearch_city = ["denver"]\n'


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "fleet.db"))
    monkeypatch.setenv("RS_ADMIN_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", SECRET)
    monkeypatch.setenv("RS_VAULT_KEY", generate_key())
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)
    client = TestClient(app_module.app)
    client.db = app_module.db
    client.store = deps_module.get_account_store()
    yield client


def host_auth(host_id: str) -> dict:
    return {"Authorization": f"Bearer {mint_host_token(host_id, SECRET)}"}


def slot(client, worker_id: str, enabled: bool = True, config: bool = True, **fields) -> None:
    client.store.put_account(worker_id, {"password": "pw"}, worker_id=worker_id)
    client.db.put_account(worker_id, {"fleet_enabled": 1 if enabled else 0, **fields})
    if config:
        client.put(f"/v1/fleet/configs/{worker_id}", json={"toml": CONFIG}, headers=ADMIN)


def host(client, host_id: str = "homelab", capacity: int = 4, authoritative: bool = True) -> None:
    client.put(
        f"/v1/fleet/hosts/{host_id}",
        json={"capacity": capacity, "authoritative": authoritative},
        headers=ADMIN,
    )
    report(client, host_id)


def report(client, host_id: str = "homelab", running=()) -> None:
    body = {"agent_version": "0.12.0", "workers": [{"worker_id": w, "running": True} for w in running]}
    assert client.post(f"/v1/fleet/hosts/{host_id}/report", json=body, headers=host_auth(host_id)).status_code == 200


def release(client, version: str = "0.12.0") -> dict:
    return client.post(
        "/v1/fleet/releases", json={"version": version, "image": f"aimm-recycle:{version}"}, headers=ADMIN
    ).json()


def beat(client, worker_id: str, version: str, state: str = "HEALTHY") -> None:
    client.db.upsert_worker(worker_id, heartbeat=True)
    client.db.update_worker_health(worker_id, {"version": f"{version} (abc1234)", "state": state})


# -- tokens: a host sees its own workers and nothing else ----------------------


def test_host_and_worker_tokens_never_pass_for_each_other():
    host_token = mint_host_token("homelab", SECRET)
    worker_token = mint_worker_token("homelab", SECRET)
    assert verify_host_token(host_token, SECRET) == "homelab"
    assert verify_worker_token(host_token, SECRET) is None
    assert verify_host_token(worker_token, SECRET) is None
    assert verify_host_token(host_token, "another-secret") is None


def test_a_host_only_reads_its_own_desired_state_and_configs(env):
    host(env, "homelab")
    host(env, "nyc-box")
    slot(env, "va-1", pin_host="homelab")
    release(env)
    fleet.tick(env.db)

    assert env.get("/v1/fleet/hosts/homelab/desired").status_code == 401
    assert env.get("/v1/fleet/hosts/homelab/desired", headers=host_auth("nyc-box")).status_code == 403
    assert env.get("/v1/fleet/hosts/homelab/desired", headers={"Authorization": f"Bearer {mint_worker_token('va-1', SECRET)}"}).status_code == 401
    assert env.get("/v1/fleet/hosts/nyc-box/configs/va-1", headers=host_auth("nyc-box")).status_code == 403

    desired = env.get("/v1/fleet/hosts/homelab/desired", headers=host_auth("homelab")).json()
    (worker,) = desired["workers"]
    assert worker["worker_id"] == "va-1" and worker["image"] == "aimm-recycle:0.12.0"
    assert verify_worker_token(worker["env"]["RS_CONTROL_PLANE_TOKEN"], SECRET) == "va-1"
    config = env.get("/v1/fleet/hosts/homelab/configs/va-1", headers=host_auth("homelab")).json()
    assert config["toml"] == CONFIG and config["sha256"] == worker["config_sha256"]


def test_a_new_host_registers_itself_observe_only_and_empty(env):
    desired = env.get("/v1/fleet/hosts/new-vm/desired", headers=host_auth("new-vm")).json()
    assert desired == desired | {"host_id": "new-vm", "authoritative": False, "workers": []}
    assert env.db.get_fleet_host("new-vm")["authoritative"] == 0


# -- placement: one worker per ready slot ---------------------------------------


def test_only_enabled_slots_with_a_config_get_a_worker(env):
    host(env)
    release(env)
    slot(env, "va-1")
    slot(env, "va-2", enabled=False)
    slot(env, "va-3", config=False)
    fleet.tick(env.db)

    placed = {a["worker_id"]: a for a in env.db.list_assignments()}
    assert set(placed) == {"va-1"}
    assert placed["va-1"]["host_id"] == "homelab" and placed["va-1"]["state"] == "run"


def test_nothing_is_placed_before_the_first_release_names_an_image(env):
    host(env)
    slot(env, "va-1")
    fleet.tick(env.db)
    assert env.db.list_assignments() == []


def test_placement_fills_the_emptiest_live_uncordoned_host(env):
    host(env, "a", capacity=1)
    host(env, "b", capacity=2)
    host(env, "c", capacity=9)
    env.put("/v1/fleet/hosts/c", json={"cordoned": True}, headers=ADMIN)
    release(env)
    for wid in ("w1", "w2", "w3", "w4"):
        slot(env, wid)
    fleet.tick(env.db)

    on = {a["worker_id"]: a["host_id"] for a in env.db.list_assignments()}
    assert sorted(on.values()) == ["a", "b", "b"]  # capacity holds; the fourth waits
    assert "c" not in on.values()


def test_a_silent_host_gets_no_new_workers(env):
    host(env, "a")
    env.db.upsert_fleet_host("a", {"last_seen_at": "2026-01-01T00:00:00+00:00"})
    release(env)
    slot(env, "w1")
    fleet.tick(env.db)
    assert env.db.list_assignments() == []


def test_a_pinned_slot_only_runs_on_its_host(env):
    host(env, "a", capacity=9)
    host(env, "denver-box", capacity=1)
    release(env)
    slot(env, "denver-1", pin_host="denver-box")
    fleet.tick(env.db)
    assert env.db.get_assignment("denver-1")["host_id"] == "denver-box"


def test_turning_a_slot_off_stops_it_quietly_and_on_brings_it_home(env):
    host(env, "a", capacity=9)
    host(env, "b", capacity=9)
    release(env)
    slot(env, "va-1", pin_host="b")
    fleet.tick(env.db)
    env.db.put_account("va-1", {"pin_host": None})

    env.put("/v1/fleet/workers/va-1", json={"enabled": False}, headers=ADMIN)
    fleet.tick(env.db)
    stopped = env.db.get_assignment("va-1")
    assert stopped["state"] == "stopped" and stopped["host_id"] == "b"
    assert env.db.get_worker("va-1")["retired_at"]
    # Stopped on purpose: the liveness sweep has nothing to page about.
    assert liveness_sweep(env.db.list_workers(), _moment(None) + timedelta(days=2)) == []

    env.put("/v1/fleet/workers/va-1", json={"enabled": True}, headers=ADMIN)
    fleet.tick(env.db)
    back = env.db.get_assignment("va-1")
    assert back["state"] == "run" and back["host_id"] == "b"  # where its session is
    assert back["generation"] > stopped["generation"]
    assert env.db.get_worker("va-1")["retired_at"] is None


def test_a_worker_on_a_dead_host_is_never_moved_on_its_own(env):
    host(env, "a")
    host(env, "b")
    release(env)
    slot(env, "va-1", pin_host="a")
    fleet.tick(env.db)
    env.db.put_account("va-1", {"pin_host": None})
    env.db.upsert_fleet_host("a", {"last_seen_at": "2026-01-01T00:00:00+00:00"})
    fleet.tick(env.db)
    assert env.db.get_assignment("va-1")["host_id"] == "a"


def test_hosts_that_publish_vnc_get_a_port_each(env):
    env.put("/v1/fleet/hosts/lan-box", json={"capacity": 5, "authoritative": True, "vnc_host": "10.10.10.80"}, headers=ADMIN)
    report(env, "lan-box")
    host(env, "homelab", capacity=0)
    release(env)
    slot(env, "w1")
    slot(env, "w2")
    fleet.tick(env.db)
    ports = sorted(a["vnc_port"] for a in env.db.list_assignments())
    assert ports == [5901, 5902]


# -- rolling releases --------------------------------------------------------------


def rolled(client) -> dict:
    """Two workers on 0.11.1, both healthy, then a 0.12.0 release."""
    host(client)
    release(client, "0.11.1")
    slot(client, "va-1")
    slot(client, "va-2")
    fleet.tick(client.db)
    client.db.update_release(client.db.list_releases(1)[0]["id"], {"state": "done"})
    for wid in ("va-1", "va-2"):
        beat(client, wid, "0.11.1")
    return release(client, "0.12.0")


def test_a_release_upgrades_one_worker_at_a_time(env):
    rolled(env)
    fleet.tick(env.db)
    images = {a["worker_id"]: a["image"] for a in env.db.list_assignments()}
    assert sorted(images.values()) == ["aimm-recycle:0.11.1", "aimm-recycle:0.12.0"]
    first = next(w for w, i in images.items() if i.endswith("0.12.0"))

    fleet.tick(env.db)  # no heartbeat on 0.12.0 yet: the second one waits
    assert sum(a["image"].endswith("0.12.0") for a in env.db.list_assignments()) == 1

    beat(env, first, "0.12.0")
    fleet.tick(env.db)
    assert all(a["image"].endswith("0.12.0") for a in env.db.list_assignments())
    second = next(w for w in ("va-1", "va-2") if w != first)
    beat(env, second, "0.12.0")
    alerts = fleet.tick(env.db)
    latest = env.db.list_releases(1)[0]
    assert latest["state"] == "done"
    assert sorted(json.loads(latest["upgraded_json"])) == ["va-1", "va-2"]
    assert alerts and "done" in alerts[0]


def test_a_healthy_worker_that_comes_back_parked_holds_the_release(env):
    rolled(env)
    fleet.tick(env.db)
    first = env.db.list_releases(1)[0]["current_worker"]
    beat(env, first, "0.12.0", state="SESSION_EXPIRED")
    fleet.tick(env.db)
    assert env.db.list_releases(1)[0]["current_worker"] == first  # still waiting


def test_a_worker_that_does_not_come_back_is_reverted_and_the_release_stops(env):
    rolled(env)
    fleet.tick(env.db)
    first = env.db.list_releases(1)[0]["current_worker"]
    later = _moment(None) + fleet.GATE_TIMEOUT + timedelta(minutes=1)

    alerts = fleet.advance_rollout(env.db, later)
    latest = env.db.list_releases(1)[0]
    assert latest["state"] == "failed" and latest["failed_worker"] == first
    assert env.db.get_assignment(first)["image"] == "aimm-recycle:0.11.1"
    other = next(w for w in ("va-1", "va-2") if w != first)
    assert env.db.get_assignment(other)["image"] == "aimm-recycle:0.11.1"  # never touched
    assert alerts and "stopped" in alerts[0]
    assert fleet.advance_rollout(env.db, later) == []


def test_a_parked_worker_passes_if_it_comes_back_at_all():
    assert fleet.gate_ok("SESSION_EXPIRED", "SESSION_EXPIRED")
    assert fleet.gate_ok("CHALLENGE_2FA", "HEALTHY")
    assert not fleet.gate_ok("CHECKPOINT", "DEAD")
    assert fleet.gate_ok("DOWN", "SESSION_EXPIRED")
    assert not fleet.gate_ok("HEALTHY", "DEGRADED")


def test_workers_on_silent_or_observe_only_hosts_are_skipped(env):
    rolled(env)
    env.put("/v1/fleet/hosts/homelab", json={"authoritative": False}, headers=ADMIN)
    alerts = fleet.tick(env.db)
    latest = env.db.list_releases(1)[0]
    assert latest["state"] == "done"
    assert sorted(json.loads(latest["skipped_json"])) == ["va-1", "va-2"]
    assert all(a["image"].endswith("0.11.1") for a in env.db.list_assignments())
    assert "Skipped" in alerts[0]


def test_paused_releases_wait_and_a_new_one_supersedes(env):
    first = rolled(env)
    env.post(f"/v1/fleet/releases/{first['id']}/pause", json={}, headers=ADMIN)
    fleet.tick(env.db)
    assert all(a["image"].endswith("0.11.1") for a in env.db.list_assignments())
    second = release(env, "0.12.1")
    assert env.db.get_release(first["id"])["state"] == "superseded"
    assert second["state"] == "rolling"
    assert env.post(f"/v1/fleet/releases/{first['id']}/resume", json={}, headers=ADMIN).status_code == 409


def test_new_workers_start_on_the_newest_good_release(env):
    rolled(env)
    slot(env, "va-3")
    fleet.reconcile_assignments(env.db)
    assert env.db.get_assignment("va-3")["image"] == "aimm-recycle:0.12.0"


# -- moves: one session, one browser ------------------------------------------------


def test_a_move_waits_for_the_old_host_to_report_the_container_gone(env):
    host(env, "a")
    host(env, "b")
    release(env)
    slot(env, "va-1", pin_host="a")
    fleet.tick(env.db)
    env.db.put_account("va-1", {"pin_host": None})

    env.post("/v1/fleet/workers/va-1/move", json={"host_id": "b"}, headers=ADMIN)
    old_desired = env.get("/v1/fleet/hosts/a/desired", headers=host_auth("a")).json()
    new_desired = env.get("/v1/fleet/hosts/b/desired", headers=host_auth("b")).json()
    assert old_desired["workers"] == [] and new_desired["workers"] == []

    report(env, "a", running=["va-1"])  # still running there
    assert env.db.get_assignment("va-1")["host_id"] == "a"
    report(env, "a")  # gone
    assert env.db.get_assignment("va-1")["host_id"] == "b"
    assert [w["worker_id"] for w in env.get("/v1/fleet/hosts/b/desired", headers=host_auth("b")).json()["workers"]] == ["va-1"]


def test_a_forced_move_is_immediate(env):
    host(env, "a")
    host(env, "b")
    release(env)
    slot(env, "va-1", pin_host="a")
    fleet.tick(env.db)
    moved = env.post("/v1/fleet/workers/va-1/move", json={"host_id": "b", "force": True}, headers=ADMIN).json()
    assert moved["host_id"] == "b" and moved["move_to_host"] is None
    assert env.post("/v1/fleet/workers/nope/move", json={"host_id": "b"}, headers=ADMIN).status_code == 404


# -- configs ----------------------------------------------------------------------


def test_configs_must_parse_and_are_stored_by_hash(env):
    assert env.put("/v1/fleet/configs/va-1", json={"toml": "not = [toml"}, headers=ADMIN).status_code == 400
    assert env.put("/v1/fleet/configs/va-1", json={"toml": "x" * 300_000}, headers=ADMIN).status_code == 413
    assert env.put("/v1/fleet/configs/bad.id!", json={"toml": CONFIG}, headers=ADMIN).status_code == 400
    first = env.put("/v1/fleet/configs/va-1", json={"toml": CONFIG}, headers=ADMIN).json()
    again = env.put("/v1/fleet/configs/va-1", json={"toml": CONFIG}, headers=ADMIN).json()
    assert first["changed"] is True and again["changed"] is False
    assert env.get("/v1/fleet/configs", headers=ADMIN).json()["configs"][0]["sha256"] == first["sha256"]
    assert env.get("/v1/fleet/configs/va-1").status_code == 401


def test_state_reports_hosts_slots_and_releases(env):
    host(env)
    release(env)
    slot(env, "va-1")
    fleet.tick(env.db)
    state = env.get("/v1/fleet/state", headers=ADMIN).json()
    assert state["hosts"][0]["live"] is True and "report_json" not in state["hosts"][0]
    assert state["assignments"][0]["worker_id"] == "va-1"
    assert state["slots"][0] == {"account_id": "va-1", "worker_id": "va-1", "fleet_enabled": True, "pin_host": None}
    assert state["image"] == "aimm-recycle:0.12.0"


def test_the_background_loop_queues_fleet_alerts(env):
    from rs_coordinator.background import Background

    rolled(env)
    env.put("/v1/fleet/hosts/homelab", json={"authoritative": False}, headers=ADMIN)
    loop = Background(lambda: env.db, notifier=None, ops_notifier=None)  # type: ignore[arg-type]
    loop._last_sweep = 1e18  # keep the liveness sweep out of this tick
    loop.drain_outbox = lambda db: None  # type: ignore[method-assign]
    loop.tick()
    assert [a["kind"] for a in env.db.due_alerts()] == ["ops_fleet"]


def test_heartbeats_record_the_host(env):
    token = {"Authorization": f"Bearer {mint_worker_token('va-1', SECRET)}"}
    env.post("/v1/heartbeat", json={"worker_id": "va-1", "state": "HEALTHY", "host_id": "homelab"}, headers=token)
    assert env.db.get_worker("va-1")["host_id"] == "homelab"
    assert env.get("/v1/workers", headers=ADMIN).json()["workers"][0]["host_id"] == "homelab"
