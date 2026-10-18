"""One tick, end to end, against a fake coordinator and a fake Docker.

The requirement these pin: the coordinator and the workers never take each
other down. Offline the host keeps what it runs; observe-only it runs
nothing; a pull that fails leaves the old container in place.
"""

import json
from typing import Any, Dict, List, Optional

from rs_fleetd import state
from rs_fleetd.agent import Agent
from rs_fleetd.plan import Container, Settings

TOML = "[marketplace.facebook]\nsearch_city = ['denver']\n"
SHA = state.sha256_text(TOML)


def desired(image="aimm-recycle:0.12.0", authoritative=True, workers=None):
    return {
        "host_id": "homelab",
        "authoritative": authoritative,
        "workers": workers if workers is not None else [{
            "worker_id": "va-1", "image": image, "generation": 1, "config_sha256": SHA,
            "vnc_port": None, "env": {"RS_WORKER_ID": "va-1", "RS_CONTROL_PLANE_TOKEN": "va-1.sig"},
        }],
    }


class FakeClient:
    def __init__(self, doc: Optional[Dict[str, Any]], toml: str = TOML):
        self.doc = doc
        self.toml = toml
        self.reports: List[Dict[str, Any]] = []
        self.config_fetches = 0

    def desired(self):
        return self.doc

    def config(self, worker_id):
        self.config_fetches += 1
        return {"worker_id": worker_id, "sha256": state.sha256_text(self.toml), "toml": self.toml}

    def report(self, payload):
        self.reports.append(payload)
        return True


class FakeDocker:
    """Containers in a dict; every command recorded."""

    def __init__(self, containers=None, images=("aimm-recycle:0.11.0", "aimm-recycle:0.12.0"), reachable=True):
        self.containers: Dict[str, Container] = dict(containers or {})
        self.images = set(images)
        self.reachable = reachable
        self.commands: List[tuple] = []

    def observe(self, adopted):
        if not self.reachable:
            return None, ["Cannot connect to the Docker daemon"]
        return dict(self.containers), []

    def ensure_image(self, image):
        self.commands.append(("ensure", image))
        return None if image in self.images else f"pull access denied for {image}"

    def run(self, spec, settings):
        self.commands.append(("run", spec.container, spec.image))
        self.containers[spec.worker_id] = Container(
            name=spec.container, worker_id=spec.worker_id, managed=True, running=True,
            image=spec.image, spec=spec.spec_hash(), generation=spec.generation,
        )
        return None

    def start(self, name):
        self.commands.append(("start", name))
        return None

    def stop_and_remove(self, name):
        self.commands.append(("stop+rm", name))
        self.containers = {k: c for k, c in self.containers.items() if c.name != name}
        return None


def agent(tmp_path, client, docker, observe_only=False):
    return Agent(Settings(root=tmp_path), client, docker, observe_only=observe_only)


def old_container(tmp_path, image="aimm-recycle:0.11.0"):
    """What a previous tick would have left running for va-1 on `image`."""
    from rs_fleetd import plan

    spec = plan.build_specs(desired(image=image), Settings(root=tmp_path), {})[0][0]
    return Container(name=spec.container, worker_id="va-1", managed=True, running=True,
                     image=image, spec=spec.spec_hash(), generation=1)


# -- online -------------------------------------------------------------------


def test_online_it_writes_the_config_runs_the_worker_and_reports(tmp_path):
    client, docker = FakeClient(desired()), FakeDocker()
    result = agent(tmp_path, client, docker).tick()

    assert result.online and not result.observe_only
    assert (tmp_path / "workers" / "va-1" / "config.toml").read_text() == TOML
    assert ("run", "rs-worker-va-1", "aimm-recycle:0.12.0") in docker.commands
    assert (tmp_path / "sessions" / "va-1").is_dir()
    assert json.loads((tmp_path / "desired.json").read_text())["workers"][0]["worker_id"] == "va-1"
    report = client.reports[-1]
    assert report["workers"][0]["container"] == "rs-worker-va-1"  # what runs after the tick
    assert report["plan"] == [{"action": "run", "worker_id": "va-1", "reason": "missing"}]
    assert report["observe_only"] is False and report["errors"] == []


def test_a_new_release_replaces_the_container_after_the_image_is_there(tmp_path):
    docker = FakeDocker({"va-1": old_container(tmp_path)})
    state.write_in_place(state.config_path(tmp_path, "va-1"), TOML)
    agent(tmp_path, FakeClient(desired()), docker).tick()
    assert docker.commands == [
        ("ensure", "aimm-recycle:0.12.0"),
        ("stop+rm", "rs-worker-va-1"),
        ("run", "rs-worker-va-1", "aimm-recycle:0.12.0"),
    ]


def test_a_failed_pull_leaves_the_old_container_running(tmp_path):
    docker = FakeDocker({"va-1": old_container(tmp_path)}, images={"aimm-recycle:0.11.0"})
    state.write_in_place(state.config_path(tmp_path, "va-1"), TOML)
    client = FakeClient(desired())
    result = agent(tmp_path, client, docker).tick()

    assert docker.commands == [("ensure", "aimm-recycle:0.12.0")]
    assert "va-1" in docker.containers
    assert any("not available" in e for e in result.errors)
    assert any("not available" in e for e in client.reports[-1]["errors"])


def test_a_config_edit_is_written_in_place_without_touching_the_container(tmp_path):
    path = state.config_path(tmp_path, "va-1")
    state.write_in_place(path, "old = 1\n")
    inode = path.stat().st_ino
    docker = FakeDocker({"va-1": old_container(tmp_path, image="aimm-recycle:0.12.0")})
    agent(tmp_path, FakeClient(desired()), docker).tick()

    assert path.read_text() == TOML and path.stat().st_ino == inode
    assert docker.commands == []


def test_a_config_that_fails_its_checksum_is_not_written(tmp_path):
    client = FakeClient(desired(), toml="tampered = true\n")
    docker = FakeDocker()
    result = agent(tmp_path, client, docker).tick()
    assert not state.config_path(tmp_path, "va-1").exists()
    assert docker.commands == []  # no config on disk: not started
    assert any("checksum" in e for e in result.errors)


# -- offline: keep everything -------------------------------------------------


def test_offline_it_keeps_running_what_it_last_knew(tmp_path):
    state.save_desired(tmp_path, desired(image="aimm-recycle:0.12.0"))
    docker = FakeDocker({"va-1": old_container(tmp_path), "gone-1": Container(
        name="rs-worker-gone-1", worker_id="gone-1", managed=True, running=True)})
    client = FakeClient(None)
    result = agent(tmp_path, client, docker).tick()

    assert not result.online
    assert docker.commands == []  # no replace, no remove
    assert client.reports == []   # nobody to report to
    assert client.config_fetches == 0


def test_offline_with_no_cache_it_touches_nothing(tmp_path):
    docker = FakeDocker({"va-1": old_container(tmp_path)})
    result = agent(tmp_path, FakeClient(None), docker).tick()
    assert result.actions == [] and docker.commands == []


def test_an_unreachable_daemon_is_reported_and_nothing_is_planned(tmp_path):
    client = FakeClient(desired())
    result = agent(tmp_path, client, FakeDocker(reachable=False)).tick()
    assert result.actions == []
    assert "Cannot connect" in client.reports[-1]["errors"][0]


# -- observe-only ---------------------------------------------------------------


def test_observe_only_plans_and_reports_but_runs_nothing(tmp_path):
    for doc, local in ((desired(authoritative=False), False), (desired(), True)):
        client, docker = FakeClient(doc), FakeDocker()
        result = agent(tmp_path, client, docker, observe_only=local).tick()
        assert result.observe_only
        assert docker.commands == []
        assert client.reports[-1]["observe_only"] is True
        assert client.reports[-1]["plan"][0]["action"] == "run"


def test_the_plan_command_writes_nothing(tmp_path):
    client, docker = FakeClient(desired()), FakeDocker()
    result = agent(tmp_path, client, docker).tick(apply=False, write=False)
    assert [a.kind for a in result.actions] == []  # no config on disk, so nothing to run
    assert not (tmp_path / "desired.json").exists()
    assert client.reports == [] and docker.commands == []


# -- removal --------------------------------------------------------------------


def test_a_worker_moved_off_this_host_is_removed_but_its_data_stays(tmp_path):
    data = tmp_path / "sessions" / "gone-1"
    data.mkdir(parents=True)
    (data / "fb_state.json").write_text("{}")
    docker = FakeDocker({"gone-1": Container(name="rs-worker-gone-1", worker_id="gone-1", managed=True, running=True)})
    agent(tmp_path, FakeClient(desired(workers=[])), docker).tick()
    assert docker.commands == [("stop+rm", "rs-worker-gone-1")]
    assert (data / "fb_state.json").exists()
