"""Compose the fleet view: who searches where, for what, and how they are doing.

The dashboard's one question — "which account is searching which cities for
which phrases, and is it alive?" — has its answer spread across three files
and one database:

    configs/fleet.toml     which worker is pinned to which region, its proxy
                           env var, its session file, its pacing overrides
    configs/master.toml    the regions (city lists), the items (search
                           phrases, keyword gates), the shared search settings
    configs/homelab.toml   the phase-1 monitor's own city list, which is what
                           actually runs today (the six sharded workers are
                           configured but not yet deployed)
    coordinator /v1/workers  liveness, state, session expiry per worker

This module joins them into one document. It is pure: it takes parsed TOML
and the coordinator's rows and returns a dict, so it can be tested without a
filesystem or an HTTP client. The router in app.py does the reading.

What never leaves here: proxy URLs (only the *name* of the env var that holds
one), API keys, tokens, and the AI prompt (that has its own route). A config
value that is not a `${VAR}` placeholder is dropped rather than exposed, so a
proxy pasted inline by mistake cannot reach the browser.
"""

import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

_PLACEHOLDER = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")

# Fleet-wide search settings worth showing. Listed rather than dumped, because
# the same table also holds the prompt (its own route) and credentials.
SEARCH_SETTING_KEYS = (
    "start_at",
    "rating",
    "min_unit_count",
    "min_seller_rating",
    "exclude_unrated_sellers",
    "date_listed",
    "delivery_method",
    "max_results",
    "title_prefilter",
    "search_interval",
    "max_search_interval",
    "currency",
)

ITEM_KEYS = (
    "search_phrases",
    "keywords",
    "antikeywords",
    "description",
    "min_price",
    "max_price",
)


def env_name(value: Any) -> Optional[str]:
    """The env var a `${VAR}` placeholder names, or None for anything else.

    Sharded configs write proxies as `["${PROXY_WEST}"]` and the phase-1
    config as `"${PROXY_HOMELAB}"`; both forms are accepted. A literal value
    is *not* returned — that would be the proxy itself.
    """
    if isinstance(value, list):
        value = value[0] if value else None
    if not isinstance(value, str):
        return None
    match = _PLACEHOLDER.match(value.strip())
    return match.group(1) if match else None


def cities(block: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Zip a config block's search_city / city_name / radius into one list.

    The three arrays are index-aligned by convention. A missing name falls
    back to the slug and a missing radius to None rather than truncating the
    list — a city with no display name is still searched.
    """
    slugs = [str(s) for s in block.get("search_city") or []]
    names = block.get("city_name") or []
    radii = block.get("radius") or []
    out: List[Dict[str, Any]] = []
    for i, slug in enumerate(slugs):
        name = names[i] if i < len(names) and names[i] else slug
        radius = radii[i] if i < len(radii) else None
        out.append({"slug": slug, "name": str(name), "radius_km": radius})
    return out


def regions(master: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for key, block in (master.get("region") or {}).items():
        if not isinstance(block, dict):
            continue
        out.append(
            {
                "key": key,
                "name": str(block.get("full_name") or key),
                "cities": cities(block),
            }
        )
    return out


def items(master: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for name, block in (master.get("item") or {}).items():
        if not isinstance(block, dict):
            continue
        row: Dict[str, Any] = {"name": name, "enabled": bool(block.get("enabled", True))}
        for key in ITEM_KEYS:
            if key in block:
                row[key] = block[key]
        row.setdefault("search_phrases", [])
        row.setdefault("keywords", [])
        row.setdefault("antikeywords", [])
        out.append(row)
    return out


def search_settings(master: Dict[str, Any]) -> Dict[str, Any]:
    facebook = (master.get("marketplace") or {}).get("facebook") or {}
    return {key: facebook[key] for key in SEARCH_SETTING_KEYS if key in facebook}


def ai_model(master: Dict[str, Any]) -> Optional[str]:
    for table in (master.get("ai") or {}).values():
        if isinstance(table, dict) and table.get("model"):
            return str(table["model"])
    return None


def _match_region(slugs: Iterable[str], region_list: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Name the region a city list corresponds to, if any.

    The phase-1 monitor is the odd one out: it searches
    `[marketplace.facebook].search_city` directly, which today is the
    southeast list during a ramp and at other times all 127 centres. Matching
    it to a region gives the dashboard something better to say than
    "custom list of 28".
    """
    wanted = set(slugs)
    if not wanted:
        return {"key": None, "name": "No cities", "scope": "empty"}
    for region in region_list:
        have = {c["slug"] for c in region["cities"]}
        if have == wanted:
            return {"key": region["key"], "name": region["name"], "scope": "region"}
    everything = {c["slug"] for region in region_list for c in region["cities"]}
    if everything and wanted == everything:
        return {"key": None, "name": "All regions", "scope": "all"}
    for region in region_list:
        have = {c["slug"] for c in region["cities"]}
        if have and wanted <= have:
            return {"key": region["key"], "name": f"Part of {region['name']}", "scope": "subset"}
    return {"key": None, "name": "Custom list", "scope": "custom"}


def fleet_workers(
    fleet: Dict[str, Any], master: Dict[str, Any], region_list: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    by_key = {r["key"]: r for r in region_list}
    settings = search_settings(master)
    out: List[Dict[str, Any]] = []
    for worker_id, block in (fleet.get("worker") or {}).items():
        if not isinstance(block, dict):
            continue
        region = by_key.get(block.get("region"))
        proxy_env = block.get("proxy_env") or None
        out.append(
            {
                "worker_id": worker_id,
                "source": "fleet",
                "region": {
                    "key": block.get("region"),
                    "name": region["name"] if region else f"Unknown region {block.get('region')!r}",
                    "scope": "region" if region else "missing",
                },
                "cities": region["cities"] if region else [],
                "session_file": block.get("session") or None,
                "proxy_env": proxy_env,
                "pacing": {
                    "search_interval": block.get("search_interval") or settings.get("search_interval"),
                    "max_search_interval": block.get("max_search_interval")
                    or settings.get("max_search_interval"),
                    "overridden": "search_interval" in block or "max_search_interval" in block,
                },
                "vnc_url": block.get("vnc_url") or None,
                "health": None,
                "account": None,
                "session": None,
            }
        )
    return out


def monitor_worker(
    monitor: Dict[str, Any], worker_id: str, region_list: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """The phase-1 single-machine monitor, described from its own config."""
    facebook = (monitor.get("marketplace") or {}).get("facebook") or {}
    city_list = cities(facebook)
    region = _match_region((c["slug"] for c in city_list), region_list)
    proxy_env = env_name((monitor.get("monitor") or {}).get("proxy_server"))
    return {
        "worker_id": worker_id,
        "source": "monitor",
        "region": region,
        "cities": city_list,
        "session_file": None,
        "proxy_env": proxy_env,
        "pacing": {
            "search_interval": facebook.get("search_interval"),
            "max_search_interval": facebook.get("max_search_interval"),
            "overridden": False,
        },
        "vnc_url": facebook.get("vnc_url") or None,
        "health": None,
        "account": None,
        "session": None,
    }


def known_worker_ids(
    fleet: Optional[Dict[str, Any]],
    monitor_worker_id: Optional[str],
    health_rows: Optional[List[Dict[str, Any]]],
) -> List[str]:
    """Every worker id the document will carry a row for, config or live."""
    ids: List[str] = []
    if monitor_worker_id:
        ids.append(monitor_worker_id)
    for worker_id in ((fleet or {}).get("worker") or {}):
        if worker_id not in ids:
            ids.append(str(worker_id))
    for row in health_rows or []:
        worker_id = str(row.get("worker_id") or "")
        if worker_id and worker_id not in ids:
            ids.append(worker_id)
    return ids


# The account row as the dashboard may see it. Listed rather than splatted so
# a field added to the coordinator's view later is a decision here, not a leak.
ACCOUNT_KEYS = (
    "account_id",
    "fb_username",
    "region",
    "vnc_url",
    "allow_password_login",
    "proxy_configured",
    "secrets",
)
SESSION_KEYS = ("account_id", "fb_user_id", "user_agent", "session_expiry", "backed_up_at")


def _pick(row: Optional[Dict[str, Any]], keys: Iterable[str]) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    return {key: row.get(key) for key in keys}


def compose(
    *,
    master: Optional[Dict[str, Any]],
    fleet: Optional[Dict[str, Any]],
    monitor: Optional[Dict[str, Any]],
    monitor_worker_id: Optional[str],
    health_rows: Optional[List[Dict[str, Any]]],
    health_error: Optional[str] = None,
    accounts: Optional[List[Dict[str, Any]]] = None,
    sessions: Optional[Dict[str, Dict[str, Any]]] = None,
    versions: Optional[Dict[str, Optional[str]]] = None,
    vnc_pages: Optional[Dict[str, str]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Join config and health into the document the dashboard renders.

    Every input is optional so a partially mounted facade still answers: a
    console with only the monitor config mounted shows that one worker, and a
    coordinator outage leaves every `health` null with `health.error` set
    instead of failing the whole page. The dashboard decides what to badge.

    `accounts` is the vault's non-secret account list (joined to a worker by
    its `worker_id`), `sessions` the per-worker session metadata keyed by
    worker id. Both become `account` / `session` on the worker row, or None.

    `vnc_pages` maps a worker id to the console's own viewer page for it
    (see vnc.py). It wins over a `vnc_url` from config: the console page is
    the one link known to open from this dashboard without a tunnel, and a
    config value is kept only as the fallback for workers the console cannot
    reach.
    """
    master = master or {}
    region_list = regions(master)

    workers: List[Dict[str, Any]] = []
    if monitor:
        workers.append(monitor_worker(monitor, monitor_worker_id or "monitor", region_list))
    if fleet:
        workers.extend(fleet_workers(fleet, master, region_list))

    # A row the coordinator knows that no config describes is still a real
    # process somewhere — surface it rather than drop it.
    by_id = {w["worker_id"]: w for w in workers}
    for row in health_rows or []:
        worker_id = str(row.get("worker_id") or "")
        if not worker_id:
            continue
        target = by_id.get(worker_id)
        if target is None:
            target = {
                "worker_id": worker_id,
                "source": "unconfigured",
                "region": {"key": None, "name": row.get("region") or "Unknown", "scope": "unknown"},
                "cities": [],
                "session_file": None,
                "proxy_env": None,
                "pacing": {"search_interval": None, "max_search_interval": None, "overridden": False},
                "vnc_url": row.get("vnc_url"),
                "health": None,
                "account": None,
                "session": None,
            }
            workers.append(target)
            by_id[worker_id] = target
        target["health"] = row

    by_worker = {
        str(a.get("worker_id")): a for a in (accounts or []) if a.get("worker_id")
    }
    for worker in workers:
        worker["account"] = _pick(by_worker.get(worker["worker_id"]), ACCOUNT_KEYS)
        worker["session"] = _pick((sessions or {}).get(worker["worker_id"]), SESSION_KEYS)
        page = (vnc_pages or {}).get(worker["worker_id"])
        worker["vnc_url"] = page or worker.get("vnc_url")
        # Whether the console itself can show this browser, as opposed to a
        # link someone wrote in config; the dashboard labels the two apart.
        worker["vnc_live"] = bool(page)

    moment = now or datetime.now(timezone.utc)
    return {
        "generated_at": moment.isoformat().replace("+00:00", "Z"),
        "monitor_worker_id": monitor_worker_id,
        "sources": {
            "master": bool(master),
            "fleet": bool(fleet),
            "monitor": bool(monitor),
        },
        "health": {"ok": health_error is None, "error": health_error},
        # Builds of the two control-plane services; each worker's own build
        # rides on its health row (`health.version`).
        "versions": {"console": None, "coordinator": None, **(versions or {})},
        "ai_model": ai_model(master) or (ai_model(monitor) if monitor else None),
        "search": search_settings(master) or (search_settings(monitor) if monitor else {}),
        "items": items(master) or (items(monitor) if monitor else []),
        "regions": region_list,
        "workers": workers,
    }
