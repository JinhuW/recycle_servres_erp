"""The worker image's entrypoint: the old command as it was, or fleet mode.

Without `RS_FLEET_URL`, `RS_FLEET_HOST_ID` and a claim credential
(`RS_FLEET_CLAIM_TICKET`, or `RS_FLEET_HOST_TOKEN` from an agent before
the tickets) this execs the image's command (supervisord with the
bind-mounted config) and is not there at all. With them it:

1. claims an account from the ERP's fleet (`POST /api/fleet/worker/claim`
   with the single-use claim ticket the host agent minted for this
   container, or the host token): a slot, its sealed credentials, proxy,
   device, the items to search and a worker token for the slot's epoch;
2. renders the monitor's `config.toml`, the Playwright `session.json` and
   the device's `identity.json` inside the container, never on a mount;
3. exports `RS_FB_PASSWORD` / `RS_FB_TOTP` for the monitor's password
   fallback, used only when the cookie session is invalid, as today, and
   the shared secrets the claim's `env` object carries (OpenRouter, the
   coordinator's per-worker tokens, Telegram), which the rendered config
   references as `${VAR}`. Alerts stay off unless that `env` says
   `RS_ALERTS=on`: no Telegram channel is rendered, and the monitor's
   `[fleet] alerts = false` keeps it from claiming alerts or reporting
   cities, walls and incidents to the coordinator;
4. runs the virtual display, VNC and the monitor, serving `GET /healthz` on
   8788 while the monitor is up, and leaves with the monitor's exit code;
5. keeps a socket parked at the ERP's VNC relay (`vnc_relay.py`), so a
   manager can watch the browser with no port open on this host.

Exit codes, as the host agent reads them: 75 for "no slot", a stale epoch
or a refused claim ticket (spent by an earlier boot of this container, or
expired: the agent starts a fresh container, with a fresh ticket, after a
minute), 70 for a claim or
configuration failure (the agent backs off ten minutes), 78 for a worker
parked for an operator that could not stay up (the agent leaves it
stopped), otherwise the monitor's own code (0 on `docker stop`).

A worker that cannot reach Facebook or its proxy does not exit at all: the
monitor parks, heartbeats DEAD with `connect_failed`, and `/healthz` keeps
answering 200 with `"state": "parked"`, so nothing starts it again.

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
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Sequence

import tomllib

FLEET_ENV = ("RS_FLEET_URL", "RS_FLEET_HOST_ID")
# What the worker claims with: the ticket the agent minted for this one
# container, else the host token an agent before the tickets passed.
TICKET_ENV = "RS_FLEET_CLAIM_TICKET"
HOST_TOKEN_ENV = "RS_FLEET_HOST_TOKEN"
TICKET_PREFIX = "fct_"

# The host agent's reading of how a worker left. The same 75 is in the
# monitor's control_plane.py (`STALE_EPOCH_EXIT_CODE`); the two cannot share
# a module.
EXIT_RESTART = 75
EXIT_CONFIG = 70
# The monitor's `OPERATOR_EXIT_CODE`.
EXIT_OPERATOR = 78

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
# Written by the monitor when it parks for an operator; read by /healthz.
PARKED_FILE = "parked.json"
# Written by the VNC relay when the fleet refuses its dial for the epoch; the
# monitor stops its search on it before the next page, as on its own 409.
FENCE_FILE = "fenced"
# Names the claim's `env` may never set, even were the template to name them:
# the fleet's own wiring, and what this entrypoint derives itself.
RESERVED_ENV = re.compile(
    r"^(RS_FLEET_.*|RS_WORKER_ID|RS_HOST_ID|RS_FB_PASSWORD|RS_FB_TOTP|RS_VNC_PORT|"
    r"RS_PARKED_FILE|RS_VERSION|RS_MONITOR_COMMIT|RS_WORKER_.*|PATH|HOME|DISPLAY)$"
)
# Derived from `TOKENS_ENV`, never taken from the claim as they are: one of
# them set straight would be the fleet-wide legacy token, which lets one
# container read every worker's 2FA codes from the coordinator.
DERIVED_ENV = ("RS_CONTROL_PLANE_TOKEN", "RS_COORDINATOR_TOKEN")
# The fleet's alert switch, in the claim's `env`: "on" lets a worker alert
# (Telegram, alert claims, alert reports) and report to the coordinator what
# the live fleet acts on. Anything else, or absent, withholds all of it.
ALERTS_ENV = "RS_ALERTS"
# One coordinator token per fleet worker id, as a JSON object in one string:
# the claim's `env` is shared by every worker, and the coordinator's tokens
# each name one worker. Only this worker's leaves the entrypoint.
TOKENS_ENV = "RS_CONTROL_PLANE_TOKENS"
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ENV_REF = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")
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
def fleet_credential(env: Dict[str, str]) -> str:
    """The claim's bearer: the claim ticket when the agent passed one, else the host token."""
    return env.get(TICKET_ENV) or env.get(HOST_TOKEN_ENV) or ""


def fleet_mode(env: Dict[str, str]) -> bool:
    return all(env.get(name) for name in FLEET_ENV) and bool(fleet_credential(env))


def claim(
    fleet_url: str,
    host_id: str,
    host_token: str,
    worker_id: str,
    version: str,
    vnc_port: int,
    sleep: Callable[[float], None] | None = None,
    handoff_epoch: int | None = None,
) -> Dict[str, Any]:
    """Claim a slot: the fleet's answer, or `ClaimFailedError` with the exit code.

    `409 no_slot` is an answer (every account is taken) and leaves at once
    with 75, as does a 401 on a claim ticket: it was spent by an earlier
    boot of this container (`docker start`) or has expired, and only a
    fresh container gets a fresh one. Anything else is retried
    `CLAIM_ATTEMPTS` times, 10 s apart, and then leaves with 70.
    `host_token` is either bearer; the agent may pass a ticket under the
    host token's name, so the prefix says which it is.
    """
    ticket = host_token.startswith(TICKET_PREFIX)
    sleep = sleep or time.sleep
    url = f"{fleet_url.rstrip('/')}/api/fleet/worker/claim"
    body = json.dumps(
        {"host_id": host_id, "worker_id": worker_id, "version": version, "vnc_port": vnc_port, "claim_id": str(uuid.uuid4()), **({"handoff_epoch": handoff_epoch} if handoff_epoch is not None else {})}
    ).encode("utf-8")
    last = "no answer"
    for attempt in range(1, CLAIM_ATTEMPTS + 1):
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {host_token}",
                "Content-Type": "application/json",
                # Cloudflare's Browser Integrity Check refuses urllib's default agent (403, 1010).
                "User-Agent": f"rs-worker/{version}",
            },
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
            if e.code == 401 and ticket:
                raise ClaimFailedError(EXIT_RESTART, "the claim ticket was refused") from None
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
    template: Dict[str, Any],
    answer: Dict[str, Any],
    fleet_url: str,
    worker_id: str,
    home: Path,
    alerts: bool = False,
) -> Dict[str, Any]:
    """The template with the claim answer merged in.

    The template carries what every fleet worker shares (the AI backend, the
    buying prompt, the notification channel, `${VAR}` references the monitor
    expands from the container's environment). The claim supplies what is
    this slot's: proxy, items, search settings, home cities, the coordinator
    the listings go to, and the `[fleet]` table that puts the monitor in
    fleet mode. Search-setting and item-filter keys are copied verbatim, so
    the ERP can carry any key the monitor's config knows. With `alerts` off
    no user keeps a Telegram channel or an alert report.
    """
    config = copy.deepcopy(template)
    answer = without_env_refs(answer)
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
    coordinator = has_coordinator(answer)
    if coordinator:
        facebook["control_plane_url"] = str(settings["coordinator_url"])
    else:
        # Without a coordinator nothing is posted, claimed or escalated
        # anywhere: no control plane, no alert report.
        for key in COORDINATOR_KEYS:
            facebook.pop(key, None)
    if account.get("uid"):
        facebook["username"] = str(account["uid"])
    home_cities = [str(city) for city in answer.get("home_cities") or []]
    if home_cities:
        facebook["search_city"] = home_cities
        facebook["city_name"] = home_cities
    else:
        # The monitor refuses a currency without a search city, and a fleet
        # account may have no home city: its cities come from the tasks.
        facebook.pop("currency", None)

    items = config.setdefault("item", {})
    for item in answer.get("items") or []:
        entry = dict(item.get("filters") or {})
        entry["search_phrases"] = [str(phrase) for phrase in item.get("phrases") or []]
        items[str(item["name"])] = entry

    for user in config.get("user", {}).values():
        if not alerts:
            for key in [k for k in user if k.startswith("telegram_")]:
                del user[key]
        if not coordinator or not alerts:
            for key in ALERT_REPORT_KEYS:
                user.pop(key, None)
        elif "alert_report_worker_id" in user:
            user["alert_report_worker_id"] = worker_id

    config["fleet"] = {
        "url": fleet_url.rstrip("/"),
        "worker_token": str(answer["worker_token"]),
        "token_path": str(home / "fleet-token"),
        "fence_path": str(home / FENCE_FILE),
        "epoch": int(answer["epoch"]),
        "worker_id": worker_id,
        "poll_hold_seconds": int(settings.get("poll_hold_seconds") or 50),
        "alerts": alerts,
    }
    return config


def without_env_refs(answer: Dict[str, Any]) -> Dict[str, Any]:
    """The claim's search data with every value that reads as `${VAR}` left out.

    The monitor expands such a string from its environment wherever it sits,
    so a phrase typed as `${RS_FB_PASSWORD}` would put the password in a
    Facebook search URL and the logs. Names are logged, never values.
    """
    dropped: List[str] = []

    def clean(value: Any, path: str) -> Any:
        if isinstance(value, dict):
            kept = {}
            for k, v in value.items():
                if _is_env_ref(v):
                    dropped.append(f"{path}.{k}")
                else:
                    kept[k] = clean(v, f"{path}.{k}")
            return kept
        if isinstance(value, list):
            items = []
            for v in value:
                if _is_env_ref(v):
                    dropped.append(f"{path}[]")
                else:
                    items.append(clean(v, path))
            return items
        return value

    out = dict(answer)
    for key in ("settings", "items", "home_cities"):
        if key in out:
            out[key] = clean(out[key], key)
    account = out.get("account")
    if isinstance(account, dict) and _is_env_ref(account.get("uid")):
        out["account"] = {**account, "uid": None}
        dropped.append("account.uid")
    if dropped:
        log(f"claim values that read as ${{VAR}} left out: {', '.join(sorted(set(dropped)))}")
    return out


def _is_env_ref(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("${") and value.endswith("}")


COORDINATOR_KEYS = ("control_plane_url", "control_plane_token")
ALERT_REPORT_KEYS = ("alert_report_url", "alert_report_token", "alert_report_worker_id")


def has_coordinator(answer: Dict[str, Any]) -> bool:
    url = (answer.get("settings") or {}).get("coordinator_url")
    return isinstance(url, str) and bool(url.strip())


def alerts_on(env: Dict[str, str]) -> bool:
    return (env.get(ALERTS_ENV) or "").strip().lower() == "on"


def worker_coordinator_token(raw: str, worker_id: str) -> str | None:
    """This worker's token from `TOKENS_ENV`, or None. Never logs a value."""
    try:
        tokens = json.loads(raw)
    except ValueError:
        log(f"{TOKENS_ENV} is not JSON; ignored")
        return None
    token = tokens.get(worker_id) if isinstance(tokens, dict) else None
    if not isinstance(token, str) or not token.strip():
        log(f"{TOKENS_ENV} has no token for {worker_id}")
        return None
    return token.strip()


def template_env_names(template: Dict[str, Any]) -> set[str]:
    """Every `${VAR}` the template references, anywhere."""
    names: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)
        elif isinstance(value, str):
            match = _ENV_REF.match(value)
            if match:
                names.add(match.group(1))

    walk(template)
    return names


def claim_env_allowed(template: Dict[str, Any] | None = None) -> set[str]:
    """The names the claim's `env` may set: what the template reads, and the switches."""
    if template is None:
        with open(TEMPLATE, "rb") as f:
            template = tomllib.load(f)
    names = template_env_names(template) | {ALERTS_ENV, TOKENS_ENV}
    return {n for n in names if not RESERVED_ENV.match(n) and n not in DERIVED_ENV}


def claim_env(answer: Dict[str, Any], allowed: set[str] | None = None) -> Dict[str, str]:
    """The shared secrets the claim carries in `env`, as environment variables.

    The Cloudflare Worker adds its FLEET_WORKER_ENV secret to a successful
    claim. Only string values under the names the template reads (plus the
    alert switch and the coordinator's token map) are taken: anything else,
    `LD_PRELOAD` or `HTTPS_PROXY` say, would reach every process here.
    Values are never logged.
    """
    raw = answer.get("env")
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        log("the claim's env is not an object; ignored")
        return {}
    allowed = claim_env_allowed() if allowed is None else allowed
    out: Dict[str, str] = {}
    skipped: List[str] = []
    for name, value in raw.items():
        if not isinstance(name, str) or not _ENV_NAME.match(name) or name not in allowed:
            skipped.append(str(name)[:64])
        elif not isinstance(value, str):
            skipped.append(name)
        else:
            out[name] = value
    log(f"claim env: {', '.join(sorted(out)) or 'none'}")
    if skipped:
        log(f"claim env ignored (not the template's, badly named or not a string): {', '.join(sorted(skipped))}")
    return out


def resolve_env_refs(config: Dict[str, Any], env: Dict[str, str]) -> List[str]:
    """Drop every `${VAR}` value whose variable `env` leaves unset or empty.

    The monitor would read such a value as None anyway; leaving the key out
    says the same thing without a warning per key, and an optional channel
    (Telegram, the coordinator's tokens) is then simply off. The names
    dropped, sorted.
    """
    dropped: set[str] = set()

    def walk(table: Dict[str, Any]) -> None:
        for key in list(table):
            value = table[key]
            if isinstance(value, dict):
                walk(value)
                continue
            match = _ENV_REF.match(value) if isinstance(value, str) else None
            if match and not env.get(match.group(1)):
                dropped.add(match.group(1))
                del table[key]

    walk(config)
    return sorted(dropped)


def required_env(template: Dict[str, Any]) -> List[str]:
    """The variables the AI backends reference: without them nothing can be judged."""
    names = set()
    for backend in (template.get("ai") or {}).values():
        for value in backend.values() if isinstance(backend, dict) else ():
            match = _ENV_REF.match(value) if isinstance(value, str) else None
            if match:
                names.add(match.group(1))
    return sorted(names)


def _pair(value: Any) -> Dict[str, int] | None:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        return {"width": int(value[0]), "height": int(value[1])}
    return None


def presented_user_agent(device: Dict[str, Any]) -> str | None:
    """The user agent to pin, or None to let the browser present its own.

    A device moved from a homelab worker whose browser never had one pinned
    lists it in `native`: the backend still fills a default in, and pinning
    even the identical string would change the client hints the browser
    sends beside it.
    """
    return None if _native(device, "user_agent") else device.get("user_agent")


def _native(device: Dict[str, Any], field: str) -> bool:
    native = device.get("native")
    return isinstance(native, list) and field in native


def identity_for(answer: Dict[str, Any]) -> Dict[str, Any]:
    """The device the claim names, in the shape the monitor caches in identity.json."""
    account = answer["account"]
    device = answer.get("device") or {}
    key = f"pool-{account['no']}"
    profile: Dict[str, Any] = {
        "device_id": key,
        "fb_uid": str(account["uid"]) if account.get("uid") else None,
        "user_agent": presented_user_agent(device),
        "locale": None if _native(device, "locale") else device.get("locale"),
        "timezone_id": None if _native(device, "timezone") else device.get("timezone"),
    }
    viewport = _pair(device.get("viewport"))
    if viewport:
        profile["viewport"] = viewport
        profile["screen"] = _pair(device.get("screen")) or viewport
    if isinstance(device.get("device_scale_factor"), (int, float)) and device["device_scale_factor"] > 0:
        profile["device_scale_factor"] = float(device["device_scale_factor"])
    if device.get("preserve_user_agent") is True:
        profile["preserve_user_agent"] = True
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
    state = account.get("storage_state")
    if state is None:
        state = {"cookies": account.get("cookies") or [], "origins": []}
    elif (not isinstance(state, dict) or state.get("cookies") != account.get("cookies")
          or not isinstance(state.get("origins"), list)):
        raise ValueError("the claimed storage state does not match the account's cookies")
    _write_private(home / "config.toml", toml_dumps(config))
    _write_private(home / "fleet-token", str(answer["worker_token"]))
    _write_private(
        home / "session.json",
        json.dumps(state),
    )
    _write_private(
        home / "session.json.meta.json",
        json.dumps(
            {
                "user_agent": presented_user_agent(device),
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


def monitor_env(
    env: Dict[str, str],
    answer: Dict[str, Any],
    host_id: str,
    worker_id: str,
    home: Path | None = None,
) -> Dict[str, str]:
    """The monitor's environment: the container's, the claim's `env`, the password fallback.

    What the container already sets wins over the claim's `env` (CONTRACTS
    §2). The fleet variables stay out: the claim ticket (or, from an older
    agent, the host token, which can claim any account on this host) has no
    business in the monitor or its browser.
    """
    account = answer["account"]
    out = {k: v for k, v in env.items() if not k.startswith("RS_FLEET_")}
    for name, value in claim_env(answer).items():
        out.setdefault(name, value)
    tokens = out.pop(TOKENS_ENV, None)
    coordinator = has_coordinator(answer)
    if coordinator and tokens and not out.get("RS_CONTROL_PLANE_TOKEN"):
        token = worker_coordinator_token(tokens, worker_id)
        if token:
            out["RS_CONTROL_PLANE_TOKEN"] = token
            # The coordinator takes alert reports on the same per-worker token.
            out.setdefault("RS_COORDINATOR_TOKEN", token)
    if coordinator and alerts_on(out):
        # The monitor's incident reports read the coordinator from here.
        out["RS_CONTROL_PLANE_URL"] = str(answer["settings"]["coordinator_url"])
    else:
        # The monitor's own fallback would otherwise find a coordinator here,
        # and an incident report through it pages the ops chat.
        out.pop("RS_CONTROL_PLANE_URL", None)
    if home is not None:
        out["RS_PARKED_FILE"] = str(home / PARKED_FILE)
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
def monitor_command(env: Dict[str, str], fleet: bool = False) -> List[str]:
    """Supervisord's `aimm` program, as flags; `RS_WORKER_MONITOR_CMD` overrides it.

    In fleet mode the web UI listens on loopback only: the image's
    `AIMM_WEBUI_HOST=0.0.0.0` is for the homelab compose files, and on the
    agent's bridge network every other worker could reach it.
    """
    override = env.get("RS_WORKER_MONITOR_CMD")
    if override:
        return shlex.split(override)
    return [
        "aimm",
        "--webui",
        "--webui-host",
        "127.0.0.1" if fleet else env.get("AIMM_WEBUI_HOST", "127.0.0.1"),
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
                 "-rfbport", env.get("VNC_PORT", "5900"), *vnc_allow_args()],
                env=env,
            )
        )
    return procs


def vnc_allow_args(route_file: str = "/proc/net/route") -> List[str]:
    """x11vnc's `-allow`: the relay (loopback) and the host's published port.

    The VNC server has no password, so on the agent's bridge network any
    other worker could drive this one's logged-in browser. The host's
    `127.0.0.1:<port>` publish reaches the container from the bridge's
    gateway, which is let in beside loopback; nothing else is. Without a
    readable route table nothing is restricted (not a fleet container).
    """
    gateway = default_gateway(route_file)
    if gateway is None:
        return []
    return ["-allow", f"127.0.0.1,{gateway}"]


def default_gateway(route_file: str = "/proc/net/route") -> str | None:
    """The IPv4 default gateway from the kernel's route table, or None."""
    try:
        with open(route_file, encoding="ascii") as f:
            next(f, None)
            for line in f:
                fields = line.split()
                if len(fields) > 2 and fields[1] == "00000000" and fields[2] != "00000000":
                    raw = bytes.fromhex(fields[2])
                    return ".".join(str(b) for b in reversed(raw))
    except (OSError, ValueError):
        return None
    return None


class _Health:
    """What `/healthz` answers: 200 while the monitor process is up."""

    def __init__(self, worker_id: str, epoch: int, parked_file: Path | None = None) -> None:
        self.worker_id = worker_id
        self.epoch = epoch
        self.parked_file = parked_file
        self.monitor: subprocess.Popen | None = None
        self.started = time.monotonic()

    def parked(self) -> Dict[str, Any] | None:
        """What the monitor wrote when it parked for an operator, if it did."""
        if self.parked_file is None:
            return None
        try:
            with open(self.parked_file, encoding="utf-8") as f:
                parked = json.load(f)
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            return {"reason": "unknown"}
        return parked if isinstance(parked, dict) else {"reason": "unknown"}

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
        parked = self.parked() if alive else None
        if parked is not None:
            # Up and waiting for an operator. Still 200: an unhealthy
            # container is one an agent may replace, and that is a login.
            body["ok"] = False
            body["state"] = "parked"
            body["parked"] = parked
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
    fleet_url, host_id = (env[name] for name in FLEET_ENV)
    host_token = fleet_credential(env)
    if not env.get(TICKET_ENV):
        log("no claim ticket; claiming with the host token (an agent from before the tickets)")
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
            handoff_epoch=int(env["RS_FLEET_HANDOFF_EPOCH"]) if env.get("RS_FLEET_HANDOFF_EPOCH", "").isdigit() else None,
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

    menv = monitor_env(env, answer, host_id, worker_id, home)
    try:
        with open(TEMPLATE, "rb") as f:
            template = tomllib.load(f)
        alerts = alerts_on(menv)
        needed = required_env(template)
        if has_coordinator(answer):
            needed.append("RS_CONTROL_PLANE_TOKEN")
        if alerts and menv.get("RS_ALERT_REPORT_URL"):
            needed.append("RS_COORDINATOR_TOKEN")
        missing = [name for name in needed if not menv.get(name)]
        if missing:
            raise ValueError(f"no {', '.join(missing)} in the claim's env or the container's")
        config = render_config(template, answer, fleet_url, worker_id, home, alerts=alerts)
        dropped = resolve_env_refs(config, menv)
        write_files(home, answer, config)
    except (OSError, KeyError, TypeError, ValueError, tomllib.TOMLDecodeError) as e:
        log(f"could not render the worker's configuration: {e}; exiting {EXIT_CONFIG}")
        return EXIT_CONFIG
    log(
        f"coordinator {'on' if has_coordinator(answer) else 'off'}, "
        f"alerts {'on' if alerts else 'off (withheld)'}; "
        f"unset, left out of the config: {', '.join(dropped) or 'none'}"
    )
    for stale in (PARKED_FILE, FENCE_FILE):
        try:
            (home / stale).unlink()
        except FileNotFoundError:
            pass

    relay = start_vnc_relay(
        fleet_url,
        str(answer["worker_token"]),
        {"VNC_PORT": env.get("VNC_PORT", ""), "RS_FLEET_TOKEN_PATH": str(home / "fleet-token")},
        fence_path=str(home / FENCE_FILE),
    )
    health = _Health(worker_id, int(answer["epoch"]), home / PARKED_FILE)
    port = env.get("RS_WORKER_HEALTHZ_PORT") or ""
    try:
        code = run_monitor(
            monitor_command(env, fleet=True),
            menv,
            health,
            int(port) if port.isdigit() else HEALTHZ_PORT,
            on_stop=relay.request_stop if relay is not None else None,
        )
    finally:
        if relay is not None:
            relay.stop(timeout=RELAY_STOP_GRACE_S)
    if code not in (0, EXIT_RESTART, EXIT_OPERATOR) and health.parked() is not None:
        # Parked for an operator and then gone: started again it would only
        # log in to fail the same way.
        log(f"monitor exited {code} while parked for an operator; exiting {EXIT_OPERATOR}")
        return EXIT_OPERATOR
    log(f"monitor exited {code}")
    return code


def start_vnc_relay(
    fleet_url: str, worker_token: str, env: Dict[str, str], fence_path: str | None = None
) -> Any:
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
        token_path=env.get("RS_FLEET_TOKEN_PATH"),
        fence_path=fence_path,
    ).start()


def main(argv: Sequence[str] | None = None, env: Dict[str, str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    env = dict(os.environ if env is None else env)
    if not fleet_mode(env):
        if not argv:
            log("no fleet variables and no command to run")
            return EXIT_CONFIG
        # The image as it always was: the command, this process gone.
        os.execvp(argv[0], argv)  # noqa: S606 - the image's own CMD
    return run_fleet(argv, env)


if __name__ == "__main__":
    sys.exit(main())
