"""The worker entrypoint, against the fake fleet.

The contract: without the three fleet variables the image's command is
exec'd unchanged; with them the entrypoint claims a slot, renders the
monitor's config, session and device inside the container, hands the
password fallback over in the environment, serves /healthz while the
monitor runs, and leaves with the monitor's exit code; `no_slot` is 75 at
once, any other claim failure is three tries ten seconds apart and 70.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import subprocess
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest
import tomllib

from rs_worker import entry

from .fake_fleet import ACCOUNT, HOST_TOKEN, FakeFleet, mint_token, read_token

TRACKER_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def fleet() -> Iterator[FakeFleet]:
    with FakeFleet(hold_seconds=0.2) as server:
        yield server


@pytest.fixture(autouse=True)
def no_display(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never start a real Xvfb or x11vnc from a test host that happens to have one."""
    monkeypatch.setattr(entry.shutil, "which", lambda name: None)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def fleet_env(fleet: FakeFleet, **extra: str) -> Dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "RS_FLEET_URL": fleet.url + "/",
        "RS_FLEET_HOST_ID": "lab",
        "RS_FLEET_HOST_TOKEN": HOST_TOKEN,
        "RS_FLEET_WORKER_ID": "lab-1",
        "RS_VNC_PORT": "5903",
        "RS_VERSION": "0.14.0",
        "RS_WORKER_HEALTHZ_PORT": str(free_port()),
    }
    env.update(extra)
    return env


def monitor_script(tmp_path: Path) -> Path:
    """A monitor stand-in: records its environment, waits for a stop file if told to."""
    script = tmp_path / "monitor.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(sys.argv[1], "w") as f:
                json.dump({k: v for k, v in os.environ.items() if k.startswith("RS_")}, f)
            if os.environ.get("RS_TEST_PARK"):
                # As the monitor parks for an operator.
                with open(os.environ["RS_PARKED_FILE"], "w") as f:
                    json.dump({"reason": "connect_failed", "operator": True,
                               "error": os.environ["RS_TEST_PARK"]}, f)
            stop = os.environ.get("RS_TEST_STOP_FILE")
            if stop:
                while not os.path.exists(stop):
                    time.sleep(0.05)
                sys.exit(int(open(stop).read().strip() or "0"))
            sys.exit(int(os.environ.get("RS_TEST_EXIT", "0")))
            """
        )
    )
    return script


def monitor_cmd(tmp_path: Path) -> str:
    return f"{sys.executable} {monitor_script(tmp_path)} {tmp_path / 'monitor-env.json'}"


# ---------------------------------------------------------------------------
# the old way
# ---------------------------------------------------------------------------
def test_without_the_fleet_variables_the_command_is_execd_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ExecCalledError(Exception):
        pass

    execs: List[Any] = []

    def execvp(file: str, args: List[str]) -> None:
        execs.append((file, args))
        raise ExecCalledError()  # the real one never returns

    monkeypatch.setattr(entry.os, "execvp", execvp)
    argv = ["/usr/bin/supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
    with pytest.raises(ExecCalledError):
        entry.main(argv, {"PATH": "/usr/bin"})
    # Two of three is still not fleet mode.
    with pytest.raises(ExecCalledError):
        entry.main(argv, {"RS_FLEET_URL": "http://x", "RS_FLEET_HOST_ID": "lab"})
    assert execs == [("/usr/bin/supervisord", argv)] * 2


def test_the_old_way_really_execs(tmp_path: Path) -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("RS_FLEET_")}
    done = subprocess.run(
        [sys.executable, "-m", "rs_worker.entry", "/bin/sh", "-c", "echo old-way; exit 3"],
        cwd=TRACKER_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert done.returncode == 3
    assert done.stdout.strip() == "old-way"
    assert "rs_worker" not in done.stderr


def test_without_a_command_or_a_worker_id_it_is_a_configuration_failure(
    fleet: FakeFleet,
) -> None:
    assert entry.main([], {"PATH": "/usr/bin"}) == entry.EXIT_CONFIG
    env = fleet_env(fleet)
    env.pop("RS_FLEET_WORKER_ID")
    assert entry.run_fleet([], env) == entry.EXIT_CONFIG
    assert fleet.requests == []


# ---------------------------------------------------------------------------
# fleet mode
# ---------------------------------------------------------------------------
def test_a_claim_renders_the_worker_and_runs_the_monitor(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path))
    assert fleet.env is not None

    assert entry.run_fleet([], env, home=home) == 0

    method, path, body, headers = fleet.requests[0]
    assert (method, path) == ("POST", "/api/fleet/worker/claim")
    assert headers["authorization"] == f"Bearer {HOST_TOKEN}"
    assert isinstance(body.pop("claim_id"), str)
    assert body == {"host_id": "lab", "worker_id": "lab-1", "version": "0.14.0", "vnc_port": 5903}
    # Cloudflare's Browser Integrity Check refuses "Python-urllib/x.y" with a 403.
    assert headers["user-agent"] == "rs-worker/0.14.0"

    config = tomllib.loads((home / "config.toml").read_text())
    assert config["fleet"].pop("token_path") == str(home / "fleet-token")
    assert config["fleet"].pop("fence_path") == str(home / "fenced")
    assert config["fleet"] == {
        "url": fleet.url,
        "worker_token": mint_token("lab-1", 12, 7, exp=json.loads(
            __import__("base64").urlsafe_b64decode(
                config["fleet"]["worker_token"].split(".")[0] + "=="
            )
        )["exp"]),
        "epoch": 7,
        "worker_id": "lab-1",
        "poll_hold_seconds": 2,
        "alerts": False,
    }
    assert config["monitor"] == {
        "storage_state_path": str(home / "session.json"),
        "proxy_server": "http://proxy.invalid:10007",
        "proxy_username": "proxy-user",
        "proxy_password": "proxy-pass",
    }
    facebook = config["marketplace"]["facebook"]
    assert facebook["worker_id"] == "lab-1"
    assert facebook["control_plane_url"] == "http://coordinator.invalid:8500"
    assert facebook["control_plane_token"] == "${RS_CONTROL_PLANE_TOKEN}"
    assert facebook["username"] == ACCOUNT["uid"]
    assert facebook["password"] == "${RS_FB_PASSWORD}"
    assert facebook["search_city"] == ["nyc", "philly"]
    # Search settings from the claim land verbatim beside the template's.
    assert facebook["max_results"] == 120 and facebook["delivery_method"] == "local_pick_up"
    assert facebook["prompt"].startswith("You are a purchasing agent")
    assert config["item"]["server_ram"] == {
        "keywords": ["ram OR memory"],
        "antikeywords": ["single stick"],
        "description": "Bulk lots of DDR4/DDR5 memory.",
        "search_phrases": ["server ram memory ddr4 ddr5 ecc"],
    }
    assert config["item"]["enterprise_ssd"] == {"search_phrases": ["ssd lot server ssd"]}
    # Alerts are off unless the claim's env turns them on.
    assert not {k for k in config["user"]["recycle"] if k.startswith(("telegram_", "alert_report_"))}

    session = json.loads((home / "session.json").read_text())
    assert session == {"cookies": ACCOUNT["cookies"], "origins": []}
    identity = json.loads((home / "identity.json").read_text())
    assert identity["device"] == {
        "device_id": "pool-12",
        "fb_uid": ACCOUNT["uid"],
        "user_agent": fleet_device()["user_agent"],
        "locale": "en-US",
        "timezone_id": "America/New_York",
        "viewport": {"width": 1366, "height": 768},
        "screen": {"width": 1366, "height": 768},
    }
    assert [c["name"] for c in identity["device_cookies"]] == ["datr"]
    sidecar = json.loads((home / "session.json.meta.json").read_text())
    assert sidecar["user_agent"] == fleet_device()["user_agent"]
    assert sidecar["proxy"] == "http://proxy.invalid:10007"
    for name in ("config.toml", "session.json", "session.json.meta.json", "identity.json", "fleet-token"):
        assert stat.S_IMODE((home / name).stat().st_mode) == 0o600

    monitor_env = json.loads((tmp_path / "monitor-env.json").read_text())
    assert monitor_env["RS_FB_PASSWORD"] == ACCOUNT["password"]
    assert monitor_env["RS_FB_TOTP"] == ACCOUNT["totp_secret"]
    assert monitor_env["RS_WORKER_ID"] == "lab-1" and monitor_env["RS_HOST_ID"] == "lab"
    assert monitor_env["RS_CONTROL_PLANE_TOKEN"] == "made-up-control-plane-token"
    assert monitor_env["RS_PARKED_FILE"] == str(home / "parked.json")


def fleet_device() -> Dict[str, Any]:
    from .fake_fleet import DEVICE

    return DEVICE


def test_the_rendered_config_loads_in_the_monitor(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real loader, from the monitor's own package: what the worker boots on."""
    from ai_marketplace_monitor.config import Config

    home = tmp_path / "home"
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path))
    assert entry.run_fleet([], env, home=home) == 0
    for name in ("OPENROUTER_API_KEY", "RS_CONTROL_PLANE_TOKEN", "RS_FB_PASSWORD"):
        monkeypatch.setenv(name, f"made-up-{name.lower()}")
    monkeypatch.setenv("TELEGRAM_TOKEN", "123456789:made-up-bot-token")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-1001234567890")
    config = Config([home / "config.toml"])
    assert config.fleet is not None and config.fleet.epoch == 7
    assert config.fleet.poll_hold_seconds == 2
    facebook = config.marketplace["facebook"]
    assert facebook.control_plane_url == "http://coordinator.invalid:8500"
    assert facebook.control_plane_token == "made-up-rs_control_plane_token"
    assert facebook.worker_id == "lab-1"
    assert facebook.password == "made-up-rs_fb_password"
    assert config.monitor.proxy_server == ["http://proxy.invalid:10007"]
    assert config.monitor.storage_state_path == str(home / "session.json")
    assert config.item["server_ram"].search_phrases == ["server ram memory ddr4 ddr5 ecc"]
    assert config.item["server_ram"].keywords == ["ram OR memory"]
    assert set(config.item) == {"server_ram", "enterprise_ssd"}


def test_healthz_answers_while_the_monitor_runs_and_its_exit_code_is_kept(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    stop = tmp_path / "stop"
    env = fleet_env(
        fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path), RS_TEST_STOP_FILE=str(stop)
    )
    port = env["RS_WORKER_HEALTHZ_PORT"]
    result: List[int] = []
    thread = threading.Thread(
        target=lambda: result.append(entry.run_fleet([], env, home=tmp_path / "home"))
    )
    thread.start()
    try:
        body = wait_for_healthz(port)
        assert body["ok"] is True and body["worker_id"] == "lab-1" and body["epoch"] == 7
        assert body["monitor_pid"] > 0
        with pytest.raises(urllib.error.HTTPError) as not_found:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/other", timeout=2)
        assert not_found.value.code == 404
    finally:
        # The monitor leaves with the stale-epoch code: the agent restarts it.
        stop.write_text(str(entry.EXIT_RESTART))
        thread.join(timeout=15)
    assert result == [75]
    with pytest.raises((urllib.error.URLError, ConnectionError)):
        urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1)


def wait_for_healthz(port: str, timeout: float = 10.0) -> Dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            last = e
            time.sleep(0.05)
    raise AssertionError(f"/healthz never answered: {last}")


def test_a_monitor_that_fails_passes_its_exit_code_on(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path), RS_TEST_EXIT="3")
    assert entry.run_fleet([], env, home=tmp_path / "home") == 3


def test_no_slot_exits_75_at_once(fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fleet.claim_answer = "no_slot"
    slept: List[float] = []
    monkeypatch.setattr(entry.time, "sleep", lambda s: slept.append(s))
    assert entry.run_fleet([], fleet_env(fleet), home=tmp_path / "home") == 75
    assert len(fleet.requests) == 1 and slept == []
    assert not (tmp_path / "home").exists()


def test_other_claim_failures_retry_three_times_then_exit_70(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fleet.claim_answer = "error"
    slept: List[float] = []
    monkeypatch.setattr(entry.time, "sleep", lambda s: slept.append(s))
    assert entry.run_fleet([], fleet_env(fleet), home=tmp_path / "home") == 70
    assert len(fleet.requests) == 3 and slept == [10, 10]
    # A fleet that is not there at all ends the same way.
    env = fleet_env(fleet, RS_FLEET_URL=f"http://127.0.0.1:{free_port()}")
    slept.clear()
    assert entry.run_fleet([], env, home=tmp_path / "home") == 70
    assert slept == [10, 10]
    # So does a host token the fleet refuses.
    fleet.claim_answer = "ok"
    slept.clear()
    assert entry.run_fleet([], fleet_env(fleet, RS_FLEET_HOST_TOKEN="wrong"), home=tmp_path / "home") == 70
    assert slept == [10, 10]


def test_a_claim_ticket_is_what_it_claims_with_and_never_reaches_the_monitor(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    ticket = fleet.mint_ticket("lab-1")
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path), RS_FLEET_CLAIM_TICKET=ticket)
    # The agent passes the ticket under the host token's name too, for older images.
    env["RS_FLEET_HOST_TOKEN"] = ticket
    assert entry.run_fleet([], env, home=tmp_path / "home") == 0
    _, path, body, headers = fleet.requests[0]
    assert path == "/api/fleet/worker/claim"
    assert headers["authorization"] == f"Bearer {ticket}"
    assert fleet.tickets[ticket]["claim_id"] == body["claim_id"]
    menv = entry.monitor_env(env, entry.claim(fleet.url, "lab", HOST_TOKEN, "lab-1", "0.14.0", 5903, sleep=lambda s: None), "lab", "lab-1")
    assert not any(k.startswith("RS_FLEET_") for k in menv)
    assert ticket not in json.dumps(menv)


def test_the_ticket_wins_over_a_host_token_and_fleet_mode_needs_only_one_of_them(fleet: FakeFleet) -> None:
    ticket = fleet.mint_ticket("lab-1")
    both = fleet_env(fleet, RS_FLEET_CLAIM_TICKET=ticket)
    assert entry.fleet_credential(both) == ticket
    only_ticket = {k: v for k, v in both.items() if k != "RS_FLEET_HOST_TOKEN"}
    assert entry.fleet_mode(only_ticket) and entry.fleet_credential(only_ticket) == ticket
    # An agent from before the tickets: the host token, as it always was.
    old = fleet_env(fleet)
    assert entry.fleet_mode(old) and entry.fleet_credential(old) == HOST_TOKEN
    neither = {k: v for k, v in old.items() if k != "RS_FLEET_HOST_TOKEN"}
    assert not entry.fleet_mode(neither)


def test_a_refused_ticket_exits_75_at_once_so_the_agent_runs_a_fresh_container(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    slept: List[float] = []
    monkeypatch.setattr(entry.time, "sleep", lambda s: slept.append(s))
    ticket = fleet.mint_ticket("lab-1")
    fleet.tickets[ticket]["claim_id"] = "an-earlier-boot"
    env = {k: v for k, v in fleet_env(fleet, RS_FLEET_CLAIM_TICKET=ticket).items() if k != "RS_FLEET_HOST_TOKEN"}
    assert entry.run_fleet([], env, home=tmp_path / "home") == 75
    assert len(fleet.requests) == 1 and slept == []
    # The same ticket under the old name (an older entrypoint reads only that) is refused the same way.
    assert entry.run_fleet([], fleet_env(fleet, RS_FLEET_HOST_TOKEN=ticket), home=tmp_path / "home") == 75
    assert not (tmp_path / "home").exists()


def test_a_transient_failure_retries_the_ticket_claim_as_the_same_boot(fleet: FakeFleet) -> None:
    ticket = fleet.mint_ticket("lab-1")
    fleet.claim_answer = "error"
    calls: List[float] = []

    def recover(seconds: float) -> None:
        calls.append(seconds)
        fleet.claim_answer = "ok"

    answer = entry.claim(fleet.url, "lab", ticket, "lab-1", "0.14.5", 5903, sleep=recover)
    assert answer["epoch"] == fleet.epoch and calls == [10]
    first, second = (r[2]["claim_id"] for r in fleet.requests)
    assert first == second == fleet.tickets[ticket]["claim_id"]


# ---------------------------------------------------------------------------
# pieces
# ---------------------------------------------------------------------------
def test_toml_dumps_round_trips_through_tomllib() -> None:
    data = {
        "top": 1,
        "monitor": {"storage_state_path": "/root/x.json", "proxy_server": "http://p:1", "none": None},
        "marketplace": {
            "facebook": {
                "date_listed": ["last 7 days", "last 7 days"],
                "title_prefilter": True,
                "min_seller_rating": 4.5,
                "prompt": 'Line one "quoted"\nLine two \\ backslash\ttab · unicode',
                "radius": [60, 100],
            }
        },
        "item": {"server ram": {"search_phrases": ["a", "b"], "nested": {"k": "v"}}},
        "fleet": {"epoch": 7, "poll_hold_seconds": 50},
    }
    text = entry.toml_dumps(data)
    parsed = tomllib.loads(text)
    data["monitor"].pop("none")
    assert parsed == data
    assert '["server ram"]' in text or '[item."server ram"]' in text


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        (
            "http://user:p%40ss@proxy.invalid:10007",
            {"proxy_server": "http://proxy.invalid:10007", "proxy_username": "user",
             "proxy_password": "p@ss"},
        ),
        ("http://proxy.invalid:10007", {"proxy_server": "http://proxy.invalid:10007"}),
        ("socks5://u:p@10.0.0.1:1080", {"proxy_server": "socks5://10.0.0.1:1080",
                                        "proxy_username": "u", "proxy_password": "p"}),
    ],
)
def test_split_proxy(url: str, expected: Dict[str, str]) -> None:
    assert entry.split_proxy(url) == expected


def test_the_fake_fleet_refuses_a_stale_epoch(fleet: FakeFleet) -> None:
    """The behaviour the monitor's fleet tests rely on, checked once here."""
    import rs_worker.tests.fake_fleet as fake

    answer = json.loads(
        urllib.request.urlopen(
            urllib.request.Request(
                f"{fleet.url}/api/fleet/worker/claim",
                data=json.dumps({"host_id": "lab", "worker_id": "lab-1"}).encode(),
                headers={"Authorization": f"Bearer {fake.HOST_TOKEN}",
                         "Content-Type": "application/json"},
                method="POST",
            ),
            timeout=5,
        ).read()
    )
    token = answer["worker_token"]

    def post(path: str, body: Dict[str, Any]) -> int:
        request = urllib.request.Request(
            f"{fleet.url}{path}",
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            assert json.loads(e.read())["error"] == "stale_epoch"
            return e.code

    assert post("/api/fleet/worker/heartbeat", {"state": "HEALTHY"}) == 200
    task = fleet.add_task()
    held = json.loads(
        urllib.request.urlopen(
            urllib.request.Request(
                f"{fleet.url}/api/fleet/worker/next-task",
                data=json.dumps({"done": None, "wait": 1}).encode(),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                method="POST",
            ),
            timeout=5,
        ).read()
    )
    assert held["task"]["id"] == task["id"]
    fleet.bump_epoch()
    assert post("/api/fleet/worker/heartbeat", {"state": "HEALTHY"}) == 409
    assert post("/api/fleet/worker/next-task", {"done": None, "wait": 0}) == 409


def test_docker_stop_ends_the_worker_as_soon_as_the_monitor_has_gone(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    # The real process, as tini runs it: SIGTERM to the entrypoint only.
    script = tmp_path / "monitor.py"
    script.write_text(
        textwrap.dedent(
            """
            import signal, sys, time
            signal.signal(signal.SIGTERM, signal.default_int_handler)
            open(sys.argv[1], "w").close()
            try:
                while True:
                    time.sleep(0.05)
            except KeyboardInterrupt:
                time.sleep(0.3)  # hands back its result, saves its session
                sys.exit(0)
            """
        )
    )
    ready = tmp_path / "ready"
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=f"{sys.executable} {script} {ready}")
    # No Xvfb from this host's PATH; HOME keeps the rendered files in tmp.
    env["PATH"] = str(Path(sys.executable).parent)
    env["HOME"] = str(tmp_path)
    env["PYTHONPATH"] = str(TRACKER_ROOT)
    proc = subprocess.Popen([sys.executable, "-m", "rs_worker.entry"], env=env, cwd=tmp_path)
    try:
        wait_for_healthz(env["RS_WORKER_HEALTHZ_PORT"])
        for _ in range(100):
            if ready.exists():
                break
            time.sleep(0.05)
        started = time.monotonic()
        proc.terminate()
        code = proc.wait(timeout=entry.MONITOR_STOP_GRACE_S + entry.DISPLAY_STOP_GRACE_S)
        elapsed = time.monotonic() - started
    finally:
        if proc.poll() is None:
            proc.kill()
    assert code == 0
    # Not the kill timer's 24 s: nothing is left waiting once the monitor exits.
    assert elapsed < 5, elapsed
    grace = entry.MONITOR_STOP_GRACE_S + entry.DISPLAY_STOP_GRACE_S + entry.RELAY_STOP_GRACE_S
    assert grace < 30  # docker stop -t 30


def test_the_display_is_stopped_together_within_its_grace(tmp_path: Path) -> None:
    stubborn = [
        subprocess.Popen(
            [sys.executable, "-c",
             "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"]
        )
        for _ in range(2)
    ]
    time.sleep(0.2)
    started = time.monotonic()
    entry.stop_all(stubborn, 0.5)
    # One shared grace, not one per process.
    assert time.monotonic() - started < 2
    assert all(p.poll() is not None for p in stubborn)


def test_the_vnc_relay_runs_beside_the_monitor_with_the_worker_token(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from rs_worker import vnc_relay

    made: List[Dict[str, Any]] = []

    class Recorder:
        def __init__(self, fleet_url: str, token: str, addr: Any, **_: Any) -> None:
            made.append({"url": fleet_url, "token": token, "addr": addr, "calls": []})

        def start(self) -> "Recorder":
            made[-1]["calls"].append("start")
            return self

        def request_stop(self) -> None:
            made[-1]["calls"].append("request_stop")

        def stop(self, timeout: float = 1.0) -> None:
            made[-1]["calls"].append("stop")

    monkeypatch.setattr(vnc_relay, "VncRelay", Recorder)
    # An image with x11vnc (and, here, no Xvfb to start).
    monkeypatch.setattr(
        entry.shutil, "which", lambda name: "/usr/bin/x11vnc" if name == "x11vnc" else None
    )
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path))
    assert entry.run_fleet([], env, home=tmp_path / "home") == 0
    assert len(made) == 1
    assert made[0]["url"] == fleet.url + "/" and made[0]["addr"] == ("127.0.0.1", 5900)
    claims = read_token(made[0]["token"])
    assert claims is not None and claims["worker_id"] == "lab-1" and claims["epoch"] == fleet.epoch
    assert made[0]["calls"] == ["start", "stop"]


def test_without_a_vnc_server_there_is_no_relay(fleet: FakeFleet, tmp_path: Path) -> None:
    assert entry.start_vnc_relay(fleet.url, "token", {}) is None


# ---------------------------------------------------------------------------
# the claim's env, and a fleet without a coordinator
# ---------------------------------------------------------------------------
def test_the_claims_env_reaches_the_monitor_and_its_values_are_never_logged(
    fleet: FakeFleet, tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    assert fleet.env is not None
    fleet.env.update(
        {
            "RS_ALERTS": "on",
            # The fleet-wide legacy token: never taken from the claim.
            "RS_COORDINATOR_TOKEN": "made-up-coordinator-token",  # pragma: allowlist secret
            # Not the claim's to set: the password comes from the account.
            "RS_FB_PASSWORD": "made-up-hijack",  # pragma: allowlist secret
            "RS_FLEET_URL": "http://elsewhere.invalid",
            # Nothing the template reads: it would reach every process.
            "LD_PRELOAD": "/tmp/made-up.so",
            "HTTPS_PROXY": "http://made-up.invalid:3128",
            "TELEGRAM_TOPIC_HIGH": 5,
            "bad name": "x",
        }
    )
    home = tmp_path / "home"
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path))
    assert entry.run_fleet([], env, home=home) == 0

    seen = json.loads((tmp_path / "monitor-env.json").read_text())
    # The worker's own token from the map, not the legacy one.
    assert seen["RS_COORDINATOR_TOKEN"] == "made-up-control-plane-token"
    assert seen["RS_FB_PASSWORD"] == ACCOUNT["password"]
    assert "LD_PRELOAD" not in seen and "HTTPS_PROXY" not in seen
    # No fleet variable reaches the monitor: the host token claims any account.
    assert not [k for k in seen if k.startswith("RS_FLEET_")]
    config = tomllib.loads((home / "config.toml").read_text())
    # Kept, since the claim's env resolves them.
    assert config["ai"]["openrouter"]["api_key"] == "${OPENROUTER_API_KEY}"
    assert config["user"]["recycle"]["telegram_token"] == "${TELEGRAM_TOKEN}"
    assert config["user"]["recycle"]["alert_report_token"] == "${RS_COORDINATOR_TOKEN}"
    # The integer topic was refused, so its reference is left out.
    assert "telegram_topic_high" not in config["user"]["recycle"]

    logged = capfd.readouterr().err
    assert "claim env: OPENROUTER_API_KEY, RS_ALERTS, RS_CONTROL_PLANE_TOKENS, TELEGRAM_CHAT_ID, TELEGRAM_TOKEN" in logged
    assert "HTTPS_PROXY, LD_PRELOAD, RS_COORDINATOR_TOKEN, RS_FB_PASSWORD, RS_FLEET_URL, TELEGRAM_TOPIC_HIGH, bad name" in logged
    for value in ("made-up-openrouter-key", "made-up-bot-token", "made-up-coordinator-token",
                  "made-up-hijack", ACCOUNT["password"]):
        assert value not in logged


def test_every_reference_in_the_template_resolves_from_the_claim_and_the_fleet_vars(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    """With the full shared env, nothing the template references is left unset."""
    assert fleet.env is not None
    fleet.env.update(
        {
            name: f"made-up-{name.lower()}"
            for name in ("RS_ALERT_REPORT_URL",)
        }
    )
    fleet.env.update({"TELEGRAM_TOPIC_HIGH": "11", "TELEGRAM_TOPIC_MEDIUM": "12", "TELEGRAM_TOPIC_LOW": "13"})
    with open(entry.TEMPLATE, "rb") as f:
        template = tomllib.load(f)
    answer = entry.claim(fleet.url, "lab", HOST_TOKEN, "lab-1", "0.14.0", 5903, sleep=lambda s: None)
    menv = entry.monitor_env({"PATH": "/usr/bin"}, answer, "lab", "lab-1", tmp_path)
    config = entry.render_config(template, answer, fleet.url, "lab-1", tmp_path, alerts=True)
    assert entry.resolve_env_refs(config, menv) == []
    assert entry.required_env(template) == ["OPENROUTER_API_KEY"]


def test_without_a_coordinator_nothing_of_it_is_rendered_and_the_monitor_accepts_it(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ai_marketplace_monitor.config import Config
    from ai_marketplace_monitor.facebook import FacebookMarketplace

    fleet.settings["coordinator_url"] = ""
    # Only the AI key: Telegram and the coordinator's tokens are optional.
    fleet.env = {"OPENROUTER_API_KEY": "made-up-openrouter-key"}  # pragma: allowlist secret
    home = tmp_path / "home"
    env = fleet_env(
        fleet,
        RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path),
        # A stray fallback in the container must not bring a coordinator back.
        RS_CONTROL_PLANE_URL="http://coordinator.invalid:8500",
        RS_CONTROL_PLANE_TOKEN="made-up-control-plane-token",  # pragma: allowlist secret
    )
    assert entry.run_fleet([], env, home=home) == 0

    seen = json.loads((tmp_path / "monitor-env.json").read_text())
    assert "RS_CONTROL_PLANE_URL" not in seen
    config = tomllib.loads((home / "config.toml").read_text())
    facebook = config["marketplace"]["facebook"]
    assert not {"control_plane_url", "control_plane_token"} & set(facebook)
    user = config["user"]["recycle"]
    assert not {"alert_report_url", "alert_report_token", "alert_report_worker_id"} & set(user)
    assert not {k for k in user if k.startswith("telegram_")}
    assert config["ai"]["openrouter"]["api_key"] == "${OPENROUTER_API_KEY}"

    for name, value in seen.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("OPENROUTER_API_KEY", "made-up-openrouter-key")
    monkeypatch.delenv("RS_CONTROL_PLANE_URL", raising=False)
    loaded = Config([home / "config.toml"])
    assert loaded.fleet is not None
    assert loaded.marketplace["facebook"].control_plane_url is None
    assert loaded.user["recycle"].telegram_token is None
    market = FacebookMarketplace("facebook", None)
    market.configure(loaded.marketplace["facebook"])
    assert market.control_plane is None


def test_an_account_with_no_home_city_renders_a_config_the_monitor_accepts(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ai_marketplace_monitor.config import Config

    fleet.home_cities = []
    home = tmp_path / "home"
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path))
    assert entry.run_fleet([], env, home=home) == 0

    facebook = tomllib.loads((home / "config.toml").read_text())["marketplace"]["facebook"]
    assert "search_city" not in facebook and "currency" not in facebook

    seen = json.loads((tmp_path / "monitor-env.json").read_text())
    for name, value in seen.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("OPENROUTER_API_KEY", "made-up-openrouter-key")
    loaded = Config([home / "config.toml"])
    assert loaded.marketplace["facebook"].search_city is None


def test_no_ai_key_anywhere_is_a_configuration_failure_before_the_monitor(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    fleet.env = None
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path))
    assert entry.run_fleet([], env, home=tmp_path / "home") == entry.EXIT_CONFIG
    assert not (tmp_path / "monitor-env.json").exists()
    assert not (tmp_path / "home" / "config.toml").exists()


# ---------------------------------------------------------------------------
# parked for an operator
# ---------------------------------------------------------------------------
def test_a_parked_monitor_is_up_on_healthz_and_never_restarted_by_its_exit(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    stop = tmp_path / "stop"
    env = fleet_env(
        fleet,
        RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path),
        RS_TEST_STOP_FILE=str(stop),
        RS_TEST_PARK="net::ERR_PROXY_CONNECTION_FAILED",
    )
    port = env["RS_WORKER_HEALTHZ_PORT"]
    result: List[int] = []
    thread = threading.Thread(
        target=lambda: result.append(entry.run_fleet([], env, home=tmp_path / "home"))
    )
    thread.start()
    try:
        deadline = time.monotonic() + 10
        body = wait_for_healthz(port)
        while body.get("state") != "parked" and time.monotonic() < deadline:
            time.sleep(0.05)
            body = wait_for_healthz(port)
        # 200, so Docker calls it healthy and nothing replaces it.
        assert body["state"] == "parked" and body["ok"] is False
        assert body["parked"]["reason"] == "connect_failed" and body["parked"]["operator"] is True
    finally:
        # Gone with a crash code while parked: 78, which the agent leaves stopped.
        stop.write_text("1")
        thread.join(timeout=15)
    assert result == [entry.EXIT_OPERATOR] == [78]


def test_a_parked_monitor_stopped_by_docker_still_leaves_0(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    env = fleet_env(
        fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path), RS_TEST_PARK="timeout"
    )
    assert entry.run_fleet([], env, home=tmp_path / "home") == 0


def test_missing_coordinator_auth_fails_before_browser_start(fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fleet.env.pop('RS_CONTROL_PLANE_TOKENS', None)
    monkeypatch.delenv('RS_CONTROL_PLANE_TOKEN', raising=False)
    started = []
    monkeypatch.setattr(entry, 'run_monitor', lambda *args, **kwargs: started.append(True))
    assert entry.run_fleet([], fleet_env(fleet), home=tmp_path / 'home') == 70
    assert started == []


# ---------------------------------------------------------------------------
# alerts and the coordinator's per-worker tokens
# ---------------------------------------------------------------------------
TOKENS = {
    "lab-1": "lab-1.made-up-signature-one",  # pragma: allowlist secret
    "lab-2": "lab-2.made-up-signature-two",  # pragma: allowlist secret
}


def test_with_a_coordinator_alerts_stay_off_and_the_monitor_withholds_them(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ai_marketplace_monitor.config import Config

    home = tmp_path / "home"
    env = fleet_env(
        fleet,
        RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path),
        # Would turn the monitor's incident reports to the coordinator on.
        RS_CONTROL_PLANE_URL="http://coordinator.invalid:8500",
    )
    assert entry.run_fleet([], env, home=home) == 0

    seen = json.loads((tmp_path / "monitor-env.json").read_text())
    assert "RS_CONTROL_PLANE_URL" not in seen
    config = tomllib.loads((home / "config.toml").read_text())
    assert config["marketplace"]["facebook"]["control_plane_url"] == "http://coordinator.invalid:8500"
    assert config["fleet"]["alerts"] is False
    user = config["user"]["recycle"]
    assert not {k for k in user if k.startswith(("telegram_", "alert_report_"))}

    # TELEGRAM_* are in the claim's env, and still nothing can reach Telegram.
    for name, value in {**fleet.env, **seen}.items():
        monkeypatch.setenv(name, value)
    loaded = Config([home / "config.toml"])
    assert loaded.fleet is not None and loaded.fleet.alerts is False
    assert loaded.user["recycle"].telegram_token is None


def test_alerts_on_render_telegram_and_point_incidents_at_the_coordinator(
    fleet: FakeFleet, tmp_path: Path
) -> None:
    assert fleet.env is not None
    fleet.env["RS_ALERTS"] = "on"
    home = tmp_path / "home"
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path))
    assert entry.run_fleet([], env, home=home) == 0

    seen = json.loads((tmp_path / "monitor-env.json").read_text())
    assert seen["RS_CONTROL_PLANE_URL"] == "http://coordinator.invalid:8500"
    config = tomllib.loads((home / "config.toml").read_text())
    assert config["fleet"]["alerts"] is True
    assert config["user"]["recycle"]["telegram_token"] == "${TELEGRAM_TOKEN}"
    assert config["user"]["recycle"]["alert_report_worker_id"] == "lab-1"


def test_each_worker_takes_only_its_own_coordinator_token(
    fleet: FakeFleet, tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    assert fleet.env is not None
    fleet.env.pop("RS_CONTROL_PLANE_TOKENS")
    fleet.env["RS_CONTROL_PLANE_TOKENS"] = json.dumps(TOKENS)
    env = fleet_env(fleet, RS_WORKER_MONITOR_CMD=monitor_cmd(tmp_path))
    assert entry.run_fleet([], env, home=tmp_path / "home") == 0

    seen = json.loads((tmp_path / "monitor-env.json").read_text())
    assert seen["RS_CONTROL_PLANE_TOKEN"] == TOKENS["lab-1"]
    assert seen["RS_COORDINATOR_TOKEN"] == TOKENS["lab-1"]
    assert "RS_CONTROL_PLANE_TOKENS" not in seen
    assert TOKENS["lab-2"] not in json.dumps(seen)
    logged = capfd.readouterr().err
    assert all(token not in logged for token in TOKENS.values())


def test_a_worker_the_token_map_does_not_name_stops_before_the_browser(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert fleet.env is not None
    fleet.env.pop("RS_CONTROL_PLANE_TOKENS")
    fleet.env["RS_CONTROL_PLANE_TOKENS"] = json.dumps({"lab-2": TOKENS["lab-2"]})
    started: List[bool] = []
    monkeypatch.setattr(entry, "run_monitor", lambda *a, **k: started.append(True))
    assert entry.run_fleet([], fleet_env(fleet), home=tmp_path / "home") == entry.EXIT_CONFIG
    assert started == []


# ---------------------------------------------------------------------------
# review fixes: claim values, env precedence, what the container exposes
# ---------------------------------------------------------------------------
def test_claim_values_that_read_as_env_references_never_reach_the_config(
    fleet: FakeFleet, tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    answer = entry.claim(fleet.url, "lab", HOST_TOKEN, "lab-1", "0.14.0", 5903, sleep=lambda s: None)
    answer["items"][0]["phrases"] = ["server ram", "${RS_FB_PASSWORD}"]
    answer["items"][0]["filters"] = {"keywords": ["ram"], "description": "${OPENROUTER_API_KEY}"}
    answer["settings"]["search"]["currency"] = "${RS_FB_TOTP}"
    answer["home_cities"] = ["nyc", "${HOME}"]
    with open(entry.TEMPLATE, "rb") as f:
        template = tomllib.load(f)
    config = entry.render_config(template, answer, fleet.url, "lab-1", tmp_path)

    item = config["item"][answer["items"][0]["name"]]
    assert item["search_phrases"] == ["server ram"] and "description" not in item
    facebook = config["marketplace"]["facebook"]
    assert facebook["search_city"] == ["nyc"]
    # The template's own references are untouched.
    assert facebook["currency"] == "USD" and facebook["password"] == "${RS_FB_PASSWORD}"
    logged = capfd.readouterr().err
    assert "items.phrases[]" in logged and "settings.search.currency" in logged
    assert "RS_FB_PASSWORD}" not in logged.split("left out:")[-1]


def test_what_the_container_sets_wins_over_the_claims_env(fleet: FakeFleet) -> None:
    answer = entry.claim(fleet.url, "lab", HOST_TOKEN, "lab-1", "0.14.0", 5903, sleep=lambda s: None)
    answer["env"] = {"OPENROUTER_API_KEY": "from-the-claim", "TELEGRAM_CHAT_ID": "-100"}
    menv = entry.monitor_env(
        {"OPENROUTER_API_KEY": "from-the-container", "RS_FLEET_HOST_TOKEN": HOST_TOKEN},
        answer, "lab", "lab-1",
    )
    assert menv["OPENROUTER_API_KEY"] == "from-the-container"
    assert menv["TELEGRAM_CHAT_ID"] == "-100"
    assert "RS_FLEET_HOST_TOKEN" not in menv


def test_the_claims_env_may_set_only_what_the_template_reads() -> None:
    allowed = entry.claim_env_allowed()
    assert {"OPENROUTER_API_KEY", "TELEGRAM_TOKEN", "RS_ALERT_REPORT_URL", "RS_ALERTS",
            "RS_CONTROL_PLANE_TOKENS"} <= allowed
    assert not allowed & {"RS_CONTROL_PLANE_TOKEN", "RS_COORDINATOR_TOKEN", "RS_FB_PASSWORD",
                          "RS_FB_TOTP", "LD_PRELOAD", "PATH"}


def test_vnc_lets_in_loopback_and_the_bridge_gateway_only(tmp_path: Path) -> None:
    route = tmp_path / "route"
    route.write_text(
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
        "eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"
        "eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"
    )
    assert entry.default_gateway(str(route)) == "172.17.0.1"
    assert entry.vnc_allow_args(str(route)) == ["-allow", "127.0.0.1,172.17.0.1"]
    assert entry.vnc_allow_args(str(tmp_path / "missing")) == []


def test_in_fleet_mode_the_web_ui_listens_on_loopback_only() -> None:
    env = {"AIMM_WEBUI_HOST": "0.0.0.0", "AIMM_WEBUI_PORT": "8467"}
    assert entry.monitor_command(env, fleet=True)[3] == "127.0.0.1"
    assert entry.monitor_command(env)[3] == "0.0.0.0"  # the homelab compose files


def claim_with(device: Dict[str, Any]) -> Dict[str, Any]:
    return {"account": ACCOUNT, "device": device, "worker_token": "t"}


def test_a_moved_homelab_device_keeps_its_screen_and_scale() -> None:
    """A homelab browser reports a screen taller than its viewport, at its own scale."""
    device = {**fleet_device(), "viewport": [1536, 731], "screen": [1536, 864],
              "device_scale_factor": 1.25, "timezone": "America/Los_Angeles"}
    profile = entry.identity_for(claim_with(device))["device"]
    assert profile["viewport"] == {"width": 1536, "height": 731}
    assert profile["screen"] == {"width": 1536, "height": 864}
    assert profile["device_scale_factor"] == 1.25
    assert profile["timezone_id"] == "America/Los_Angeles"


def test_native_fields_are_left_to_the_browser(tmp_path: Path) -> None:
    """The backend fills a default user agent in; `native` says the browser had its own."""
    device = {**fleet_device(), "viewport": [1280, 720], "native": ["user_agent", "locale", "timezone"]}
    entry.write_files(tmp_path, claim_with(device), {"monitor": {}})
    profile = json.loads((tmp_path / "identity.json").read_text())["device"]
    assert not {"user_agent", "locale", "timezone_id"} & set(profile)
    assert profile["screen"] == {"width": 1280, "height": 720}
    # The monitor falls back to the sidecar's user agent; that must be empty too.
    assert json.loads((tmp_path / "session.json.meta.json").read_text())["user_agent"] is None


def test_the_monitor_presents_every_exported_field(tmp_path: Path) -> None:
    """Through the monitor's own `context_options`: what reaches Playwright's new_context."""
    from ai_marketplace_monitor.identity import context_options

    device = {"user_agent": "UA", "viewport": [1600, 789], "screen": [1600, 900],
              "device_scale_factor": 1.25, "timezone": "America/New_York", "locale": "en-US",
              "native": ["user_agent"]}
    entry.write_files(tmp_path, claim_with(device), {"monitor": {}})
    options = context_options(json.loads((tmp_path / "identity.json").read_text()))
    assert options == {
        "viewport": {"width": 1600, "height": 789},
        "screen": {"width": 1600, "height": 900},
        "device_scale_factor": 1.25,
        "locale": "en-US",
        "timezone_id": "America/New_York",
    }


def test_full_storage_state_reaches_the_browser_file_unchanged(tmp_path: Path) -> None:
    answer = claim_with(fleet_device())
    state = {
        "cookies": answer["account"]["cookies"],
        "origins": [{"origin": "https://www.facebook.com",
                     "localStorage": [{"name": "device", "value": "made-up"}],
                     "indexedDB": [{"name": "client", "version": 1,
                                    "stores": [{"name": "keys", "records": [{"value": {"id": 1}}]}]}]}],
    }
    answer["account"] = {**answer["account"], "storage_state": state}
    entry.write_files(tmp_path, answer, {"monitor": {}})
    assert json.loads((tmp_path / "session.json").read_text()) == state
    assert stat.S_IMODE((tmp_path / "session.json").stat().st_mode) == 0o600
    answer["account"]["storage_state"] = {**state, "cookies": []}
    with pytest.raises(ValueError, match="storage state"):
        entry.write_files(tmp_path, answer, {"monitor": {}})
    assert json.loads((tmp_path / "session.json").read_text()) == state
