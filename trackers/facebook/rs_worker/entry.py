"""The worker image's entrypoint: the old command as it was, or fleet mode.

Without `RS_FLEET_URL`, `RS_FLEET_HOST_ID` and `RS_FLEET_HOST_TOKEN` this
execs the image's command (supervisord with the bind-mounted config) and is
not there at all. With them it:

1. claims an account from the ERP's fleet (`POST /api/fleet/worker/claim`
   with the host token): a slot, its sealed credentials, proxy, device, the
   items to search and a worker token for the slot's epoch;
2. renders the monitor's `config.toml`, the Playwright `session.json` and
   the device's `identity.json` inside the container, never on a mount;
3. exports `RS_FB_PASSWORD` / `RS_FB_TOTP` for the monitor's password
   fallback, used only when the cookie session is invalid, as today;
4. runs the virtual display, VNC and the monitor, serving `GET /healthz` on
   8788 while the monitor is up, and leaves with the monitor's exit code;
5. keeps a socket parked at the ERP's VNC relay (`vnc_relay.py`), so a
   manager can watch the browser with no port open on this host.

Exit codes, as the host agent reads them: 75 for "no slot" or a stale epoch
(the agent starts a fresh container after a minute), 70 for a claim or
configuration failure (the agent backs off ten minutes), otherwise the
monitor's own code (0 on `docker stop`).

stdlib only: four requests and a TOML writer are not worth a dependency, and
this runs before anything else in the image is known to work. The relay
alone uses `websockets`, which the monitor's web UI already installs, and is
imported only in fleet mode. Secrets from
the claim are written with mode 0600 and never logged.
"""

from __future__ import annotations

import copy
import http.server
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Sequence

import tomllib

FLEET_ENV = ("RS_FLEET_URL", "RS_FLEET_HOST_ID", "RS_FLEET_HOST_TOKEN")

# The host agent's reading of how a worker left. The same 75 is in the
# monitor's control_plane.py (`STALE_EPOCH_EXIT_CODE`); the two cannot share
# a module.
EXIT_RESTART = 75
EXIT_CONFIG = 70

HEALTHZ_PORT = 8788
CLAIM_ATTEMPTS = 3
CLAIM_RETRY_S = 10
# The agent stops a worker with `docker stop -t 30`. The monitor gets 24 s
# to hand back its last result and save its session, the display 3 s after
# it, which leaves a margin before Docker's SIGKILL.
MONITOR_STOP_GRACE_S = 24
DISPLAY_STOP_GRACE_S = 3
# The relay is told to stop with the monitor; this is only its last join.
RELAY_STOP_GRACE_S = 1

TEMPLATE = Path(__file__).with_name("config.template.toml")
# Which of the account's cookies name the browser rather than the login.
DEVICE_COOKIES = ("datr", "sb")


def log(message: str) -> None:
    sys.stderr.write(f"rs_worker: {message}\n")
    sys.stderr.flush()


class ClaimFailedError(Exception):
    """The claim did not produce a slot; `code` is how the process should leave."""

    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code


# ---------------------------------------------------------------------------
# claim
# ---------------------------------------------------------------------------
def claim(
    fleet_url: str,
    host_id: str,
    host_token: str,
    worker_id: str,
    version: str,
    vnc_port: int,
    sleep: Callable[[float], None] | None = None,
) -> Dict[str, Any]:
    """Claim a slot: the fleet's answer, or `ClaimFailedError` with the exit code.

    `409 no_slot` is an answer (every account is taken) and leaves at once
    with 75; anything else is retried `CLAIM_ATTEMPTS` times, 10 s apart,
    and then leaves with 70.
    """
    sleep = sleep or time.sleep
    url = f"{fleet_url.rstrip('/')}/api/fleet/worker/claim"
    body = json.dumps(
        {"host_id": host_id, "worker_id": worker_id, "version": version, "vnc_port": vnc_port}
    ).encode("utf-8")
    last = "no answer"
    for attempt in range(1, CLAIM_ATTEMPTS + 1):
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Authorization": f"Bearer {host_token}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                answer = json.loads(response.read().decode("utf-8"))
            if not isinstance(answer, dict) or not _usable_claim(answer):
                raise ValueError("the claim answer lacks a token, an epoch or an account")
            return answer
        except urllib.error.HTTPError as e:
            error = _error_code(e)
            if e.code == 409 and error == "no_slot":
                raise ClaimFailedError(EXIT_RESTART, "no free slot") from None
            last = f"HTTP {e.code} {error or ''}".rstrip()
        except (urllib.error.URLError, OSError, ValueError) as e:
            last = str(e)
        log(f"claim attempt {attempt}/{CLAIM_ATTEMPTS} failed: {last}")
        if attempt < CLAIM_ATTEMPTS:
            sleep(CLAIM_RETRY_S)
    raise ClaimFailedError(EXIT_CONFIG, f"claim failed: {last}")


def _usable_claim(answer: Dict[str, Any]) -> bool:
    account = answer.get("account")
    return (
        bool(answer.get("worker_token"))
        and isinstance(answer.get("epoch"), int)
        and isinstance(account, dict)
        and account.get("no") is not None
    )


def _error_code(error: urllib.error.HTTPError) -> str | None:
    try:
        parsed = json.loads(error.read().decode("utf-8", errors="replace"))
    except (OSError, ValueError, AttributeError):
        return None
    return parsed.get("error") if isinstance(parsed, dict) else None


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------
def split_proxy(url: str) -> Dict[str, str]:
    """`scheme://user:pass@host:port` as the monitor's three proxy keys."""
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    server = f"{parsed.scheme}://{host}" + (f":{parsed.port}" if parsed.port else "")
    out = {"proxy_server": server}
    if parsed.username:
        out["proxy_username"] = urllib.parse.unquote(parsed.username)
        out["proxy_password"] = urllib.parse.unquote(parsed.password or "")
    return out


def render_config(
    template: Dict[str, Any], answer: Dict[str, Any], fleet_url: str, worker_id: str, home: Path
) -> Dict[str, Any]:
    """The template with the claim answer merged in.

    The template carries what every fleet worker shares (the AI backend, the
    buying prompt, the notification channel, `${VAR}` references the monitor
    expands from the container's environment). The claim supplies what is
    this slot's: proxy, items, search settings, home cities, the coordinator
    the listings go to, and the `[fleet]` table that puts the monitor in
    fleet mode. Search-setting and item-filter keys are copied verbatim, so
    the ERP can carry any key the monitor's config knows.
    """
    config = copy.deepcopy(template)
    settings = answer.get("settings") or {}
    account = answer["account"]

    monitor = config.setdefault("monitor", {})
    monitor["storage_state_path"] = str(home / "session.json")
    proxy = (answer.get("proxy") or {}).get("url")
    if proxy:
        monitor.update(split_proxy(str(proxy)))

    facebook = config.setdefault("marketplace", {}).setdefault("facebook", {})
    facebook.update(settings.get("search") or {})
    facebook["worker_id"] = worker_id
    if settings.get("coordinator_url"):
        facebook["control_plane_url"] = str(settings["coordinator_url"])
    if account.get("uid"):
        facebook["username"] = str(account["uid"])
    home_cities = [str(city) for city in answer.get("home_cities") or []]
    if home_cities:
        facebook["search_city"] = home_cities
        facebook["city_name"] = home_cities

    items = config.setdefault("item", {})
    for item in answer.get("items") or []:
        entry = dict(item.get("filters") or {})
        entry["search_phrases"] = [str(phrase) for phrase in item.get("phrases") or []]
        items[str(item["name"])] = entry

    for user in config.get("user", {}).values():
        if "alert_report_worker_id" in user:
            user["alert_report_worker_id"] = worker_id

    config["fleet"] = {
        "url": fleet_url.rstrip("/"),
        "worker_token": str(answer["worker_token"]),
        "epoch": int(answer["epoch"]),
        "worker_id": worker_id,
        "poll_hold_seconds": int(settings.get("poll_hold_seconds") or 50),
    }
    return config


def identity_for(answer: Dict[str, Any]) -> Dict[str, Any]:
    """The device the claim names, in the shape the monitor caches in identity.json."""
    account = answer["account"]
    device = answer.get("device") or {}
    key = f"pool-{account['no']}"
    profile: Dict[str, Any] = {
        "device_id": key,
        "fb_uid": str(account["uid"]) if account.get("uid") else None,
        "user_agent": device.get("user_agent"),
        "locale": device.get("locale"),
        "timezone_id": device.get("timezone"),
    }
    viewport = device.get("viewport")
    if isinstance(viewport, (list, tuple)) and len(viewport) == 2:
        size = {"width": int(viewport[0]), "height": int(viewport[1])}
        profile["viewport"] = size
        profile["screen"] = size
    cookies = [
        cookie
        for cookie in account.get("cookies") or []
        if isinstance(cookie, dict) and cookie.get("name") in DEVICE_COOKIES
    ]
    return {
        "device": {k: v for k, v in profile.items() if v is not None},
        "device_cookies": cookies,
        "identity_key": key,
    }


def write_files(home: Path, answer: Dict[str, Any], config: Dict[str, Any]) -> None:
    """config.toml, session.json (+ sidecar) and identity.json under `home`, mode 0600."""
    home.mkdir(parents=True, exist_ok=True)
    account = answer["account"]
    device = answer.get("device") or {}
    _write_private(home / "config.toml", toml_dumps(config))
    _write_private(
        home / "session.json",
        json.dumps({"cookies": account.get("cookies") or [], "origins": []}),
    )
    _write_private(
        home / "session.json.meta.json",
        json.dumps(
            {
                "user_agent": device.get("user_agent"),
                "proxy": config.get("monitor", {}).get("proxy_server"),
                "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
                "identity_key": f"pool-{account['no']}",
            }
        ),
    )
    _write_private(home / "identity.json", json.dumps(identity_for(answer)))


def _write_private(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".writing")
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def monitor_env(env: Dict[str, str], answer: Dict[str, Any], host_id: str, worker_id: str) -> Dict[str, str]:
    """The monitor's environment: the container's, plus the password fallback."""
    account = answer["account"]
    out = dict(env)
    out["RS_WORKER_ID"] = worker_id
    out["RS_HOST_ID"] = host_id
    for name, key in (("RS_FB_PASSWORD", "password"), ("RS_FB_TOTP", "totp_secret")):
        if account.get(key):
            out[name] = str(account[key])
        else:
            out.pop(name, None)
    return out


# ---------------------------------------------------------------------------
# a TOML writer (tomllib reads only)
# ---------------------------------------------------------------------------
_BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")


def _toml_key(key: str) -> str:
    return key if _BARE_KEY.match(key) else json.dumps(key, ensure_ascii=False)


def _toml_value(value: Any) -> str:
    # TOML basic strings take every escape JSON emits.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_toml_value(v) for v in value if v is not None) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(f"{_toml_key(k)} = {_toml_value(v)}" for k, v in value.items() if v is not None) + " }"
    raise TypeError(f"cannot write {type(value).__name__} to TOML")


def toml_dumps(data: Dict[str, Any]) -> str:
    """`data` as TOML: one `[a.b]` table per nested dict, scalars first. None is left out."""
    lines: List[str] = []

    def emit(table: Dict[str, Any], path: List[str]) -> None:
        scalars = {k: v for k, v in table.items() if not isinstance(v, dict) and v is not None}
        tables = {k: v for k, v in table.items() if isinstance(v, dict)}
        if path:
            lines.append("[" + ".".join(_toml_key(p) for p in path) + "]")
        for key, value in scalars.items():
            lines.append(f"{_toml_key(key)} = {_toml_value(value)}")
        if path or scalars:
            lines.append("")
        for key, value in tables.items():
            emit(value, [*path, key])

    emit(data, [])
    return "\n".join(lines).rstrip("\n") + "\n"


# ---------------------------------------------------------------------------
# running the monitor
# ---------------------------------------------------------------------------
def monitor_command(env: Dict[str, str]) -> List[str]:
    """Supervisord's `aimm` program, as flags; `RS_WORKER_MONITOR_CMD` overrides it."""
    override = env.get("RS_WORKER_MONITOR_CMD")
    if override:
        return shlex.split(override)
    return [
        "aimm",
        "--webui",
        "--webui-host",
        env.get("AIMM_WEBUI_HOST", "127.0.0.1"),
        "--webui-port",
        env.get("AIMM_WEBUI_PORT", "8467"),
    ]


def start_display(env: Dict[str, str]) -> List[subprocess.Popen]:
    """Xvfb and x11vnc as supervisord ran them, when the image has them.

    The monitor drives a real, non-headless Chromium (Facebook serves a
    stripped page to headless), so it needs an X server; the VNC server is
    what lets an operator finish a login over Watch.
    """
    display = env.get("DISPLAY", ":99")
    procs: List[subprocess.Popen] = []
    xvfb = shutil.which("Xvfb")
    if xvfb is None:
        log("no Xvfb on this host; the monitor runs without a virtual display")
        return procs
    procs.append(
        subprocess.Popen(
            [xvfb, display, "-screen", "0", env.get("SCREEN_GEOMETRY", "1920x1080x24"),
             "-ac", "+extension", "GLX", "+render", "-noreset"],
            env=env,
        )
    )
    socket_path = Path("/tmp/.X11-unix") / f"X{display.lstrip(':')}"
    for _ in range(30):
        if socket_path.exists():
            break
        time.sleep(0.1)
    x11vnc = shutil.which("x11vnc")
    if x11vnc is not None:
        procs.append(
            subprocess.Popen(
                [x11vnc, "-display", display, "-nopw", "-forever", "-shared",
                 "-rfbport", env.get("VNC_PORT", "5900")],
                env=env,
            )
        )
    return procs


class _Health:
    """What `/healthz` answers: 200 while the monitor process is up."""

    def __init__(self, worker_id: str, epoch: int) -> None:
        self.worker_id = worker_id
        self.epoch = epoch
        self.monitor: subprocess.Popen | None = None
        self.started = time.monotonic()

    def status(self) -> tuple[int, Dict[str, Any]]:
        monitor = self.monitor
        alive = monitor is not None and monitor.poll() is None
        body: Dict[str, Any] = {
            "ok": alive,
            "worker_id": self.worker_id,
            "epoch": self.epoch,
            "uptime_s": round(time.monotonic() - self.started),
        }
        if monitor is not None:
            body["monitor_pid"] = monitor.pid
            if not alive:
                body["exit"] = monitor.returncode
        return (200 if alive else 503), body


def serve_healthz(health: _Health, port: int) -> http.server.ThreadingHTTPServer:
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path.split("?", 1)[0] != "/healthz":
                self.send_error(404)
                return
            status, body = health.status()
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - http.server's name
            pass

    # Loopback only: the healthcheck runs inside the container.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, name="healthz", daemon=True).start()
    return server


def stop_all(procs: Sequence[subprocess.Popen], grace_s: float) -> None:
    """SIGTERM every process at once, then SIGKILL what is left after `grace_s` in all."""
    for proc in procs:
        try:
            proc.terminate()
        except OSError:
            pass
    deadline = time.monotonic() + grace_s
    for proc in procs:
        try:
            proc.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def run_monitor(
    command: Sequence[str],
    env: Dict[str, str],
    health: _Health,
    healthz_port: int,
    on_stop: Callable[[], None] | None = None,
) -> int:
    """Run the display and the monitor; the monitor's exit code, 75 kept as 75.

    SIGTERM (`docker stop`) goes to the monitor, which hands back its last
    result, saves its session and leaves 0 within `MONITOR_STOP_GRACE_S`;
    after that it is killed. tini sends the signal to this process only, so
    the display stays up while the browser saves and is stopped after.
    """
    procs: Dict[str, subprocess.Popen] = {}
    stopping = threading.Event()

    def kill_monitor() -> None:
        if "monitor" in procs:
            procs["monitor"].kill()

    # Daemon, and started once: a pending timer must not keep this process
    # alive after the monitor has gone.
    killer = threading.Timer(MONITOR_STOP_GRACE_S, kill_monitor)
    killer.daemon = True

    def stop_monitor() -> None:
        try:
            procs["monitor"].send_signal(signal.SIGTERM)
        except OSError:
            pass
        if not killer.is_alive():
            killer.start()

    def forward(signum: int, _frame: Any) -> None:
        log(f"signal {signum}: stopping the monitor")
        stopping.set()
        if on_stop is not None:
            on_stop()
        if "monitor" in procs:
            stop_monitor()

    # Installed before anything starts, so a stop during start-up is not lost.
    previous = {}
    if threading.current_thread() is threading.main_thread():
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, forward)
    display: List[subprocess.Popen] = []
    server: http.server.ThreadingHTTPServer | None = None
    try:
        display = start_display(env)
        monitor = subprocess.Popen(list(command), env=env)
        procs["monitor"] = monitor
        if stopping.is_set():
            stop_monitor()
        health.monitor = monitor
        server = serve_healthz(health, healthz_port)
        log(f"monitor started (pid {monitor.pid}); /healthz on {healthz_port}")
        code = monitor.wait()
    finally:
        killer.cancel()
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        if server is not None:
            server.shutdown()
        stop_all(display, DISPLAY_STOP_GRACE_S)
    if code < 0:
        return 128 - code
    return code


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def run_fleet(argv: Sequence[str], env: Dict[str, str], home: Path | None = None) -> int:
    """Fleet mode, end to end; the exit code."""
    fleet_url, host_id, host_token = (env[name] for name in FLEET_ENV)
    worker_id = env.get("RS_FLEET_WORKER_ID") or ""
    if not worker_id:
        log("RS_FLEET_WORKER_ID is not set; the agent names each worker")
        return EXIT_CONFIG
    vnc_port = env.get("RS_VNC_PORT") or ""
    version = env.get("RS_VERSION") or "unknown"
    home = home or (Path.home() / ".ai-marketplace-monitor")

    try:
        answer = claim(
            fleet_url,
            host_id,
            host_token,
            worker_id,
            version,
            int(vnc_port) if vnc_port.isdigit() else 5900,
        )
    except ClaimFailedError as e:
        log(f"{e}; exiting {e.code}")
        return e.code
    account = answer["account"]
    log(
        f"claimed account #{account.get('no')} as {worker_id} (epoch {answer['epoch']}), "
        f"{len(answer.get('items') or [])} item(s), {len(answer.get('home_cities') or [])} home "
        f"city/cities, proxy {'set' if (answer.get('proxy') or {}).get('url') else 'none'}"
    )

    try:
        with open(TEMPLATE, "rb") as f:
            template = tomllib.load(f)
        config = render_config(template, answer, fleet_url, worker_id, home)
        write_files(home, answer, config)
    except (OSError, KeyError, TypeError, ValueError, tomllib.TOMLDecodeError) as e:
        log(f"could not render the worker's configuration: {e}; exiting {EXIT_CONFIG}")
        return EXIT_CONFIG

    relay = start_vnc_relay(fleet_url, str(answer["worker_token"]), env)
    health = _Health(worker_id, int(answer["epoch"]))
    port = env.get("RS_WORKER_HEALTHZ_PORT") or ""
    try:
        code = run_monitor(
            monitor_command(env),
            monitor_env(env, answer, host_id, worker_id),
            health,
            int(port) if port.isdigit() else HEALTHZ_PORT,
            on_stop=relay.request_stop if relay is not None else None,
        )
    finally:
        if relay is not None:
            relay.stop(timeout=RELAY_STOP_GRACE_S)
    log(f"monitor exited {code}")
    return code


def start_vnc_relay(fleet_url: str, worker_token: str, env: Dict[str, str]) -> Any:
    """The relay to the ERP's VNC page, when this image has a VNC server to show."""
    if shutil.which("x11vnc") is None:
        return None
    from .vnc_relay import VncRelay

    port = env.get("VNC_PORT") or ""
    return VncRelay(
        fleet_url,
        worker_token,
        ("127.0.0.1", int(port) if port.isdigit() else 5900),
        log=log,
    ).start()


def main(argv: Sequence[str] | None = None, env: Dict[str, str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    env = dict(os.environ if env is None else env)
    if not all(env.get(name) for name in FLEET_ENV):
        if not argv:
            log("no fleet variables and no command to run")
            return EXIT_CONFIG
        # The image as it always was: the command, this process gone.
        os.execvp(argv[0], argv)  # noqa: S606 - the image's own CMD
    return run_fleet(argv, env)


if __name__ == "__main__":
    sys.exit(main())
