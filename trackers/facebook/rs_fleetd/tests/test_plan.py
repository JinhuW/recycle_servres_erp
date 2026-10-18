"""The rules that decide whether a running Facebook worker is touched.

Everything here is about restraint: offline the agent changes nothing it
already runs, an observe-only host loses nothing, and at most one worker is
created per tick.
"""

from pathlib import Path

from rs_fleetd import plan
from rs_fleetd.plan import Container, Settings

ROOT = Path("/srv/rs-fleet")
SETTINGS = Settings(root=ROOT, env_files=("/etc/rs-fleet/secrets.env",))


def desired(*workers, authoritative=True):
    return {"authoritative": authoritative, "workers": list(workers)}


def worker(worker_id="va-1", image="aimm-recycle:0.12.0", generation=1, sha="c0ffee", **extra):
    entry = {
        "worker_id": worker_id,
        "image": image,
        "generation": generation,
        "config_sha256": sha,
        "vnc_port": None,
        "env": {"RS_WORKER_ID": worker_id, "RS_CONTROL_PLANE_TOKEN": f"{worker_id}.sig"},
    }
    entry.update(extra)
    return entry


def specs_of(doc, adopted=None):
    specs, errors = plan.build_specs(doc, SETTINGS, adopted or {})
    assert errors == []
    return specs


def running(spec, **overrides):
    """The container `spec` would have produced, running."""
    fields = dict(
        name=spec.container,
        worker_id=spec.worker_id,
        managed=True,
        running=True,
        image=spec.image,
        spec=spec.spec_hash(),
        generation=spec.generation,
    )
    fields.update(overrides)
    return Container(**fields)


def kinds(actions):
    return [(a.kind, a.worker_id) for a in actions]


def run_plan(specs, containers, online=True, authoritative=True, ready=None):
    ready = {s.worker_id for s in specs} if ready is None else ready
    return plan.plan(specs, containers, online=online, authoritative=authoritative, configs_ready=ready)


# -- creating and keeping ----------------------------------------------------


def test_a_missing_worker_is_run():
    specs = specs_of(desired(worker()))
    actions, errors = run_plan(specs, {})
    assert kinds(actions) == [("run", "va-1")]
    assert actions[0].container == "rs-worker-va-1"
    assert errors == []


def test_an_up_to_date_running_worker_is_left_alone():
    specs = specs_of(desired(worker()))
    actions, errors = run_plan(specs, {"va-1": running(specs[0])})
    assert actions == [] and errors == []


def test_a_new_image_recreates_the_worker():
    specs = specs_of(desired(worker(image="aimm-recycle:0.12.0")))
    old = specs_of(desired(worker(image="aimm-recycle:0.11.0")))[0]
    actions, _ = run_plan(specs, {"va-1": running(old)})
    assert kinds(actions) == [("recreate", "va-1")]
    assert actions[0].reason == "image aimm-recycle:0.11.0 -> aimm-recycle:0.12.0"


def test_a_bumped_generation_recreates_the_worker():
    specs = specs_of(desired(worker(generation=5)))
    old = specs_of(desired(worker(generation=4)))[0]
    actions, _ = run_plan(specs, {"va-1": running(old)})
    assert actions[0].reason == "generation 4 -> 5"


def test_an_adopted_compose_container_is_recreated_into_a_managed_one():
    adopted = {"va-1": {"container": "rs-monitor-va1", "data_dir": "/x", "cache_volume": "deploy_aimm-home-va1"}}
    specs = specs_of(desired(worker()), adopted)
    legacy = Container(name="rs-monitor-va1", worker_id="va-1", managed=False, running=True)
    actions, _ = run_plan(specs, {"va-1": legacy})
    assert kinds(actions) == [("recreate", "va-1")]
    assert actions[0].container == "rs-monitor-va1"
    assert actions[0].reason == "adopt rs-monitor-va1"


def test_a_stopped_worker_is_started_not_recreated():
    specs = specs_of(desired(worker()))
    actions, _ = run_plan(specs, {"va-1": running(specs[0], running=False)})
    assert kinds(actions) == [("start", "va-1")]


def test_a_config_edit_does_not_recreate_the_worker():
    """The config is rewritten in place and reloaded; its checksum is not the spec."""
    specs = specs_of(desired(worker(sha="old")))
    newer = specs_of(desired(worker(sha="new")))
    actions, _ = run_plan(newer, {"va-1": running(specs[0])})
    assert actions == []


# -- one creation per tick ------------------------------------------------------


def test_at_most_one_worker_is_created_or_replaced_per_tick():
    specs = specs_of(desired(worker("a-1"), worker("b-1"), worker("c-1")))
    stale = specs_of(desired(worker("b-1", image="old")))[0]
    containers = {"b-1": running(stale), "c-1": running(specs[2], running=False)}
    actions, _ = run_plan(specs, containers)
    # One RUN (the first in order); the RECREATE waits; START is not limited.
    assert kinds(actions) == [("run", "a-1"), ("start", "c-1")]


# -- removing -------------------------------------------------------------------


def test_a_managed_worker_no_longer_desired_is_removed():
    gone = specs_of(desired(worker("old-1")))[0]
    actions, _ = run_plan([], {"old-1": running(gone)})
    assert kinds(actions) == [("remove", "old-1")]


def test_an_observe_only_desired_state_removes_nothing():
    gone = specs_of(desired(worker("old-1")))[0]
    actions, _ = run_plan([], {"old-1": running(gone)}, authoritative=False)
    assert actions == []


def test_an_adopted_container_is_never_removed():
    legacy = Container(name="rs-monitor-x", worker_id="x-1", managed=False, running=True)
    actions, _ = run_plan([], {"x-1": legacy})
    assert actions == []


# -- offline: keep everything ---------------------------------------------------


def test_offline_nothing_is_replaced_or_removed():
    specs = specs_of(desired(worker(image="new")))
    old = specs_of(desired(worker(image="old")))[0]
    gone = specs_of(desired(worker("old-1")))[0]
    actions, _ = run_plan(specs, {"va-1": running(old), "old-1": running(gone)}, online=False)
    assert actions == []


def test_offline_a_stopped_known_worker_is_still_started():
    """A host reboot while the coordinator is down: bring back what it knew."""
    specs = specs_of(desired(worker(image="new")))
    old = specs_of(desired(worker(image="old")))[0]
    actions, _ = run_plan(specs, {"va-1": running(old, running=False)}, online=False)
    assert kinds(actions) == [("start", "va-1")]


def test_offline_a_missing_cached_worker_is_run():
    specs = specs_of(desired(worker()))
    actions, _ = run_plan(specs, {}, online=False)
    assert kinds(actions) == [("run", "va-1")]


# -- configs --------------------------------------------------------------------


def test_a_worker_without_a_config_is_not_started():
    specs = specs_of(desired(worker(sha=None)))
    actions, errors = run_plan(specs, {})
    assert actions == []
    assert errors == ["va-1: the coordinator has no config for it yet; not started"]


def test_a_worker_whose_config_is_not_on_disk_is_not_started():
    specs = specs_of(desired(worker()))
    actions, errors = run_plan(specs, {}, ready=set())
    assert actions == []
    assert "not on disk" in errors[0]


# -- the specs themselves ---------------------------------------------------------


def test_an_adopted_worker_keeps_its_session_dir_and_cache_volume():
    adopted = {"va-1": {"container": "rs-monitor-va1", "data_dir": "/home/j/sessions/homelab-va1",
                        "cache_volume": "deploy_aimm-home-va1"}}
    spec = specs_of(desired(worker()), adopted)[0]
    assert spec.data_dir == "/home/j/sessions/homelab-va1"
    assert spec.cache_volume == "deploy_aimm-home-va1"
    assert spec.adopted


def test_a_fresh_worker_lives_under_the_root():
    spec = specs_of(desired(worker()))[0]
    assert spec.data_dir == "/srv/rs-fleet/sessions/va-1"
    assert spec.cache_volume == "aimm-home-va-1"
    assert spec.config_path == "/srv/rs-fleet/workers/va-1/config.toml"


def test_the_spec_hash_covers_what_only_takes_effect_at_creation():
    base = specs_of(desired(worker()))[0]
    for changed in (
        worker(image="other"),
        worker(generation=2),
        worker(env={"RS_WORKER_ID": "va-1", "RS_CONTROL_PLANE_TOKEN": "rotated"}),
        worker(vnc_port=5911),
    ):
        assert specs_of(desired(changed))[0].spec_hash() != base.spec_hash()
    assert specs_of(desired(worker(sha="other")))[0].spec_hash() == base.spec_hash()


def test_malformed_desired_entries_are_skipped_not_fatal():
    doc = desired(
        worker("ok-1"),
        {"worker_id": "bad id", "image": "x"},
        worker("no-image", image=""),
        worker("bad-env", env={"lower-case-bad": 1}),
        worker("bad-port", vnc_port=70000),
        "not an object",
        worker("ok-1"),
    )
    specs, errors = plan.build_specs(doc, SETTINGS, {})
    assert [s.worker_id for s in specs] == ["ok-1"]
    assert len(errors) == 6
