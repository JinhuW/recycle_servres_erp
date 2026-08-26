"""Generate per-worker monitor configs from master.toml + fleet.toml.

Each worker VM is pinned to exactly one region. Assignment is static: a
worker's search scope changes only when fleet.toml is edited and configs are
regenerated — there is no runtime dispatch and no random city selection.
"""

import copy
import re
from pathlib import Path
from typing import Any, Dict, List

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib  # type: ignore

import tomli_w

# Environment variable each worker reads its own control-plane token from.
# Fixed rather than derived from the worker id — see build_worker_config.
DEFAULT_CONTROL_PLANE_TOKEN_ENV = "RS_CONTROL_PLANE_TOKEN"

GENERATED_HEADER = """# GENERATED FILE — DO NOT EDIT.
# Produced by `rsc gen-configs` from configs/master.toml + configs/fleet.toml.
# Worker: {worker_id}   Region: {region} ({cities})
"""


def load_toml(path: Path) -> Dict[str, Any]:
    with open(path, "rb") as handle:
        return tomllib.load(handle)


def _slug(worker_id: str) -> str:
    """`denver-1` -> `DENVER_1`, for building a per-worker env var name."""
    return re.sub(r"[^A-Za-z0-9]+", "_", worker_id).strip("_").upper()


def build_worker_config(
    master: Dict[str, Any],
    worker_id: str,
    worker: Dict[str, Any],
    coordinator_url_env: str = "RS_COORDINATOR_URL",
    coordinator_token_env: str = "RS_COORDINATOR_TOKEN",
    control_plane_url_env: str = "RS_CONTROL_PLANE_URL",
) -> Dict[str, Any]:
    """Return the config for one worker: master, narrowed to its region."""
    region = worker.get("region")
    if not region:
        raise ValueError(f"Worker {worker_id} has no region assigned.")

    regions = master.get("region", {})
    if region not in regions:
        raise ValueError(
            f"Worker {worker_id} references region '{region}', which is not defined "
            f"in master.toml. Known regions: {', '.join(sorted(regions)) or 'none'}"
        )

    config = copy.deepcopy(master)

    # Keep only this worker's region so the file states its scope plainly.
    config["region"] = {region: regions[region]}

    facebook = config.setdefault("marketplace", {}).setdefault("facebook", {})
    # search_region expands to the region's city list. Drop the Phase 1
    # single-city defaults so the two cannot disagree — including currency and
    # radius, which are zip-aligned with search_city and are rejected outright
    # when it is absent. The region section supplies all three.
    for city_bound_key in ("search_city", "radius", "currency", "city_name"):
        facebook.pop(city_bound_key, None)
    facebook["search_region"] = region

    # Workers authenticate from a saved session, not credentials. Optional
    # per-worker password fallback is supported but deliberately not the
    # default — see configs/fleet.toml.
    for key, env_key in (
        ("username", "fb_username_env"),
        ("password", "fb_password_env"),
        ("totp_secret", "fb_totp_env"),
    ):
        env_var = worker.get(env_key)
        if env_var:
            facebook[key] = f"${{{env_var}}}"
    if not worker.get("fb_username_env"):
        # Master may carry a Phase 1 credential block; a sharded worker must
        # not inherit it.
        for credential_key in ("username", "password", "totp_secret"):
            facebook.pop(credential_key, None)

    # Optional per-worker pacing. Used to slow a worker down — a region with
    # more cities than the rest, or one thin enough to check a few times a day
    # rather than hourly. Absent, master.toml's pacing applies.
    for pacing_key in ("search_interval", "max_search_interval"):
        if pacing_key in worker:
            facebook[pacing_key] = worker[pacing_key]

    monitor = config.setdefault("monitor", {})
    proxy_env = worker.get("proxy_env")
    if proxy_env:
        monitor["proxy_server"] = [f"${{{proxy_env}}}"]
    # Each worker's session is mounted at this path inside its container.
    monitor["storage_state_path"] = worker.get("storage_state_path", "/data/fb_state.json")

    # Route alerts through the coordinator so cross-worker duplicates collapse
    # into one Telegram message.
    config.setdefault("notification", {})["coordinator"] = {
        "coordinator_url": f"${{{coordinator_url_env}}}",
        "coordinator_token": f"${{{coordinator_token_env}}}",
        "worker_id": worker_id,
    }

    # Point the worker at the control plane for verification codes, health
    # reporting, and escalation. The token is per-worker (`rsc mint-token
    # --worker <id>`), so a compromised VM reaches only its own account.
    #
    # One worker per VM, so the variable has a FIXED name by default rather than
    # one derived from the worker id. A derived name is unreachable from
    # docker-compose.worker.yml — compose cannot build `RS_WORKER_TOKEN_NE_1`
    # from `${WORKER_ID}` — so it went unset on every worker, and utils.py
    # degrades an unset `${VAR}` to None with a warning, which means the whole
    # control plane (2FA, escalation, heartbeat, session backup) was silently
    # off with the container otherwise healthy. Override per worker with
    # `control_plane_token_env` when several workers share one env file.
    control_plane_env = worker.get("control_plane_token_env", DEFAULT_CONTROL_PLANE_TOKEN_ENV)
    facebook["worker_id"] = worker_id
    facebook["control_plane_url"] = f"${{{control_plane_url_env}}}"
    facebook["control_plane_token"] = f"${{{control_plane_env}}}"
    if worker.get("vnc_url"):
        # Surfaced in escalation alerts so an operator lands in this worker's
        # own browser, on the IP its session belongs to.
        facebook["vnc_url"] = worker["vnc_url"]

    for user in config.get("user", {}).values():
        user.pop("telegram_token", None)
        user.pop("telegram_chat_id", None)
        # Topic routing is the coordinator's business too: workers never
        # message Telegram, so the ${TELEGRAM_TOPIC_*} placeholders would only
        # warn about unset variables on every worker.
        user.pop("telegram_topic_high", None)
        user.pop("telegram_topic_medium", None)
        user.pop("telegram_topic_low", None)
        # The alert-message report rides the Telegram send path, which workers
        # do not have; same reasoning as the topic ids above.
        user.pop("alert_report_url", None)
        user.pop("alert_report_token", None)
        user.pop("alert_report_worker_id", None)
        user["notify_with"] = ["coordinator"]

    return config


def write_worker_config(config: Dict[str, Any], path: Path, worker_id: str) -> None:
    region = next(iter(config.get("region", {})), "?")
    cities = ", ".join(config.get("region", {}).get(region, {}).get("search_city", []))
    path.parent.mkdir(parents=True, exist_ok=True)
    body = tomli_w.dumps(config)
    header = GENERATED_HEADER.format(worker_id=worker_id, region=region, cities=cities)
    path.write_text(f"{header}\n{body}")


def check_region_overlap(master: Dict[str, Any], fleet: Dict[str, Any]) -> List[str]:
    """Report cities covered by more than one worker.

    Overlap is not fatal — the coordinator dedupes — but it wastes worker time,
    so it is worth surfacing.
    """
    seen: Dict[str, str] = {}
    warnings: List[str] = []
    for worker_id, worker in fleet.get("worker", {}).items():
        region = worker.get("region")
        cities = master.get("region", {}).get(region, {}).get("search_city", [])
        for city in cities:
            if city in seen:
                warnings.append(
                    f"City '{city}' is covered by both {seen[city]} and {worker_id}."
                )
            else:
                seen[city] = worker_id
    return warnings


def check_region_coverage(master: Dict[str, Any], fleet: Dict[str, Any]) -> List[str]:
    """Report cities the fleet's regions leave out of the phase-1 city list.

    Unlike overlap, this one is not cosmetic. Coverage comes from the city list
    and nothing else — a metro with no search_city entry of its own is invisible
    no matter how wide the radius on a neighbouring centre, which is how a
    Louisville listing at rank 1 went unseen for four days behind a columbus
    search 189 miles away. `[marketplace.facebook].search_city` is the curated,
    measured list; a region set that does not cover it silently searches less
    than the single-machine config it replaced.
    """
    phase1 = master.get("marketplace", {}).get("facebook", {}).get("search_city", []) or []
    regions = master.get("region", {})

    assigned: Dict[str, str] = {}
    for worker_id, worker in fleet.get("worker", {}).items():
        for city in regions.get(worker.get("region"), {}).get("search_city", []):
            assigned.setdefault(city, worker_id)

    missing = [city for city in phase1 if city not in assigned]
    if not missing:
        return []
    return [
        f"{len(missing)} city/cities in [marketplace.facebook].search_city are not "
        f"searched by any worker: {', '.join(missing)}. Add each to a [region.*] "
        "block in master.toml — a metro with no search_city entry is invisible."
    ]


def generate_all(
    master_path: Path, fleet_path: Path, output_dir: Path
) -> List[Path]:
    master = load_toml(master_path)
    fleet = load_toml(fleet_path)
    written: List[Path] = []
    for worker_id, worker in fleet.get("worker", {}).items():
        config = build_worker_config(master, worker_id, worker)
        out_path = output_dir / f"worker-{worker_id}.toml"
        write_worker_config(config, out_path, worker_id)
        written.append(out_path)
    return written
