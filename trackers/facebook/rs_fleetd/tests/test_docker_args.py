"""The container a worker gets: the compose files' service, flag for flag."""

import json
import subprocess
from pathlib import Path

from rs_fleetd import docker as fleet_docker
from rs_fleetd import plan
from rs_fleetd.docker import Docker, run_args
from rs_fleetd.plan import Settings

ROOT = Path("/srv/rs-fleet")


def spec_for(settings, adopted=None, **extra):
    entry = {
        "worker_id": "va-1",
        "image": "aimm-recycle:0.12.0",
        "generation": 3,
        "config_sha256": "c0ffee",
        "vnc_port": None,
        "env": {"RS_WORKER_ID": "va-1", "RS_CONTROL_PLANE_TOKEN": "va-1.sig", "RS_HOST_ID": "homelab"},
    }
    entry.update(extra)
    specs, errors = plan.build_specs({"workers": [entry]}, settings, adopted or {})
    assert errors == []
    return specs[0]


def test_the_exact_run_argv():
    settings = Settings(root=ROOT, env_files=("/etc/rs-fleet/secrets.env", "/etc/rs-fleet/fleet-worker.env"))
    spec = spec_for(settings)
    assert run_args(spec, settings) == [
        "run", "-d",
        "--name", "rs-worker-va-1",
        "--restart", "unless-stopped",
        "--stop-timeout", "30",
        "--shm-size", "1g",
        "--add-host", "host.docker.internal:host-gateway",
        "--network", "rs-fleet",
        "--log-driver", "json-file",
        "--log-opt", "max-size=20m",
        "--log-opt", "max-file=5",
        "--label", "rs.fleet.managed=1",
        "--label", "rs.fleet.worker=va-1",
        "--label", f"rs.fleet.spec={spec.spec_hash()}",
        "--label", "rs.fleet.image=aimm-recycle:0.12.0",
        "--label", "rs.fleet.generation=3",
        "--env-file", "/etc/rs-fleet/secrets.env",
        "--env-file", "/etc/rs-fleet/fleet-worker.env",
        "-e", "RS_CONTROL_PLANE_TOKEN=va-1.sig",
        "-e", "RS_HOST_ID=homelab",
        "-e", "RS_WORKER_ID=va-1",
        "-v", "/srv/rs-fleet/workers/va-1/config.toml:/root/.ai-marketplace-monitor/config.toml:ro",
        "-v", "aimm-home-va-1:/root/.ai-marketplace-monitor",
        "-v", "/srv/rs-fleet/sessions/va-1:/data",
        "aimm-recycle:0.12.0",
    ]


def test_an_adopted_worker_mounts_its_old_session_dir_and_cache():
    settings = Settings(root=ROOT)
    adopted = {"va-1": {"container": "rs-monitor-va1", "data_dir": "/home/j/configs/sessions/homelab-va1",
                        "cache_volume": "deploy_aimm-home-va1"}}
    args = run_args(spec_for(settings, adopted), settings)
    assert "/home/j/configs/sessions/homelab-va1:/data" in args
    assert "deploy_aimm-home-va1:/root/.ai-marketplace-monitor" in args


def test_the_healthcheck_is_wired_when_configured():
    settings = Settings(root=ROOT, healthcheck="/srv/rs-fleet/healthcheck.sh")
    args = run_args(spec_for(settings), settings)
    i = args.index("/srv/rs-fleet/healthcheck.sh:/usr/local/bin/rs-healthcheck:ro")
    assert args[i - 1] == "-v"
    assert args[i + 1 : i + 11] == [
        "--health-cmd", "/usr/local/bin/rs-healthcheck",
        "--health-interval", "5m",
        "--health-timeout", "1m",
        "--health-retries", "1",
        "--health-start-period", "10m",
    ]


def test_a_vnc_port_is_published_only_when_set():
    settings = Settings(root=ROOT, vnc_bind="10.10.10.74")
    assert "-p" not in run_args(spec_for(settings), settings)
    args = run_args(spec_for(settings, vnc_port=5911), settings)
    assert args[args.index("-p") + 1] == "10.10.10.74:5911:5900"
    assert args[-1] == "aimm-recycle:0.12.0"


# -- the CLI wrapper ------------------------------------------------------------


class Runner:
    """Answers docker commands from a script, recording each argv."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append(argv[1:])
        for prefix, (code, out, err) in self.answers:
            if argv[1 : 1 + len(prefix)] == prefix:
                return subprocess.CompletedProcess(argv, code, out, err)
        return subprocess.CompletedProcess(argv, 0, "", "")


def inspect_record(name, labels=None, running=True, image="aimm-recycle:latest", health=None):
    state = {"Running": running, "Status": "running" if running else "exited", "StartedAt": "2026-10-18T06:00:00Z"}
    if health:
        state["Health"] = {"Status": health}
    return {"Name": "/" + name, "Config": {"Labels": labels or {}, "Image": image}, "State": state}


def test_observe_finds_managed_and_adopted_and_ignores_the_rest():
    managed = inspect_record("rs-worker-va-2", {
        "rs.fleet.managed": "1", "rs.fleet.worker": "va-2", "rs.fleet.spec": "abc",
        "rs.fleet.image": "aimm-recycle:0.12.0", "rs.fleet.generation": "2"}, health="healthy")
    legacy = inspect_record("rs-monitor-va1", running=False)
    runner = Runner([
        (["ps"], (0, "id-va-2\n", "")),
        (["inspect", "id-va-2"], (0, json.dumps([managed]), "")),
        (["inspect", "rs-monitor-va1"], (0, json.dumps([legacy]), "")),
        (["inspect", "rs-monitor-gone"], (1, "", "Error: No such object: rs-monitor-gone")),
    ])
    adopted = {
        "va-1": {"container": "rs-monitor-va1", "data_dir": "/x", "cache_volume": "v"},
        "nyc-1": {"container": "rs-monitor-gone", "data_dir": "/y", "cache_volume": "w"},
    }
    found, errors = Docker(runner=runner).observe(adopted)
    assert errors == []
    assert set(found) == {"va-1", "va-2"}
    assert found["va-2"].managed and found["va-2"].spec == "abc" and found["va-2"].generation == 2
    assert found["va-2"].health == "healthy" and found["va-2"].image == "aimm-recycle:0.12.0"
    assert not found["va-1"].managed and not found["va-1"].running
    assert runner.calls[0] == ["ps", "-a", "-q", "--no-trunc", "--filter", "label=rs.fleet.managed=1"]


def test_an_unreachable_daemon_observes_nothing():
    runner = Runner([(["ps"], (1, "", "Cannot connect to the Docker daemon"))])
    found, errors = Docker(runner=runner).observe({})
    assert found is None
    assert "Cannot connect" in errors[0]


def test_a_missing_docker_binary_is_an_error_not_a_crash():
    def missing(argv, **kwargs):
        raise FileNotFoundError("docker")

    ok, out = Docker(runner=missing).call(["ps"])
    assert not ok and "docker ps" in out


def test_ensure_image_pulls_only_when_absent():
    runner = Runner([(["image", "inspect"], (1, "", "No such image"))])
    assert Docker(runner=runner).ensure_image("aimm-recycle:0.12.0") is None
    assert runner.calls[-1] == ["pull", "aimm-recycle:0.12.0"]

    failing = Runner([(["image", "inspect"], (1, "", "No such image")), (["pull"], (1, "", "manifest unknown"))])
    assert "manifest unknown" in Docker(runner=failing).ensure_image("aimm-recycle:9.9.9")


def test_stop_gives_the_session_save_its_thirty_seconds():
    runner = Runner([])
    assert Docker(runner=runner).stop_and_remove("rs-worker-va-1") is None
    assert runner.calls == [["stop", "-t", "30", "rs-worker-va-1"], ["rm", "rs-worker-va-1"]]
    assert fleet_docker.STOP_TIMEOUT == 30
