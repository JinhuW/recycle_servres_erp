"""The city queue: which city a worker searches next, and a replay of it.

Each worker searches the cities in its own config, set by hand on the ERP's
worker page, so the load sits wherever the long lists are, a parked account's
cities go unsearched until someone edits them, and a worker with one city
idles after it. The queue hands cities out one at a time to whichever
eligible worker asks, so the load follows who is up.

It is not "pull until empty":

* Only due cities are handed out, and an account stops at its daily budget.
  The idle after a sweep is the fleet's rate limit; a queue that filled it
  would be more Facebook traffic, not more coverage.
* An account whose searches all come back with 0 cards, on cities other
  accounts get cards from, is quarantined. It cannot see Marketplace, and
  since it finishes a city in a minute it would otherwise take the most work.
* Home cities first, then cities this worker searched lately, then the rest.
  Each worker's listing cache is its own.
* A city a live worker outside the queue still holds is that worker's, so
  enrolling a few workers fills holes and never repeats a static sweep.

Two rules are settings, off by default because the owner found Facebook does
not mind: `regions` ("home" keeps a worker to the regions its home cities are
in) and `partners` (accounts on one IP never share a city or search at once).

Enrolled workers ask `next_city` before each search and stop when it has
nothing for them. `shadow_report` replays the fleet's real availability
through the same `pick` and reports it next to what the workers actually did.
"""

import bisect
import heapq
import math
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from . import city_tiers
from .health import DEAD, LIVENESS_CHANGE, STATE_CHANGE, _parse_ts, liveness

DAY = 86400.0

DEFAULTS: Dict[str, Any] = {
    # Workers that take their cities from the queue; "*" is every worker.
    "enrolled": [],
    # "any": every city is open to every worker. "home": only the regions
    # holding the worker's (or its IP partner's) home cities.
    "regions": "any",
    # IP partners (one proxy_env) never share a city or search at once.
    "partners": False,
    # Every city this many times a day per item; None follows the tiers.
    "per_day": 1,
    # Browser minutes an account may spend searching per UTC day.
    "budget_minutes": 360,
    # How long a worker keeps asking for cities after each of its start_at times.
    "window_hours": 8,
    # A handed-out city stays the worker's this long past its last HEALTHY
    # heartbeat; a worker that parks gives it back at once.
    "lease_minutes": 30,
    # How far back the 0-card quarantine looks.
    "quarantine_hours": 48,
    # A city is due this fraction of its interval early, so a daily city
    # searched at 13:20 yesterday is due again at today's 13:00 start.
    "early": 0.15,
    # How long an idle worker waits before asking again.
    "poll_minutes": 15,
    # A partner's recent cities stay off limits this long.
    "partner_days": 7,
    # A partner that finished this recently still counts as busy.
    "partner_gap_minutes": 30,
    # Cities this worker searched within this many days count as familiar.
    "familiar_days": 7,
    # One search's length when the log has too few of a worker's own; 9.5
    # minutes a city for two phrases through the residential proxies.
    "search_minutes": 4.75,
    # worker id -> the regions it may search, replacing the home-region rule.
    "eligibility": {},
}

_LIMITS: Dict[str, Tuple[float, float, bool]] = {
    # key: (low, high, whole number)
    "budget_minutes": (10, 1440, True),
    "window_hours": (1, 24, False),
    "lease_minutes": (5, 240, True),
    "quarantine_hours": (1, 336, True),
    "early": (0, 0.9, False),
    "poll_minutes": (1, 120, True),
    "partner_days": (0, 14, True),
    "partner_gap_minutes": (0, 240, True),
    "familiar_days": (0, 14, True),
    "search_minutes": (0.5, 60, False),
}

MAX_WORKERS = 100
MAX_CATALOG = 1000
MAX_DAYS = 14
MAX_PHRASES = 20
MAX_RADIUS_KM = 2000
EVERY_WORKER = "*"
# A city unsearched for longer than this missed a day.
GAP_ALERT_HOURS = 26
# Consecutive reports further apart than this are a new sweep or item, not
# the length of one search.
SEARCH_GAP_MAX = 20.0
SEARCH_GAP_MIN = 2.0
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_GROUPS = ("home", "familiar", "other")


class QueueError(ValueError):
    """A roster or settings body the replay cannot use; the message says why."""


# -- inputs ------------------------------------------------------------------


@dataclass
class Worker:
    worker_id: str
    home: List[str]
    partner_key: Optional[str]
    start_at: List[str]
    phrases: int


@dataclass
class Roster:
    """Every city with its name, region (None outside the catalog) and radius,
    and the workers."""

    cities: Dict[str, Dict[str, Any]]
    workers: Dict[str, Worker]

    def dump(self: "Roster") -> Dict[str, Any]:
        """The body `validate_roster` reads back: what the coordinator stores."""
        return {
            "catalog": [{"slug": slug, **meta} for slug, meta in self.cities.items()],
            "workers": {
                wid: {
                    "home": w.home,
                    "partner_key": w.partner_key,
                    "start_at": w.start_at,
                    "phrases": w.phrases,
                }
                for wid, w in self.workers.items()
            },
        }


def _slug(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > city_tiers.MAX_SLUG:
        raise QueueError("a city is a slug")
    return value.strip().lower()


def _text(value: Any, what: str) -> Optional[str]:
    if value is not None and (not isinstance(value, str) or len(value) > 200):
        raise QueueError(f"{what} is a short string")
    return value or None


def validate_roster(body: Any) -> Roster:
    if not isinstance(body, dict):
        raise QueueError("roster has a catalog and workers")
    catalog, workers = body.get("catalog"), body.get("workers")
    if not isinstance(catalog, list) or len(catalog) > MAX_CATALOG:
        raise QueueError(f"catalog lists up to {MAX_CATALOG} cities")
    cities: Dict[str, Dict[str, Any]] = {}
    for city in catalog:
        if not isinstance(city, dict):
            raise QueueError("a catalog city has a slug, a name and a region")
        radius = city.get("radius")
        if radius is not None and (
            isinstance(radius, bool)
            or not isinstance(radius, int)
            or not 1 <= radius <= MAX_RADIUS_KM
        ):
            raise QueueError(f"a city's radius is 1 to {MAX_RADIUS_KM} km")
        cities[_slug(city.get("slug"))] = {
            "name": _text(city.get("name"), "a city name"),
            "region": _text(city.get("region"), "a region"),
            "radius": radius,
        }
    if not isinstance(workers, dict) or not workers or len(workers) > MAX_WORKERS:
        raise QueueError(f"workers maps 1 to {MAX_WORKERS} worker ids to their roster")
    out: Dict[str, Worker] = {}
    for wid, worker in workers.items():
        if not isinstance(wid, str) or not wid.strip() or not isinstance(worker, dict):
            raise QueueError("workers maps a worker id to its roster")
        home = worker.get("home", [])
        if not isinstance(home, list) or len(home) > city_tiers.MAX_CITIES:
            raise QueueError(f"{wid}: home is a list of city slugs")
        start_at = worker.get("start_at", [])
        if not isinstance(start_at, list) or not all(
            isinstance(s, str) and _HHMM.match(s) for s in start_at
        ):
            raise QueueError(f"{wid}: start_at is a list of HH:MM times")
        phrases = worker.get("phrases", 2)
        if (
            isinstance(phrases, bool)
            or not isinstance(phrases, int)
            or not 1 <= phrases <= MAX_PHRASES
        ):
            raise QueueError(f"{wid}: phrases is 1 to {MAX_PHRASES}")
        slugs = list(dict.fromkeys(_slug(h) for h in home))
        out[wid] = Worker(
            worker_id=wid,
            home=slugs,
            partner_key=_text(worker.get("partner_key"), f"{wid}: partner_key"),
            start_at=sorted(set(start_at)),
            phrases=phrases,
        )
        for slug in slugs:
            cities.setdefault(slug, {"name": None, "region": None, "radius": None})
    return Roster(cities=cities, workers=out)


def validate_settings(
    body: Any,
    stored_tiers: Mapping[str, Any],
    stored: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    """DEFAULTS, then the stored queue settings, then the body's keys, plus
    `tiers`: the stored tier settings with any given in the body on top.
    Nothing is saved here."""
    body = {} if body is None else body
    if not isinstance(body, dict) or set(body) - set(DEFAULTS) - {"tiers"}:
        raise QueueError(f"settings take only {', '.join([*DEFAULTS, 'tiers'])}")
    out = {**DEFAULTS, "enrolled": [], "eligibility": {}, **(stored or {})}
    if "enrolled" in body:
        ids = body["enrolled"]
        if (
            not isinstance(ids, list)
            or len(ids) > MAX_WORKERS
            or not all(isinstance(w, str) and w.strip() for w in ids)
        ):
            raise QueueError(f"enrolled lists worker ids, or {EVERY_WORKER!r} for every worker")
        out["enrolled"] = sorted({w.strip() for w in ids})
    if "regions" in body:
        if body["regions"] not in ("any", "home"):
            raise QueueError("regions is 'any' or 'home'")
        out["regions"] = body["regions"]
    if "partners" in body:
        if not isinstance(body["partners"], bool):
            raise QueueError("partners is true or false")
        out["partners"] = body["partners"]
    if "per_day" in body:
        per_day = body["per_day"]
        if per_day is not None and (
            isinstance(per_day, bool)
            or not isinstance(per_day, int)
            or not 1 <= per_day <= city_tiers.MAX_PER_DAY
        ):
            raise QueueError(
                f"per_day is 1 to {city_tiers.MAX_PER_DAY}, or null to follow the tiers"
            )
        out["per_day"] = per_day
    for key, (lo, hi, whole) in _LIMITS.items():
        if key not in body:
            continue
        value = body[key]
        kinds = int if whole else (int, float)
        if isinstance(value, bool) or not isinstance(value, kinds) or not lo <= value <= hi:
            raise QueueError(
                f"{key} must be a {'whole number' if whole else 'number'} from {lo:g} to {hi:g}"
            )
        out[key] = value
    if "eligibility" in body:
        rule = body["eligibility"]
        if (
            not isinstance(rule, dict)
            or len(rule) > MAX_WORKERS
            or not all(
                isinstance(wid, str)
                and isinstance(regions, list)
                and all(isinstance(r, str) and r for r in regions)
                for wid, regions in rule.items()
            )
        ):
            raise QueueError("eligibility maps a worker id to the regions it may search")
        out["eligibility"] = {wid: sorted(set(regions)) for wid, regions in rule.items()}
    try:
        out["tiers"] = city_tiers.validate_settings(body.get("tiers", {}), stored_tiers)
    except city_tiers.TierError as e:
        raise QueueError(str(e)) from e
    return out


def enrolled(worker_id: str, settings: Mapping[str, Any]) -> bool:
    return EVERY_WORKER in settings["enrolled"] or worker_id in settings["enrolled"]


def per_day_map(
    cities: Iterable[str],
    settings: Mapping[str, Any],
    scores: Mapping[str, int],
    pins: Mapping[str, int],
) -> Dict[str, int]:
    """Searches a day for each city: the flat `per_day`, or the tiers."""
    slugs = list(cities)
    if settings["per_day"] is not None:
        return {slug: settings["per_day"] for slug in slugs}
    return {
        r["slug"]: r["per_day"] for r in city_tiers.rank(slugs, scores, settings["tiers"], pins)
    }


# -- the decision --------------------------------------------------------------


@dataclass
class Fleet:
    """What `pick` reads that does not change while cities are handed out."""

    region: Dict[str, str]
    per_day: Dict[str, int]
    home: Dict[str, Set[str]]
    partners: Dict[str, Set[str]]
    eligible: Dict[str, Set[str]]
    quarantined: Set[str]
    # Cities a live worker outside the queue still searches from its own list.
    held: Set[str] = field(default_factory=set)


@dataclass
class State:
    """What does change: when each city and each worker last searched.

    A city's visit is stamped when it is handed out, not when the search ends,
    which is what keeps a second worker off it while the first is searching.
    """

    last_visit: Dict[str, float] = field(default_factory=dict)
    worker_visits: Dict[str, Dict[str, float]] = field(default_factory=dict)
    busy_until: Dict[str, float] = field(default_factory=dict)
    minutes: Dict[Tuple[str, int], float] = field(default_factory=dict)

    def record(self: "State", worker_id: str, city: str, at: float, minutes: float) -> None:
        self.last_visit[city] = max(at, self.last_visit.get(city, at))
        self.worker_visits.setdefault(worker_id, {})[city] = at
        self.busy_until[worker_id] = max(at + minutes * 60, self.busy_until.get(worker_id, at))
        day = _day(at)
        self.minutes[(worker_id, day)] = self.minutes.get((worker_id, day), 0.0) + minutes


def _day(at: float) -> int:
    return int(at // DAY)


def build_fleet(
    roster: Roster,
    per_day: Mapping[str, int],
    settings: Mapping[str, Any],
    quarantined: Iterable[str] = (),
    held: Iterable[str] = (),
) -> Fleet:
    # A city outside every region is its own, so under the "home" rule only
    # its home workers and their partners are eligible for it.
    region = {slug: c["region"] or f"city:{slug}" for slug, c in roster.cities.items()}
    home = {wid: set(w.home) for wid, w in roster.workers.items()}
    partners = {
        wid: (
            {
                other
                for other, o in roster.workers.items()
                if other != wid and w.partner_key and o.partner_key == w.partner_key
            }
            if settings["partners"]
            else set()
        )
        for wid, w in roster.workers.items()
    }
    everywhere = set(region.values())
    eligible: Dict[str, Set[str]] = {}
    for wid in roster.workers:
        if wid in settings["eligibility"]:
            eligible[wid] = set(settings["eligibility"][wid])
        elif settings["regions"] == "any":
            eligible[wid] = everywhere
        else:
            holders = {wid, *partners[wid]}
            eligible[wid] = {region[c] for h in holders for c in home[h]}
    return Fleet(
        region=region,
        per_day={slug: int(per_day.get(slug, 1)) for slug in region},
        home=home,
        partners=partners,
        eligible=eligible,
        quarantined=set(quarantined),
        held=set(held),
    )


def overdue(city: str, now: float, fleet: Fleet, state: State) -> float:
    """Time since the city's last visit, in its intervals; never searched is infinite."""
    last = state.last_visit.get(city)
    if last is None:
        return math.inf
    return (now - last) / (DAY / fleet.per_day.get(city, 1))


def pick(
    worker_id: str,
    now: float,
    fleet: Fleet,
    state: State,
    settings: Mapping[str, Any],
) -> Tuple[Optional[str], str]:
    """The city `worker_id` should search at `now`, and why: home, familiar or
    other; or None and why not: quarantined, budget, partner_busy, nothing_due."""
    if worker_id in fleet.quarantined:
        return None, "quarantined"
    if state.minutes.get((worker_id, _day(now)), 0.0) >= settings["budget_minutes"]:
        return None, "budget"
    partners = fleet.partners.get(worker_id, set())
    gap = settings["partner_gap_minutes"] * 60
    if any(state.busy_until.get(p, -math.inf) + gap > now for p in partners):
        return None, "partner_busy"

    since = now - settings["partner_days"] * DAY
    home = fleet.home.get(worker_id, set())
    taken: Set[str] = set()
    for p in partners:
        # A city both partners hold goes to whichever asks first; the recent
        # search then keeps the other off it.
        taken |= fleet.home.get(p, set()) - home
        taken |= {c for c, at in state.worker_visits.get(p, {}).items() if at >= since}
    regions = fleet.eligible.get(worker_id, set())
    mine = state.worker_visits.get(worker_id, {})
    familiar_since = now - settings["familiar_days"] * DAY
    due_at = 1 - settings["early"]

    best: Optional[Tuple[Tuple[int, float, str], str]] = None
    for city, region in fleet.region.items():
        if region not in regions or city in taken:
            continue
        if city in fleet.held and city not in home:
            continue
        ratio = overdue(city, now, fleet, state)
        if ratio < due_at:
            continue
        group = 0 if city in home else 1 if mine.get(city, -math.inf) >= familiar_since else 2
        key = (group, -ratio, city)
        if best is None or key < best[0]:
            best = (key, city)
    if best is None:
        return None, "nothing_due"
    return best[1], _GROUPS[best[0][0]]


# -- what the log says -----------------------------------------------------------


def _ts(value: Any) -> float:
    moment = _parse_ts(value)
    assert moment is not None, value  # every stamp here was written by utcnow()
    return moment.timestamp()


def quarantined(searches: Iterable[Mapping[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Accounts that cannot see Marketplace: two or more searches, every one at
    0 cards, on cities another account got cards from. A city every account
    gets nothing from is just empty, and convicts nobody."""
    rows_by_worker: Dict[str, List[Mapping[str, Any]]] = defaultdict(list)
    cards_by_city: Dict[str, List[Tuple[str, int]]] = defaultdict(list)
    for row in searches:
        rows_by_worker[row["worker_id"]].append(row)
        cards_by_city[row["city"]].append((row["worker_id"], int(row["cards"] or 0)))
    out: Dict[str, Dict[str, Any]] = {}
    for wid, rows in sorted(rows_by_worker.items()):
        if len(rows) < 2 or any(int(r["cards"] or 0) for r in rows):
            continue
        cities = sorted({r["city"] for r in rows})
        others = {}
        for city in cities:
            seen = [n for other, n in cards_by_city[city] if other != wid and n > 0]
            if seen:
                others[city] = int(statistics.median(seen))
        if others:
            out[wid] = {"searches": len(rows), "cities": cities, "others_cards": others}
    return out


def search_minutes(searches: Iterable[Mapping[str, Any]]) -> Dict[str, float]:
    """Each worker's median length of one search, from the gaps between its
    consecutive reports; only workers with three or more such gaps."""
    times: Dict[str, List[float]] = defaultdict(list)
    for row in searches:
        times[row["worker_id"]].append(_ts(row["at"]))
    out: Dict[str, float] = {}
    for wid, stamps in times.items():
        stamps.sort()
        gaps = [(b - a) / 60 for a, b in zip(stamps, stamps[1:]) if (b - a) / 60 <= SEARCH_GAP_MAX]
        if len(gaps) >= 3:
            out[wid] = min(SEARCH_GAP_MAX, max(SEARCH_GAP_MIN, statistics.median(gaps)))
    return out


def availability(
    worker_rows: Iterable[Mapping[str, Any]],
    events: Iterable[Mapping[str, Any]],
    now: Optional[datetime] = None,
) -> Callable[[str, float], bool]:
    """Whether a worker was up at a moment: reporting HEALTHY, heartbeats not
    dead. Read from its status changes; before the first one it was in that
    change's `was`, and with none at all in what it reports now."""
    current = {r["worker_id"]: r for r in worker_rows}
    history: Dict[Tuple[str, str], List[Tuple[float, Optional[str], str]]] = defaultdict(list)
    for e in events:
        if e["kind"] in (STATE_CHANGE, LIVENESS_CHANGE):
            history[(e["worker_id"], e["kind"])].append((_ts(e["at"]), e["was"], e["became"]))
    for rows in history.values():
        rows.sort(key=lambda r: r[0])
    stamps = {key: [r[0] for r in rows] for key, rows in history.items()}

    def value_at(wid: str, kind: str, at: float, otherwise: Optional[str]) -> Optional[str]:
        rows = history.get((wid, kind))
        if not rows:
            return otherwise
        i = bisect.bisect_right(stamps[(wid, kind)], at)
        return rows[i - 1][2] if i else rows[0][1]

    def up(worker_id: str, at: float) -> bool:
        row = current.get(worker_id)
        if row is None:
            return False
        state = value_at(worker_id, STATE_CHANGE, at, row.get("state"))
        alive = value_at(
            worker_id, LIVENESS_CHANGE, at, liveness(row.get("last_heartbeat_at"), now)
        )
        return state == "HEALTHY" and alive != DEAD

    return up


# -- the live queue -----------------------------------------------------------------


_DAILY = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$")


def daily_times(start_at: Iterable[Any]) -> List[str]:
    """The plain daily "HH:MM" times of a worker's start_at; the hourly and
    per-minute forms make no window."""
    return sorted({s[:5] for s in start_at if isinstance(s, str) and _DAILY.match(s)})


def in_window(start_at: Iterable[str], now: float, hours: float) -> bool:
    """Whether `now` falls within `hours` after one of the daily `start_at`
    times (UTC, the containers' clock). With none, the worker runs on an
    interval, and every moment is its window."""
    times = list(start_at)
    if not times:
        return True
    today = _day(now)
    for hhmm in times:
        hh, mm = hhmm.split(":")
        for day in (today, today - 1):
            start = day * DAY + int(hh) * 3600 + int(mm) * 60
            if start <= now < start + hours * 3600:
                return True
    return False


def lease_cost(lease: Mapping[str, Any], now: float) -> float:
    """Browser minutes a lease cost: to its close, or so far, or to its expiry."""
    start = _ts(lease["leased_at"])
    if lease.get("closed_at"):
        end = _ts(lease["closed_at"])
    else:
        end = min(now, _ts(lease["expires_at"]))
    return max(0.0, end - start) / 60


def live_state(
    item: str,
    now: float,
    searches: Iterable[Mapping[str, Any]],
    seeded: Iterable[Mapping[str, Any]],
    leases: Iterable[Mapping[str, Any]],
    blind: Iterable[str],
) -> State:
    """The queue's state for one item, from the coordinator's rows.

    A city's visit for `item` is a search reported for it (one reported with
    no item is from a worker that searches every item), a `seeded` last
    search from before the log began, or a lease that was closed or is still
    live. A lease that expired unclosed was abandoned and visits nothing, and
    neither does anything a quarantined account searched, so the city goes
    back to someone who can see it. Minutes and busy times count every item.
    """
    blind = set(blind)
    state = State()

    def visit(wid: str, city: str, at: float, counts: bool) -> None:
        if counts:
            state.last_visit[city] = max(at, state.last_visit.get(city, at))
        seen = state.worker_visits.setdefault(wid, {})
        seen[city] = max(at, seen.get(city, at))

    for row in searches:
        if row["worker_id"] not in blind:
            city = row["city"].lower()
            visit(row["worker_id"], city, _ts(row["at"]), row.get("item") in (None, item))
    for row in seeded:
        if row["worker_id"] not in blind:
            visit(row["worker_id"], row["city"].lower(), _ts(row["last_at"]), True)
    for lease in leases:
        wid = lease["worker_id"]
        start = _ts(lease["leased_at"])
        closed = lease.get("closed_at")
        live = not closed and _ts(lease["expires_at"]) > now
        if wid not in blind and (closed or live):
            visit(wid, lease["city"], start, lease["item"] == item)
        key = (wid, _day(start))
        state.minutes[key] = state.minutes.get(key, 0.0) + lease_cost(lease, now)
        end = now if live else _ts(closed) if closed else _ts(lease["expires_at"])
        state.busy_until[wid] = max(end, state.busy_until.get(wid, end))
    return state


def held_cities(
    roster: Roster,
    settings: Mapping[str, Any],
    worker_rows: Iterable[Mapping[str, Any]],
    blind: Iterable[str],
    now: float,
) -> Set[str]:
    """Cities a live, unquarantined worker outside the queue still searches
    from its own list. A parked or blind one's cities are free."""
    up = availability(worker_rows, [], datetime.fromtimestamp(now, timezone.utc))
    blind = set(blind)
    out: Set[str] = set()
    for wid, worker in roster.workers.items():
        if not enrolled(wid, settings) and wid not in blind and up(wid, now):
            out |= set(worker.home)
    return out


@dataclass
class Live:
    """The coordinator's rows the live queue reads, in one place."""

    roster: Roster
    worker_rows: List[Mapping[str, Any]]
    # city_searches since a week back, for visits, familiarity and quarantine.
    searches: List[Mapping[str, Any]]
    # search_cities, for searches from before city_searches began.
    seeded: List[Mapping[str, Any]]
    leases: List[Mapping[str, Any]]
    log_since: Optional[float]
    scores: Mapping[str, int]
    pins: Mapping[str, int]


def _blind(live: Live, now: float, settings: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    since = now - settings["quarantine_hours"] * 3600
    return quarantined([r for r in live.searches if _ts(r["at"]) >= since])


def _seeded(live: Live) -> List[Mapping[str, Any]]:
    # Anything after the log began is in it, with its item; search_cities
    # would count one item's search as both.
    if live.log_since is None:
        return list(live.seeded)
    return [r for r in live.seeded if _ts(r["last_at"]) < live.log_since]


def next_city(
    worker_id: str,
    item: str,
    home: List[str],
    start_at: List[str],
    now: float,
    settings: Mapping[str, Any],
    live: Live,
) -> Dict[str, Any]:
    """The answer to a worker's "what next?" for one item.

    `{queue: false}` for a worker outside the queue, which then searches its
    own list. Otherwise `{queue: true, city: {slug, name, radius}, why}`, or
    `{queue: true, city: null, reason}`, after which it searches nothing:
    the round is done (nothing_due), its budget is spent, it is outside its
    window, it is quarantined, or its IP partner is busy (retry_after).
    """
    if not enrolled(worker_id, settings):
        return {"queue": False}
    if not in_window(start_at, now, settings["window_hours"]):
        return {"queue": True, "city": None, "reason": "outside_window"}
    blind = _blind(live, now, settings)
    if worker_id in blind:
        return {"queue": True, "city": None, "reason": "quarantined"}

    # The worker's own list is fresher than the console's last push.
    known = live.roster.workers.get(worker_id)
    workers = dict(live.roster.workers)
    workers[worker_id] = Worker(
        worker_id=worker_id,
        home=home,
        partner_key=known.partner_key if known else None,
        start_at=start_at,
        phrases=known.phrases if known else 2,
    )
    cities = dict(live.roster.cities)
    for slug in home:
        cities.setdefault(slug, {"name": None, "region": None, "radius": None})
    roster = Roster(cities=cities, workers=workers)
    fleet = build_fleet(
        roster,
        per_day_map(cities, settings, live.scores, live.pins),
        settings,
        blind,
        held_cities(roster, settings, live.worker_rows, blind, now),
    )
    state = live_state(item, now, live.searches, _seeded(live), live.leases, blind)
    city, why = pick(worker_id, now, fleet, state, settings)
    if city is None:
        answer: Dict[str, Any] = {"queue": True, "city": None, "reason": why}
        if why == "partner_busy":
            answer["retry_after"] = settings["poll_minutes"] * 60
        return answer
    meta = cities[city]
    return {
        "queue": True,
        "city": {"slug": city, "name": meta["name"], "radius": meta["radius"]},
        "why": why,
    }


def queue_status(now: float, settings: Mapping[str, Any], live: Live) -> Dict[str, Any]:
    """Today's round: per item, the catalog's cities searched today, leased now
    and still due; per worker in the queue, its minutes and open leases."""
    blind = _blind(live, now, settings)
    roster = live.roster
    held = held_cities(roster, settings, live.worker_rows, blind, now)
    per_day = per_day_map(roster.cities, settings, live.scores, live.pins)
    today = _day(now)
    items = sorted(
        {lease["item"] for lease in live.leases}
        | {r["item"] for r in live.searches if r.get("item")}
    )
    open_leases = [
        lease
        for lease in live.leases
        if not lease.get("closed_at") and _ts(lease["expires_at"]) > now
    ]
    out_items = {}
    for item in items:
        state = live_state(item, now, live.searches, _seeded(live), live.leases, blind)
        leased = {lease["city"] for lease in open_leases if lease["item"] == item}
        searched = due = 0
        for city in roster.cities:
            last = state.last_visit.get(city)
            if last is not None and _day(last) == today:
                searched += 1
            if city in held or city in leased:
                continue
            if last is None or now - last >= DAY / per_day[city] * (1 - settings["early"]):
                due += 1
        out_items[item] = {
            "cities": len(roster.cities),
            "searched_today": searched,
            "leased": len(leased),
            "held": len(held & set(roster.cities)),
            "due": due,
        }

    state = live_state("", now, [], [], live.leases, ())
    ids = {lease["worker_id"] for lease in live.leases if _day(_ts(lease["leased_at"])) == today}
    ids |= {wid for wid in roster.workers if enrolled(wid, settings)}
    workers = []
    for wid in sorted(ids):
        workers.append(
            {
                "worker_id": wid,
                "enrolled": enrolled(wid, settings),
                "quarantined": wid in blind,
                "minutes_today": round(state.minutes.get((wid, today), 0.0)),
                "handed_today": sum(
                    1
                    for lease in live.leases
                    if lease["worker_id"] == wid and _day(_ts(lease["leased_at"])) == today
                ),
                "open": [
                    {"item": lease["item"], "city": lease["city"], "leased_at": lease["leased_at"]}
                    for lease in open_leases
                    if lease["worker_id"] == wid
                ],
            }
        )
    return {
        "at": _iso(now),
        "settings": {k: v for k, v in settings.items() if k != "tiers"},
        "items": out_items,
        "workers": workers,
        "quarantined": sorted(blind),
    }


# -- the stored queue -------------------------------------------------------------
# The coordinator's tables, read and written for the routes and `rsc queue`.


def _stamp(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def stored_settings(db: Any) -> Dict[str, Any]:
    stored = db.queue_config("settings")
    return dict(stored["body"]) if stored else {}


def load_settings(db: Any, body: Any = None) -> Dict[str, Any]:
    """The stored settings over DEFAULTS, with `body` on top; nothing saved."""
    return validate_settings(body, db.city_tier_config()["settings"], stored_settings(db))


def save_settings(db: Any, changes: Mapping[str, Any], by: Optional[str]) -> Dict[str, Any]:
    """Change the given keys and store them; QueueError on anything off.

    Only keys someone set are stored, so a default changed in code still
    reaches every key nobody chose.
    """
    if "tiers" in changes:
        raise QueueError("tiers are set through /v1/city-tiers")
    merged = load_settings(db, dict(changes))
    db.put_queue_config("settings", {**stored_settings(db), **{k: merged[k] for k in changes}}, by)
    return merged


def load_roster(db: Any) -> Roster:
    stored = db.queue_config("roster")
    if not stored:
        return Roster(cities={}, workers={})
    return validate_roster(stored["body"])


def load_live(db: Any, now: datetime, settings: Mapping[str, Any]) -> "Live":
    start = db.city_search_log_start()
    tiers = settings["per_day"] is None
    return Live(
        roster=load_roster(db),
        worker_rows=db.list_workers(),
        # A week covers familiar cities; visits and quarantine need less.
        searches=db.city_searches_since(_stamp(now - timedelta(days=8))),
        seeded=db.search_cities(),
        leases=db.city_leases_since(_stamp(now - timedelta(days=2))),
        log_since=_ts(start) if start else None,
        scores=(
            city_tiers.scores(db.alert_hit_stats(days=settings["tiers"]["window_days"]))
            if tiers
            else {}
        ),
        pins=db.city_tier_config()["pins"] if tiers else {},
    )


# -- the replay ------------------------------------------------------------------


@dataclass
class Visit:
    worker_id: str
    city: str
    at: float
    minutes: float
    why: str


def simulate(
    roster: Roster,
    fleet: Fleet,
    settings: Mapping[str, Any],
    start: float,
    end: float,
    history: Iterable[Tuple[str, str, float]],
    up: Callable[[str, float], bool],
    per_search: Mapping[str, float],
) -> Tuple[List[Visit], Dict[str, Counter]]:
    """Hand cities out as the queue would have, from `start` to `end`.

    Each worker wakes at its start_at times while `up` says it was, asks
    `pick` until its window closes, and waits `poll_minutes` whenever told
    no. The replay starts a day early from the real last visits in `history`
    (worker, city, at), so that at `start` every city is not overdue at once
    and the window does not measure a cold start. Returns every visit, the
    warm-up day's included, and each worker's idle wakes from `start` by why.
    """
    warm = start - DAY
    state = State()
    for wid, city, at in sorted(history, key=lambda h: h[2]):
        if at < warm:
            state.last_visit[city] = at
            state.worker_visits.setdefault(wid, {})[city] = at

    activate, wake = 0, 1
    heap: List[Tuple[float, str, int]] = []
    for wid, worker in roster.workers.items():
        for day in range(_day(warm), _day(end) + 1):
            for hhmm in worker.start_at:
                hh, mm = hhmm.split(":")
                at = day * DAY + int(hh) * 3600 + int(mm) * 60
                if warm <= at < end:
                    heap.append((at, wid, activate))
    heapq.heapify(heap)

    poll = settings["poll_minutes"] * 60
    window = settings["window_hours"] * 3600
    active_until: Dict[str, float] = {}
    visits: List[Visit] = []
    idle: Dict[str, Counter] = defaultdict(Counter)
    while heap:
        at, wid, kind = heapq.heappop(heap)
        if at >= end:
            break
        if kind == activate:
            awake = active_until.get(wid, -math.inf) > at
            active_until[wid] = max(active_until.get(wid, -math.inf), at + window)
            if not awake:
                heapq.heappush(heap, (max(at, state.busy_until.get(wid, at)), wid, wake))
            continue
        if at >= active_until[wid]:
            continue
        if not up(wid, at):
            if at >= start:
                idle[wid]["down"] += 1
            heapq.heappush(heap, (at + poll, wid, wake))
            continue
        city, why = pick(wid, at, fleet, state, settings)
        if city is None:
            if at >= start:
                idle[wid][why] += 1
            heapq.heappush(heap, (at + poll, wid, wake))
            continue
        minutes = roster.workers[wid].phrases * per_search.get(wid, settings["search_minutes"])
        state.record(wid, city, at, minutes)
        visits.append(Visit(wid, city, at, minutes, why))
        heapq.heappush(heap, (at + minutes * 60, wid, wake))
    return visits, idle


# -- the report ------------------------------------------------------------------


def _iso(at: float) -> str:
    return datetime.fromtimestamp(at, timezone.utc).isoformat(timespec="seconds")


def _city_side(
    searches: List[Tuple[str, float, int]],
    prior: Optional[float],
    start: float,
    end: float,
    per_day: int,
    early: float,
) -> Dict[str, Any]:
    """One city's figures from its (worker, at, searches) events in the window.

    The gap before the first event runs from the last one before the window
    when there was one, so a city searched just before `start` is not counted
    as missing the window's first hours.
    """
    interval = DAY / per_day
    times = sorted(at for _, at, _ in searches)
    edges = [prior if prior is not None else start, *times, end]
    gaps = [b - a for a, b in zip(edges, edges[1:])]
    redundant = 0
    last_by: List[Tuple[float, str]] = []
    for wid, at, n in sorted(searches, key=lambda s: s[1]):
        if any(other != wid and at - t < interval * (1 - early) for t, other in last_by):
            redundant += n
        last_by = [(t, o) for t, o in last_by if o != wid] + [(at, wid)]
    return {
        "searches": sum(n for _, _, n in searches),
        "workers": sorted({wid for wid, _, _ in searches}),
        "max_gap_h": round(max(gaps) / 3600, 1),
        "overdue_h": round(sum(max(0.0, g - interval) for g in gaps) / 3600, 1),
        "redundant": redundant,
    }


def _fleet_side(
    cities: List[Dict[str, Any]], workers: List[Dict[str, Any]], side: str, days: float
) -> Dict[str, Any]:
    minutes = [w[side]["minutes"] for w in workers if w[side]["minutes"] > 0]
    searches = sum(c[side]["searches"] for c in cities)
    return {
        "searches": searches,
        "searches_per_day": round(searches / days, 1),
        "browser_minutes_per_day": round(sum(minutes) / days),
        "accounts_used": len(minutes),
        "max_account_minutes_per_day": round(max(minutes, default=0) / days),
        "median_account_minutes_per_day": (
            round(statistics.median(minutes) / days) if minutes else 0
        ),
        "redundant_searches": sum(c[side]["redundant"] for c in cities),
        "cities_gap_over_26h": sum(1 for c in cities if c[side]["max_gap_h"] > GAP_ALERT_HOURS),
        "overdue_hours": round(sum(c[side]["overdue_h"] for c in cities)),
    }


def shadow_report(
    roster: Roster,
    settings: Mapping[str, Any],
    scores: Mapping[str, int],
    pins: Mapping[str, int],
    searches: List[Mapping[str, Any]],
    events: List[Mapping[str, Any]],
    worker_rows: List[Mapping[str, Any]],
    start: float,
    end: float,
) -> Dict[str, Any]:
    """What the workers did in [start, end), next to what the queue would have
    done with the same accounts up at the same times.

    `searches` is the whole search log; the replay needs what came before the
    window as well as what is in it. A quarantined account's searches count in
    its own row but never as coverage, on either side.
    """
    days = (end - start) / DAY
    rows = [{**s, "t": _ts(s["at"])} for s in searches]
    window_rows = [r for r in rows if start <= r["t"] < end]
    blind = quarantined(window_rows)
    per_search = search_minutes(rows)
    per_day = per_day_map(roster.cities, settings, scores, pins)
    fleet = build_fleet(roster, per_day, settings, blind)
    up = availability(worker_rows, events, datetime.fromtimestamp(end, timezone.utc))
    counted = [r for r in rows if r["worker_id"] not in blind]
    replayed, idle = simulate(
        roster,
        fleet,
        settings,
        start,
        end,
        [(r["worker_id"], r["city"], r["t"]) for r in counted],
        up,
        per_search,
    )

    def minutes_for(wid: str) -> float:
        return per_search.get(wid, settings["search_minutes"])

    actual_by_city: Dict[str, List[Tuple[str, float, int]]] = defaultdict(list)
    prior: Dict[str, float] = {}
    for r in counted:
        if r["t"] < start:
            prior[r["city"]] = max(r["t"], prior.get(r["city"], r["t"]))
        elif r["t"] < end:
            actual_by_city[r["city"]].append((r["worker_id"], r["t"], 1))
    visits = [v for v in replayed if v.at >= start]
    shadow_prior = dict(prior)
    for v in replayed:
        if v.at < start:
            shadow_prior[v.city] = max(v.at, shadow_prior.get(v.city, v.at))
    shadow_by_city: Dict[str, List[Tuple[str, float, int]]] = defaultdict(list)
    for v in visits:
        shadow_by_city[v.city].append((v.worker_id, v.at, roster.workers[v.worker_id].phrases))

    early = settings["early"]
    cities = []
    for slug, meta in roster.cities.items():
        n = per_day[slug]
        cities.append(
            {
                "slug": slug,
                "name": meta["name"],
                "region": meta["region"],
                "per_day": n,
                "home_workers": sorted(w for w, h in fleet.home.items() if slug in h),
                "actual": _city_side(actual_by_city[slug], prior.get(slug), start, end, n, early),
                "shadow": _city_side(
                    shadow_by_city[slug], shadow_prior.get(slug), start, end, n, early
                ),
            }
        )

    workers = []
    for wid, worker in sorted(roster.workers.items()):
        mine = [r for r in window_rows if r["worker_id"] == wid]
        shadow_visits = [v for v in visits if v.worker_id == wid]
        workers.append(
            {
                "worker_id": wid,
                "home": len(worker.home),
                "partners": sorted(fleet.partners[wid]),
                "start_at": worker.start_at,
                "quarantined": wid in blind,
                "search_minutes": round(minutes_for(wid), 2),
                "actual": {
                    "searches": len(mine),
                    "minutes": round(len(mine) * minutes_for(wid)),
                    "cards": sum(int(r["cards"] or 0) for r in mine),
                    "zero_card_searches": sum(1 for r in mine if not r["cards"]),
                },
                "shadow": {
                    "searches": len(shadow_visits) * worker.phrases,
                    "minutes": round(sum(v.minutes for v in shadow_visits)),
                    "by": dict(Counter(v.why for v in shadow_visits)),
                    "idle_minutes": {
                        why: n * settings["poll_minutes"] for why, n in sorted(idle[wid].items())
                    },
                },
            }
        )

    log_since = min((r["t"] for r in rows), default=None)
    return {
        "window": {"start": _iso(start), "end": _iso(end), "days": round(days, 2)},
        # The log starts when the coordinator began keeping it; a window that
        # reaches back further reads the workers as idle before then.
        "log_since": _iso(log_since) if log_since is not None else None,
        "partial": log_since is None or log_since > start,
        "settings": dict(settings),
        "quarantined": [{"worker_id": wid, **evidence} for wid, evidence in blind.items()],
        "fleet": {
            "actual": _fleet_side(cities, workers, "actual", days),
            "shadow": _fleet_side(cities, workers, "shadow", days),
        },
        "workers": workers,
        "cities": cities,
    }
