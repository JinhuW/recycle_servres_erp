"""The search settings the ERP may change, saved as an overlay on master.toml.

master.toml is tracked in git and every deploy rsyncs it, so a value written
there from the ERP would be put back by the next deploy. Saved values live in
a JSON file on the console's own volume instead (RS_SETTINGS_STATE), and are
written into each worker's config (RS_WORKER_CONFIGS) on save and again by
every deploy (`render`). master.toml stays the default for anything never
saved.

Only the keys listed here can change. One worker's cities can change too
(`workers.<id>.cities`), because a worker with its own proxy and account
searches its own cities. So can its sweep times (`workers.<id>.start_at`,
from the CLI only): two accounts on one IP that start in the same minute
every day read as one operator. Proxies, credentials, notification targets
and the session path are not reachable from this module, which is what keeps
the console's token from being a way to point a worker at another account or
another chat.

RS_WORKER_CONFIGS names each config `worker_id=path`, so a worker's cities go
into its own file and nowhere else. A bare path still works, and takes the
fleet-wide values only.

A worker the fleet runs (rs-fleetd) has no file here: its agent fetches its
config from the coordinator. Those configs are read and written there instead
(`FleetConfigs`), rendered exactly like a mounted one.

Worker configs are single-file bind mounts. Docker binds the inode, so a file
replaced by rename stays invisible to a running container: they are rewritten
in place. The vendored monitor hashes its config between jobs and restarts
them on a change, which also runs a sweep straight away.

    python -m rs_console.settings apply     write the saved values into every worker config
    python -m rs_console.settings render [--config homelab-x.toml]
                                            stdin config -> stdout, saved values applied
                                            (and that file's worker's cities)
    python -m rs_console.settings publish [worker_id ...]
                                            hand mounted workers' configs to the fleet
    python -m rs_console.settings start-at <worker_id> HH:MM [...] | --clear
                                            one worker's own sweep times (UTC), or
                                            back to the fleet's
"""

import copy
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
import tomlkit
from tomlkit.items import Item

DEFAULT_STATE = "/state/settings.json"

# What Facebook's own filters accept (the vendored monitor's DateListed and
# DeliveryMethod enums).
DATE_LISTED = ("all", "last 24 hours", "last 7 days", "last 30 days")
DELIVERY_METHODS = ("all", "local_pick_up", "shipping")

# start_at forms the monitor's scheduler accepts: HH:MM[:SS], *:MM, *:*:SS. UTC.
_START_AT = re.compile(r"^(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?|\*:[0-5]\d|\*:\*:[0-5]\d)$")
_DURATION = re.compile(r"^(\d+)([smhd])$")
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$")

MAX_RULE = 500
MAX_RULES = 100
MAX_PROMPT = 20_000
MAX_CITIES = 200
MAX_CITY_NAME = 80

# The monitor's own rule for a Marketplace location: a slug or numeric id,
# lowercase letters and digits with `_` and `-`.
_CITY_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_WORKER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class SettingsError(ValueError):
    """A value the monitor would reject or misread; the message names it."""


def _int(lo: int, hi: int) -> Callable[[str, Any], int]:
    def check(key: str, value: Any) -> int:
        # bool is an int to Python and never what was meant.
        if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
            raise SettingsError(f"{key} must be a whole number from {lo} to {hi}")
        return value

    return check


def _bool(key: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise SettingsError(f"{key} must be true or false")
    return value


def _choice(options: tuple) -> Callable[[str, Any], str]:
    def check(key: str, value: Any) -> str:
        if value not in options:
            raise SettingsError(f"{key} must be one of: {', '.join(options)}")
        return value

    return check


def _seller_rating(key: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 5:
        raise SettingsError(f"{key} must be a number from 0 to 5")
    return float(value)


def _duration(key: str, value: Any) -> str:
    if not isinstance(value, str) or not _DURATION.match(value.strip()):
        raise SettingsError(f"{key} must be a number and a unit, like 45m or 2h")
    return value.strip()


def _start_at(key: str, value: Any) -> List[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 24:
        raise SettingsError(f"{key} must list 1 to 24 times")
    out = []
    for t in value:
        if not isinstance(t, str) or not _START_AT.match(t.strip()):
            raise SettingsError(f"{key}: {t!r} is not a time like 10:00 (UTC)")
        out.append(t.strip())
    return out


def _prompt(key: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_PROMPT:
        raise SettingsError(f"{key} must be text of 1 to {MAX_PROMPT} characters")
    # Trailing whitespace only: a prompt's own indentation and blank lines are content.
    return value.rstrip()


SEARCH_FIELDS: Dict[str, Callable[[str, Any], Any]] = {
    "start_at": _start_at,
    "date_listed": _choice(DATE_LISTED),
    "delivery_method": _choice(DELIVERY_METHODS),
    "max_results": _int(1, 1000),
    "search_interval": _duration,
    "max_search_interval": _duration,
    "title_prefilter": _bool,
    "min_seller_rating": _seller_rating,
    "exclude_unrated_sellers": _bool,
    "rating": _int(1, 5),
    "min_unit_count": _int(1, 10_000),
    "prompt": _prompt,
    "rating_prompt": _prompt,
}

ITEM_FIELDS = ("search_phrases", "keywords", "antikeywords")


def _rules(key: str, value: Any, required: bool) -> List[str]:
    if not isinstance(value, list) or len(value) > MAX_RULES:
        raise SettingsError(f"{key} must be a list of at most {MAX_RULES} entries")
    out: List[str] = []
    for rule in value:
        if not isinstance(rule, str) or len(rule) > MAX_RULE:
            raise SettingsError(f"{key}: each entry must be text of at most {MAX_RULE} characters")
        rule = rule.strip()
        if rule and rule not in out:
            out.append(rule)
    if required and not out:
        raise SettingsError(f"{key} needs at least one entry")
    return out


def _seconds(duration: str) -> int:
    match = _DURATION.match(duration)
    assert match
    return int(match.group(1)) * _UNIT_SECONDS[match.group(2)]


def validate(body: Any, item_names: List[str], saved: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The patch `body` asks for, normalised; SettingsError on anything off.

    `saved` is what is already in effect (master + saved values), so a lone
    interval can still be checked against its partner.
    """
    if not isinstance(body, dict):
        raise SettingsError("Expected a JSON object")
    unknown = set(body) - {"search", "ai_model", "items", "updated_by"}
    if unknown:
        raise SettingsError(f"Not a setting: {', '.join(sorted(unknown))}")

    patch: Dict[str, Any] = {}
    search = body.get("search")
    if search is not None:
        if not isinstance(search, dict):
            raise SettingsError("search must be an object")
        bad = set(search) - set(SEARCH_FIELDS)
        if bad:
            raise SettingsError(f"Not an editable search setting: {', '.join(sorted(bad))}")
        patch["search"] = {k: SEARCH_FIELDS[k](k, v) for k, v in search.items()}
        effective = {**((saved or {}).get("search") or {}), **patch["search"]}
        low, high = effective.get("search_interval"), effective.get("max_search_interval")
        if isinstance(low, str) and isinstance(high, str) and _DURATION.match(low) and _DURATION.match(high):
            if _seconds(high) < _seconds(low):
                raise SettingsError("max_search_interval must not be shorter than search_interval")

    if "ai_model" in body:
        model = body["ai_model"]
        if not isinstance(model, str) or not _MODEL.match(model.strip()):
            raise SettingsError("ai_model must be a model id like openai/gpt-5.6-luna")
        patch["ai_model"] = model.strip()

    items = body.get("items")
    if items is not None:
        if not isinstance(items, dict):
            raise SettingsError("items must be an object")
        patch["items"] = {}
        for name, fields in items.items():
            if name not in item_names:
                raise SettingsError(f"No item named {name!r} in master.toml")
            if not isinstance(fields, dict) or set(fields) - set(ITEM_FIELDS):
                raise SettingsError(f"{name}: only {', '.join(ITEM_FIELDS)} can be edited")
            patch["items"][name] = {
                k: _rules(f"{name}.{k}", v, required=k == "search_phrases") for k, v in fields.items()
            }
    if not patch:
        raise SettingsError("Nothing to save")
    return patch


def validate_cities(body: Any) -> List[Dict[str, Any]]:
    """One worker's city list, normalised; SettingsError on anything off.

    Any Marketplace location is accepted, not only master.toml's regions: a
    worker added beside a full fleet needs cities nobody else searches.
    """
    if not isinstance(body, dict) or set(body) - {"cities", "updated_by"}:
        raise SettingsError("Expected an object with cities")
    value = body.get("cities")
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_CITIES:
        # The monitor refuses a config with no city at all.
        raise SettingsError(f"cities must list 1 to {MAX_CITIES} cities")
    out: List[Dict[str, Any]] = []
    for city in value:
        if not isinstance(city, dict) or set(city) - {"slug", "name", "radius"}:
            raise SettingsError("each city is {slug, name, radius}")
        slug = city.get("slug").strip().lower() if isinstance(city.get("slug"), str) else ""
        if not _CITY_SLUG.match(slug):
            raise SettingsError(
                f"{city.get('slug')!r} is not a Marketplace location: use the part after "
                "/marketplace/ in a search URL (lowercase letters, digits, _ and -)"
            )
        if any(c["slug"] == slug for c in out):
            raise SettingsError(f"{slug} is listed twice")
        name = city.get("name").strip() if isinstance(city.get("name"), str) else ""
        if not name or len(name) > MAX_CITY_NAME:
            raise SettingsError(f"{slug}: name must be text of 1 to {MAX_CITY_NAME} characters")
        radius = _int(1, 500)(f"{slug}: radius", city.get("radius"))
        out.append({"slug": slug, "name": name, "radius": radius})
    return out


def merge(values: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    out = copy.deepcopy(values)
    if "search" in patch:
        out.setdefault("search", {}).update(patch["search"])
    if "ai_model" in patch:
        out["ai_model"] = patch["ai_model"]
    for name, fields in (patch.get("items") or {}).items():
        out.setdefault("items", {}).setdefault(name, {}).update(fields)
    for worker_id, fields in (patch.get("workers") or {}).items():
        out.setdefault("workers", {}).setdefault(worker_id, {}).update(fields)
    return out


# ── The saved file ─────────────────────────────────────────────────────────────


def state_path() -> Path:
    return Path(os.environ.get("RS_SETTINGS_STATE", "").strip() or DEFAULT_STATE)


def load(path: Optional[Path] = None) -> Dict[str, Any]:
    """The saved state, or an empty one. A corrupt file is an error, not empty:
    reading it as empty would make the next deploy silently drop every value."""
    path = path or state_path()
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"values": {}, "updated_at": None, "updated_by": None}
    if not isinstance(state, dict) or not isinstance(state.get("values"), dict):
        raise SettingsError(f"{path} is not a settings file")
    return state


def save(state: Dict[str, Any], path: Optional[Path] = None) -> None:
    # This file is not bind-mounted on its own, so an atomic rename is safe here.
    path = path or state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".settings-")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(tmp, path)


def stamp(values: Dict[str, Any], by: Optional[str]) -> Dict[str, Any]:
    return {
        "values": values,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "updated_by": by,
    }


Target = Tuple[Optional[str], Path]


def targets() -> List[Target]:
    """Every worker config as (worker id or None, path)."""
    raw = os.environ.get("RS_WORKER_CONFIGS", "").strip()
    if not raw:
        monitor = os.environ.get("RS_MONITOR_CONFIG", "").strip()
        return [(None, Path(monitor))] if monitor else []
    out: List[Target] = []
    for entry in (e.strip() for e in raw.split(",")):
        if not entry:
            continue
        worker_id, sep, path = entry.partition("=")
        if sep and _WORKER_ID.match(worker_id.strip()):
            out.append((worker_id.strip(), Path(path.strip())))
        else:
            out.append((None, Path(entry)))
    return out


def worker_configs() -> List[Path]:
    return [path for _, path in targets()]


def config_for(worker_id: str) -> Optional[Path]:
    return next((path for wid, path in targets() if wid == worker_id), None)


def writable(fleet: bool = False) -> bool:
    """Whether a save could land: the state directory and every mounted worker
    config are writable, and there is a config to write (a mounted one, or the
    fleet's). An older compose mounts them read-only."""
    configs = worker_configs()
    state_dir = state_path().parent
    return (
        (bool(configs) or fleet)
        and state_dir.is_dir()
        and os.access(state_dir, os.W_OK)
        and all(p.is_file() and os.access(p, os.W_OK) for p in configs)
    )


class FleetError(OSError):
    """The coordinator could not be asked for, or did not take, a fleet config."""


class FleetConfigs:
    """The configs of the workers the fleet runs, kept by the coordinator."""

    def __init__(self, base_url: str, headers: Dict[str, str], timeout: float = 10.0) -> None:
        self._base_url = base_url
        self._headers = headers
        self._timeout = timeout

    @classmethod
    def from_env(cls) -> Optional["FleetConfigs"]:
        url = os.environ.get("RS_COORDINATOR_URL", "").strip()
        token = (os.environ.get("RS_COORDINATOR_ADMIN_TOKEN") or os.environ.get("RS_ADMIN_TOKEN") or "").strip()
        if not url or not token:
            return None
        return cls(url, {"Authorization": f"Bearer {token}"})

    def _call(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            with httpx.Client(base_url=self._base_url, headers=self._headers, timeout=self._timeout) as client:
                return client.request(method, path, **kwargs)
        except httpx.HTTPError as e:
            raise FleetError(f"coordinator unreachable: {e}") from None

    def ids(self) -> List[str]:
        res = self._call("GET", "/v1/fleet/configs")
        if res.status_code == 404:
            return []  # a coordinator from before the fleet
        if res.status_code != 200:
            raise FleetError(f"coordinator answered {res.status_code} for the fleet configs")
        return [str(c["worker_id"]) for c in (res.json() or {}).get("configs") or []]

    def read(self, worker_id: str) -> str:
        res = self._call("GET", f"/v1/fleet/configs/{worker_id}")
        if res.status_code != 200:
            raise FleetError(f"coordinator answered {res.status_code} for {worker_id}'s config")
        return str((res.json() or {})["toml"])

    def state(self) -> Dict[str, Any]:
        """The fleet's hosts and assignments; empty from a coordinator without one."""
        res = self._call("GET", "/v1/fleet/state")
        if res.status_code != 200:
            return {}
        return res.json() or {}

    def write(self, worker_id: str, text: str, by: Optional[str] = None) -> bool:
        res = self._call("PUT", f"/v1/fleet/configs/{worker_id}", json={"toml": text, "updated_by": by})
        if res.status_code != 200:
            raise FleetError(f"coordinator refused {worker_id}'s config ({res.status_code})")
        return bool((res.json() or {}).get("changed"))


# ── Applying the values ────────────────────────────────────────────────────────


def overlay(master: Optional[Dict[str, Any]], values: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """master.toml as parsed, with the saved values on top — what the workers run."""
    if master is None:
        return None
    out = copy.deepcopy(master)
    facebook = (out.get("marketplace") or {}).get("facebook")
    if isinstance(facebook, dict):
        for key, value in (values.get("search") or {}).items():
            facebook[key] = _shaped(facebook.get(key), key, value)
    if values.get("ai_model"):
        for table in (out.get("ai") or {}).values():
            if isinstance(table, dict) and "model" in table:
                table["model"] = values["ai_model"]
    for name, fields in (values.get("items") or {}).items():
        block = (out.get("item") or {}).get(name)
        if isinstance(block, dict):
            block.update(fields)
    return out


def _shaped(current: Any, key: str, value: Any) -> Any:
    # date_listed may be a list (one window per search phrase position); the
    # form edits one window, so a list keeps its length with every slot set.
    if key == "date_listed" and isinstance(current, list) and current:
        return [value] * len(current)
    return value


def _same(current: Any, value: Any) -> bool:
    plain = current.unwrap() if isinstance(current, Item) else current
    return plain == value


def _toml_value(key: str, value: Any) -> Any:
    if key in ("prompt", "rating_prompt"):
        return tomlkit.string(value + "\n", multiline=True) if "\n" in value else tomlkit.string(value)
    if isinstance(value, list):
        array = tomlkit.array()
        array.extend(value)
        if len(value) > 3:
            array.multiline(True)
        return array
    return value


CITY_KEYS = (("search_city", "slug"), ("city_name", "name"), ("radius", "radius"))


def render(text: str, values: Dict[str, Any], worker_id: Optional[str] = None) -> str:
    """A worker config's text with the saved values written in, and
    `worker_id`'s own cities and sweep times when it has saved some.

    Untouched keys keep their bytes, comments included, so a config with no
    saved values renders to itself — which is what lets the deploy's verify
    compare a running config against this output.
    """
    doc = tomlkit.parse(text)
    facebook = (doc.get("marketplace") or {}).get("facebook")
    if facebook is not None:
        for key, value in (values.get("search") or {}).items():
            current = facebook.get(key)
            value = _shaped(current.unwrap() if isinstance(current, Item) else current, key, value)
            if key in ("prompt", "rating_prompt") and isinstance(current, Item):
                if str(current.unwrap()).rstrip() == value:
                    continue
            elif _same(current, value):
                continue
            facebook[key] = _toml_value(key, value)
        own = (values.get("workers") or {}).get(worker_id or "") or {}
        city_list = own.get("cities") or []
        if city_list:
            # The three arrays are index-aligned, so they are written together.
            for key, field in CITY_KEYS:
                value = [c[field] for c in city_list]
                if not _same(facebook.get(key), value):
                    facebook[key] = _toml_value(key, value)
        # After the fleet-wide values, so a save from the ERP never lines two
        # workers on one IP back up to the same minute.
        if own.get("start_at") and not _same(facebook.get("start_at"), own["start_at"]):
            facebook["start_at"] = _toml_value("start_at", own["start_at"])
    if values.get("ai_model"):
        for table in (doc.get("ai") or {}).values():
            if "model" in table and not _same(table["model"], values["ai_model"]):
                table["model"] = values["ai_model"]
    for name, fields in (values.get("items") or {}).items():
        block = (doc.get("item") or {}).get(name)
        if block is None:
            continue
        for key, value in fields.items():
            if not _same(block.get(key), value):
                block[key] = _toml_value(key, value)
    return tomlkit.dumps(doc)


def write_in_place(path: Path, text: str) -> bool:
    """Rewrite `path` keeping its inode; False when it already says `text`."""
    with open(path, "r+", encoding="utf-8") as handle:
        if handle.read() == text:
            return False
        handle.seek(0)
        handle.write(text)
        handle.truncate()
    return True


def apply(
    values: Dict[str, Any],
    only: Optional[List[Target]] = None,
    fleet: Optional[FleetConfigs] = None,
    fleet_ids: Optional[List[str]] = None,
) -> List[str]:
    """Write the values into every worker config (or `only` these, and the
    fleet's `fleet_ids`). Every config is rendered before any is written, so
    one that cannot take them changes nothing."""
    chosen = targets() if only is None else only
    rendered = [(p, render(p.read_text(encoding="utf-8"), values, wid)) for wid, p in chosen]
    remote: List[Tuple[str, str]] = []
    if fleet is not None:
        ids = fleet.ids() if fleet_ids is None else fleet_ids
        remote = [(wid, render(fleet.read(wid), values, wid)) for wid in ids]
    changed = [p.name for p, text in rendered if write_in_place(p, text)]
    changed += [f"fleet:{wid}" for wid, text in remote if fleet is not None and fleet.write(wid, text)]
    return changed


def publish(values: Dict[str, Any], fleet: FleetConfigs, worker_ids: Optional[List[str]] = None) -> List[str]:
    """Hand mounted workers' configs, saved values applied, to the fleet.

    Naming a worker is how a compose-run worker moves under rs-fleetd: the
    agent then runs it on exactly the config it ran on. Naming none refreshes
    the ones the fleet already holds, which is how a deploy's regenerated
    config (homelab.toml from master.toml) reaches a worker the fleet runs.
    """
    wanted = worker_ids or fleet.ids()
    chosen = [(wid, p) for wid, p in targets() if wid and wid in wanted]
    rendered = [(wid, render(p.read_text(encoding="utf-8"), values, wid)) for wid, p in chosen]
    for wid, text in rendered:
        fleet.write(wid, text, "rs_console.settings publish")
    return [wid for wid, _ in rendered]


def fleet_start_at(values: Dict[str, Any]) -> List[str]:
    """The sweep times every worker without its own runs: saved, else master's."""
    saved = (values.get("search") or {}).get("start_at")
    if saved:
        return saved
    master = os.environ.get("RS_MASTER_CONFIG", "").strip()
    try:
        facebook = tomlkit.parse(Path(master).read_text(encoding="utf-8"))["marketplace"]["facebook"]
        return _start_at("start_at", [str(t) for t in facebook["start_at"]])
    except (OSError, KeyError, tomlkit.exceptions.ParseError):
        raise SettingsError(f"master.toml ({master or 'RS_MASTER_CONFIG unset'}) names no start_at") from None


def set_start_at(worker_id: str, times: Optional[List[str]]) -> List[str]:
    """Give one worker its own sweep times, or with None the fleet's again.
    Returns the configs that changed."""
    path = config_for(worker_id)
    fleet = FleetConfigs.from_env()
    in_fleet = path is None and fleet is not None and worker_id in fleet.ids()
    if path is None and not in_fleet:
        raise SettingsError(f"No config is mounted for worker {worker_id}")
    values = copy.deepcopy(load()["values"])
    own = values.setdefault("workers", {}).setdefault(worker_id, {})
    if times is None:
        own.pop("start_at", None)
        # The config still says the old times, and render only writes saved
        # ones, so the fleet's are written in once here.
        written = merge(values, {"workers": {worker_id: {"start_at": fleet_start_at(values)}}})
    else:
        own["start_at"] = _start_at("start_at", times)
        written = values
    changed = apply(written, [(worker_id, path)] if path is not None else [],
                    fleet if in_fleet else None, [worker_id])
    save(stamp(values, "rs_console.settings start-at"))
    return changed


def main(argv: List[str]) -> int:
    command = argv[1] if len(argv) > 1 else ""
    if command == "start-at":
        worker_id, times = (argv[2], argv[3:]) if len(argv) > 3 else (None, [])
        if not worker_id or not _WORKER_ID.match(worker_id):
            print(__doc__, file=sys.stderr)
            return 2
        try:
            changed = set_start_at(worker_id, None if times == ["--clear"] else times)
        except (SettingsError, FleetError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print(f"{worker_id} start_at saved; changed: {', '.join(changed) or 'nothing'}")
        return 0
    if command == "render":
        # Named by file, so the deploy needs no copy of the id map.
        name = argv[3] if len(argv) > 3 and argv[2] == "--config" else None
        worker_id = next((wid for wid, p in targets() if name and p.name == name), None)
        sys.stdout.write(render(sys.stdin.read(), load()["values"], worker_id))
        return 0
    if command == "apply":
        changed = apply(load()["values"], fleet=FleetConfigs.from_env())
        print(f"applied saved settings; changed: {', '.join(changed) or 'nothing'}")
        return 0
    if command == "publish":
        fleet = FleetConfigs.from_env()
        if fleet is None:
            print("RS_COORDINATOR_URL and an admin token are needed to publish", file=sys.stderr)
            return 2
        published = publish(load()["values"], fleet, argv[2:] or None)
        print(f"published to the fleet: {', '.join(published) or 'nothing'}")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
