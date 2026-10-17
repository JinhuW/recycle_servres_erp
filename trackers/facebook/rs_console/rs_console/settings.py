"""The search settings the ERP may change, saved as an overlay on master.toml.

master.toml is tracked in git and every deploy rsyncs it, so a value written
there from the ERP would be put back by the next deploy. Saved values live in
a JSON file on the console's own volume instead (RS_SETTINGS_STATE), and are
written into each worker's config (RS_WORKER_CONFIGS) on save and again by
every deploy (`render`). master.toml stays the default for anything never
saved.

Only the keys listed here can change. Regions, cities, proxies, credentials,
notification targets and the session path are not reachable from this module,
which is what keeps the console's token from being a way to point a worker at
another account or another chat.

Worker configs are single-file bind mounts. Docker binds the inode, so a file
replaced by rename stays invisible to a running container: they are rewritten
in place. The vendored monitor hashes its config between jobs and restarts
them on a change, which also runs a sweep straight away.

    python -m rs_console.settings apply     write the saved values into every worker config
    python -m rs_console.settings render    stdin config -> stdout, saved values applied
"""

import copy
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

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


def merge(values: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    out = copy.deepcopy(values)
    if "search" in patch:
        out.setdefault("search", {}).update(patch["search"])
    if "ai_model" in patch:
        out["ai_model"] = patch["ai_model"]
    for name, fields in (patch.get("items") or {}).items():
        out.setdefault("items", {}).setdefault(name, {}).update(fields)
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


def worker_configs() -> List[Path]:
    raw = os.environ.get("RS_WORKER_CONFIGS", "").strip()
    if not raw:
        monitor = os.environ.get("RS_MONITOR_CONFIG", "").strip()
        return [Path(monitor)] if monitor else []
    return [Path(p.strip()) for p in raw.split(",") if p.strip()]


def writable() -> bool:
    """Whether a save could land: the state directory and every worker config
    are writable. An older compose mounts them read-only."""
    configs = worker_configs()
    state_dir = state_path().parent
    return (
        bool(configs)
        and state_dir.is_dir()
        and os.access(state_dir, os.W_OK)
        and all(p.is_file() and os.access(p, os.W_OK) for p in configs)
    )


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


def render(text: str, values: Dict[str, Any]) -> str:
    """A worker config's text with the saved values written in.

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


def apply(values: Dict[str, Any], paths: Optional[List[Path]] = None) -> List[str]:
    """Write the values into every worker config. Every file is rendered
    before any is written, so a config that cannot take them changes nothing."""
    paths = worker_configs() if paths is None else paths
    rendered = [(p, render(p.read_text(encoding="utf-8"), values)) for p in paths]
    return [p.name for p, text in rendered if write_in_place(p, text)]


def main(argv: List[str]) -> int:
    command = argv[1] if len(argv) > 1 else ""
    if command == "render":
        sys.stdout.write(render(sys.stdin.read(), load()["values"]))
        return 0
    if command == "apply":
        changed = apply(load()["values"])
        print(f"applied saved settings; changed: {', '.join(changed) or 'nothing'}")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
