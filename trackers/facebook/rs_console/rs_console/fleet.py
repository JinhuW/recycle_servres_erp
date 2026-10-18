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

What never leaves here: credentials of any kind (a proxy's login, API keys,
tokens) and the AI prompt (that has its own route). A proxy leaves as the name
of its env var and, once app.py has resolved it, as its URL with the login cut
out (`public_proxy_url`) plus where it exits (proxy_exit.py). A config value
that is not a `${VAR}` placeholder is dropped rather than exposed, so a proxy
pasted inline by mistake cannot reach the browser.
"""

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

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

# The zone a region's day is counted in: where its cities' sellers live, which
# is when its sweep is "today". A region spanning two zones takes the one most
# of its centres sit in. `start_at` is pinned to Eastern (see master.toml), so
# that is the default for anything not listed — the phase-1 monitor included.
REGION_TIMEZONES = {
    "rs_northeast": "America/New_York",
    "rs_southeast": "America/New_York",
    "rs_midwest": "America/Chicago",
    "rs_south_central": "America/Chicago",
    "rs_mountain": "America/Denver",
    "rs_west": "America/Los_Angeles",
}
DEFAULT_TIMEZONE = "America/New_York"

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


# Which env vars hold a worker's proxy login, as its config names them. Only
# app.py reads them, to dial the proxy; apply_proxies drops them.
_NO_PROXY_LOGIN = {"proxy_user_env": None, "proxy_pass_env": None}


def public_proxy_url(raw: Optional[str]) -> Optional[str]:
    """`scheme://host:port` of a proxy URL, without any login written into it."""
    if not raw:
        return None
    try:
        parts = urlsplit(raw.strip())
        port = parts.port
    except ValueError:
        return None
    if not parts.scheme or not parts.hostname:
        return None
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    return f"{parts.scheme}://{host}" + (f":{port}" if port else "")


def proxy_targets(
    doc: Dict[str, Any], environ: Dict[str, str]
) -> Dict[str, Tuple[Optional[str], Optional[str], Optional[str]]]:
    """Each worker's proxy as its process dials it: (URL, username, password),
    all None for one on the VM's own IP. An env var named but unset is no
    proxy, which is what the monitor makes of it too."""
    def read(name: Optional[str]) -> Optional[str]:
        if not name:
            return None
        return (environ.get(name) or "").strip() or None

    out = {}
    for worker in doc["workers"]:
        url = read(worker.get("proxy_env"))
        user, password = read(worker.get("proxy_user_env")), read(worker.get("proxy_pass_env"))
        out[worker["worker_id"]] = (url, user, password) if url else (None, None, None)
    return out


def apply_proxies(
    doc: Dict[str, Any],
    targets: Dict[str, Tuple[Optional[str], Optional[str], Optional[str]]],
    exits: Dict[Tuple[Optional[str], Optional[str], Optional[str]], Dict[str, Any]],
) -> None:
    """Set each worker's `proxy`: the URL it dials, login cut out (None on the
    VM's own IP), and where it exits — ip, city, region, country, org, or
    `error` / `pending`."""
    for worker in doc["workers"]:
        for key in _NO_PROXY_LOGIN:
            worker.pop(key, None)
        target = targets.get(worker["worker_id"])
        if target is None:
            continue
        worker["proxy"] = {"url": public_proxy_url(target[0]), **exits.get(target, {"pending": True})}


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
                **_NO_PROXY_LOGIN,
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
    monitor_block = monitor.get("monitor") or {}
    proxy_env = env_name(monitor_block.get("proxy_server"))
    return {
        "worker_id": worker_id,
        "source": "monitor",
        "region": region,
        "cities": city_list,
        "session_file": None,
        "proxy_env": proxy_env,
        "proxy_user_env": env_name(monitor_block.get("proxy_username")),
        "proxy_pass_env": env_name(monitor_block.get("proxy_password")),
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


def describe_from_config(
    worker: Dict[str, Any], config: Dict[str, Any], region_list: List[Dict[str, Any]]
) -> None:
    """Describe `worker` from the config it actually runs, which is the only
    place its cities live once they are edited per worker."""
    described = monitor_worker(config, worker["worker_id"], region_list)
    for key in ("region", "cities", "proxy_env", *_NO_PROXY_LOGIN, "pacing"):
        worker[key] = described[key]
    worker["cities_editable"] = True


def region_timezone(region_key: Optional[str]) -> str:
    return REGION_TIMEZONES.get(region_key or "", DEFAULT_TIMEZONE)


def search_plan(
    item_list: List[Dict[str, Any]], city_count: int, start_at: Any
) -> Dict[str, Any]:
    """How many searches a worker owes a day: every enabled phrase in every
    one of its cities, once per `start_at` time.

    `per_day` is None when the schedule is not a list of times (an interval
    loop has no daily budget) or there is nothing to search.
    """
    phrases = sum(len(i.get("search_phrases") or []) for i in item_list if i.get("enabled", True))
    runs = len(start_at) if isinstance(start_at, list) and start_at else None
    per_day = phrases * city_count * runs if runs and phrases and city_count else None
    return {"phrases": phrases, "cities": city_count, "runs_per_day": runs, "per_day": per_day}


def apply_tiers(doc: Dict[str, Any], ranked: Dict[str, Any]) -> None:
    """Mark each worker's cities with how often the coordinator has them
    searched (`per_day`, `pin`, `score`), and recount the daily budget.

    A worker's `start_at` times are its slots, so a city ranked above them is
    searched once per slot and no more; with one time everything is once a
    day, which is what the budget then says.
    """
    by_worker = ranked.get("workers") or {}
    for worker in doc["workers"]:
        rows = {r["slug"]: r for r in by_worker.get(worker["worker_id"]) or []}
        if not rows:
            continue
        for city in worker["cities"]:
            row = rows.get(city["slug"])
            if row:
                city.update(per_day=row["per_day"], pin=row["pin"], score=row["score"])
        plan = worker["plan"]
        runs = plan["runs_per_day"]
        if runs and plan["per_day"]:
            plan["per_day"] = plan["phrases"] * sum(
                min(c.get("per_day", runs), runs) for c in worker["cities"]
            )
    doc["city_tiers"] = ranked.get("settings")


def _parse_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def worker_today(
    worker_id: str,
    zone: str,
    cycle_rows: Optional[List[Dict[str, Any]]],
    review_rows: Optional[List[Dict[str, Any]]],
    now: datetime,
    city_rows: Optional[List[Dict[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    """This worker's local day so far. None when the coordinator served
    neither of the two inputs.

    `cycle_rows` are the coordinator's search cycles: when the worker started
    on an item, which is where a sweep begins. `review_rows` are its per-worker
    funnel counters: searches done, listings freshly reviewed (the new posts)
    and alerted, with `updated_at` — the latest search page counted, so the
    sweep's latest activity. `city_rows` say when it last searched each city;
    `cities` is the ones searched today, or None when they were not served.

    Counters are kept per UTC day. The daily sweep runs inside UTC daytime in
    every US zone, so the row dated with the local date is the one holding
    today's sweep.

    `searches` is None, not 0, for a worker with no searches counted in the
    window fetched: its monitor predates the funnel counters, and "0 searched"
    would read as a worker doing nothing.
    """
    if cycle_rows is None and review_rows is None:
        return None
    try:
        tz = ZoneInfo(zone)
    except ZoneInfoNotFoundError:
        tz = timezone.utc
    local_now = now.astimezone(tz)
    day = local_now.date().isoformat()
    day_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)

    def today_stamp(value: Any) -> Optional[datetime]:
        at = _parse_time(value)
        return at if at is not None and day_start <= at <= now + timedelta(minutes=5) else None

    starts = [
        at for r in cycle_rows or []
        if r.get("worker_id") == worker_id and (at := today_stamp(r.get("at"))) is not None
    ]

    mine = [r for r in review_rows or [] if r.get("worker_id") == worker_id]
    row = next((r for r in mine if r.get("day") == day), None)
    counts = lambda name: int((row or {}).get(name) or 0)
    reports_searches = any(int(r.get("searches") or 0) > 0 for r in mine)
    moved = today_stamp((row or {}).get("updated_at"))

    stamps = starts + ([moved] if moved else [])
    return {
        "day": day,
        "first_at": _stamp(min(stamps)) if stamps else None,
        "last_at": _stamp(max(stamps)) if stamps else None,
        "cycles": len(starts) if cycle_rows is not None else None,
        "searches": counts("searches") if reports_searches else None,
        "posts": counts("reviewed") if review_rows is not None else None,
        "alerts": counts("alerted") if review_rows is not None else None,
        "cities": None if city_rows is None else [
            str(r.get("city")) for r in city_rows
            if r.get("worker_id") == worker_id and today_stamp(r.get("last_at")) is not None
        ],
    }


def known_worker_ids(
    fleet: Optional[Dict[str, Any]],
    monitor_worker_id: Optional[str],
    health_rows: Optional[List[Dict[str, Any]]],
    worker_configs: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[str]:
    """Every worker id the document will carry a row for, config or live."""
    ids: List[str] = []
    if monitor_worker_id:
        ids.append(monitor_worker_id)
    for worker_id in [*((fleet or {}).get("worker") or {}), *(worker_configs or {})]:
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
    "fb_uid",
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
    worker_configs: Optional[Dict[str, Dict[str, Any]]] = None,
    health_error: Optional[str] = None,
    accounts: Optional[List[Dict[str, Any]]] = None,
    sessions: Optional[Dict[str, Dict[str, Any]]] = None,
    versions: Optional[Dict[str, Optional[str]]] = None,
    vnc_pages: Optional[Dict[str, str]] = None,
    search_cycles: Optional[List[Dict[str, Any]]] = None,
    worker_reviews: Optional[List[Dict[str, Any]]] = None,
    search_cities: Optional[List[Dict[str, Any]]] = None,
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

    `search_cycles`, `worker_reviews` and `search_cities` are the
    coordinator's search cycles, per-worker funnel rows and last search per
    city; each worker's `today` is cut from them in its region's zone
    (`timezone`), and `plan` is its daily search budget.

    `worker_configs` maps a worker id to the config it runs. Such a worker
    is described from that file rather than from fleet.toml's region, and is
    `cities_editable`; one no other source knows gets a row of its own.

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
    for worker in workers:
        worker["cities_editable"] = False

    by_id = {w["worker_id"]: w for w in workers}
    for worker_id, config in (worker_configs or {}).items():
        target = by_id.get(worker_id)
        if target is None:
            target = monitor_worker(config, worker_id, region_list)
            target["source"] = "config"
            workers.append(target)
            by_id[worker_id] = target
        describe_from_config(target, config, region_list)

    # A row the coordinator knows that no config describes is still a real
    # process somewhere — surface it rather than drop it.
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
                **_NO_PROXY_LOGIN,
                "pacing": {"search_interval": None, "max_search_interval": None, "overridden": False},
                "vnc_url": row.get("vnc_url"),
                "health": None,
                "account": None,
                "session": None,
                "cities_editable": False,
            }
            workers.append(target)
            by_id[worker_id] = target
        target["health"] = row

    moment = now or datetime.now(timezone.utc)
    item_list = items(master) or (items(monitor) if monitor else [])
    settings = search_settings(master) or (search_settings(monitor) if monitor else {})

    by_worker = {
        str(a.get("worker_id")): a for a in (accounts or []) if a.get("worker_id")
    }
    for worker in workers:
        zone = region_timezone(worker["region"].get("key"))
        worker["timezone"] = zone
        worker["plan"] = search_plan(item_list, len(worker["cities"]), settings.get("start_at"))
        worker["today"] = worker_today(
            worker["worker_id"], zone, search_cycles, worker_reviews, moment, search_cities
        )
        worker["account"] = _pick(by_worker.get(worker["worker_id"]), ACCOUNT_KEYS)
        worker["session"] = _pick((sessions or {}).get(worker["worker_id"]), SESSION_KEYS)
        page = (vnc_pages or {}).get(worker["worker_id"])
        worker["vnc_url"] = page or worker.get("vnc_url")
        # Whether the console itself can show this browser, as opposed to a
        # link someone wrote in config; the dashboard labels the two apart.
        worker["vnc_live"] = bool(page)

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
        "search": settings,
        "items": item_list,
        "regions": region_list,
        "workers": workers,
    }
