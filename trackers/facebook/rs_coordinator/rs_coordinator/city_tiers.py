"""How often each city is searched: busy cities more than quiet ones.

A worker's city list lives in its config (the console writes it). What changes
day to day is how often each city is searched, and that is decided here at
search time rather than written into the config, because the monitor restarts
its jobs — with a full sweep — whenever its config changes.

The rank is per worker: its cities are scored by the alerts they produced over
a window (alerts sent plus alerts a partner reacted to), and the top
`top_pct` percent are searched `per_day[0]` times a day, the next `mid_pct`
percent `per_day[1]` times, and the rest `per_day[2]`. A city that produced
nothing in the window is never promoted, so a fresh fleet is not split by list
order alone. A pin overrides the rank.

The day is split into the worker's `start_at` times ("slots"). A city searched
p times a day is searched in p evenly spaced slots, starting at an offset that
is a stable hash of its slug, so the 1×/day cities spread over the day instead
of all landing in the first slot. Nothing here reads when a city was last
searched: a slot's list depends only on the slot, so every item in that slot
gets the same one.
"""

import math
import zlib
from typing import Any, Dict, Iterable, List, Mapping, Optional

DEFAULTS: Dict[str, Any] = {
    "top_pct": 20,
    "mid_pct": 20,
    "per_day": [3, 2, 1],
    "window_days": 30,
}
MAX_PER_DAY = 6
MAX_WINDOW_DAYS = 92
MAX_CITIES = 200
MAX_SLUG = 120


class TierError(ValueError):
    """A settings or pins body that cannot be saved; the message says why."""


def _int(key: str, value: Any, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise TierError(f"{key} must be a whole number from {lo} to {hi}")
    return value


def validate_settings(body: Any, current: Mapping[str, Any]) -> Dict[str, Any]:
    """`current` with the given keys replaced; TierError on anything off."""
    if not isinstance(body, dict) or set(body) - set(DEFAULTS):
        raise TierError(f"settings take only {', '.join(DEFAULTS)}")
    out = {**DEFAULTS, **current}
    for key in ("top_pct", "mid_pct"):
        if key in body:
            out[key] = _int(key, body[key], 0, 100)
    if out["top_pct"] + out["mid_pct"] > 100:
        raise TierError("top_pct + mid_pct cannot pass 100")
    if "window_days" in body:
        out["window_days"] = _int("window_days", body["window_days"], 1, MAX_WINDOW_DAYS)
    if "per_day" in body:
        value = body["per_day"]
        if not isinstance(value, list) or len(value) != 3:
            raise TierError("per_day lists three counts: busiest, middle, rest")
        counts = [_int("per_day", v, 1, MAX_PER_DAY) for v in value]
        if not counts[0] >= counts[1] >= counts[2]:
            raise TierError("per_day must not grow from the busiest tier to the rest")
        out["per_day"] = counts
    return out


def validate_pins(body: Any) -> Dict[str, int]:
    """The whole pin map, slug -> searches a day."""
    if not isinstance(body, dict) or len(body) > MAX_CITIES:
        raise TierError(f"pins maps up to {MAX_CITIES} city slugs to searches a day")
    out: Dict[str, int] = {}
    for slug, per_day in body.items():
        if not isinstance(slug, str) or not slug.strip() or len(slug) > MAX_SLUG:
            raise TierError("a pin's key is a city slug")
        out[slug.strip().lower()] = _int(f"pin {slug}", per_day, 1, MAX_PER_DAY)
    return out


def scores(alert_rows: Iterable[Mapping[str, Any]]) -> Dict[str, int]:
    """Alerts sent plus alerts reacted to, per city slug, from alert-hit rows."""
    out: Dict[str, int] = {}
    for row in alert_rows:
        city = row.get("search_city")
        if city:
            out[city] = out.get(city, 0) + int(row.get("sent") or 0) + int(row.get("hit") or 0)
    return out


def rank(
    cities: List[str],
    city_scores: Mapping[str, int],
    settings: Mapping[str, Any],
    pins: Mapping[str, int],
) -> List[Dict[str, Any]]:
    """One row per city, in the worker's own order: score, computed per_day,
    pin, and the per_day that applies."""
    n = len(cities)
    top = math.ceil(n * settings["top_pct"] / 100)
    upper = math.ceil(n * (settings["top_pct"] + settings["mid_pct"]) / 100)
    busy, middle, rest = settings["per_day"]
    # Sorted is stable, so equal scores keep the worker's list order.
    scored = sorted(
        (c for c in cities if city_scores.get(c, 0) > 0),
        key=lambda c: -city_scores[c],
    )
    computed = {c: rest for c in cities}
    for i, city in enumerate(scored):
        computed[city] = busy if i < top else middle if i < upper else rest
    rows = []
    for city in cities:
        pin = pins.get(city)
        rows.append(
            {
                "slug": city,
                "score": city_scores.get(city, 0),
                "computed": computed[city],
                "pin": pin,
                "per_day": pin if pin is not None else computed[city],
            }
        )
    return rows


def slots_for(slug: str, per_day: int, slots: int) -> List[int]:
    """The slots, of `slots` in a day, a city searched `per_day` times uses."""
    if per_day >= slots:
        return list(range(slots))
    offset = zlib.crc32(slug.encode("utf-8")) % slots
    return sorted({(offset + (i * slots) // per_day) % slots for i in range(per_day)})


def plan(rows: List[Dict[str, Any]], slot: int, slots: int) -> List[str]:
    """The cities due in `slot`, in the worker's own order."""
    return [r["slug"] for r in rows if slot in slots_for(r["slug"], r["per_day"], slots)]


def merge_settings(stored: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    return {**DEFAULTS, **(stored or {})}
