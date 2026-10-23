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
* Region and IP partner are hard rules. A worker searches only the regions its
  own home cities, or its IP partner's, are in. It never takes a city its
  partner holds or searched lately, and never starts while its partner is
  mid-search: two accounts on one residential IP must not look like one
  person running two browsers.
* Home cities first, then cities this worker searched lately, then the rest.
  Each worker's listing cache is its own, and a person's searches stay near
  home.

Workers do not ask it for anything yet. `shadow_report` replays the fleet's
real availability over a window through `pick` and reports the result next
to what the workers actually did, so the budget, the windows and the
eligibility rule can be judged on the fleet's own numbers first.
"""

import bisect
import heapq
import math
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Set, Tuple

from . import city_tiers
from .health import DEAD, LIVENESS_CHANGE, STATE_CHANGE, _parse_ts, liveness

DAY = 86400.0

DEFAULTS: Dict[str, Any] = {
    # Browser minutes an account may spend searching per UTC day.
    "budget_minutes": 180,
    # How long a worker keeps asking for cities after each of its start_at times.
    "window_hours": 8,
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
    """Every city with its region (None outside the catalog), and the workers."""

    cities: Dict[str, Dict[str, Optional[str]]]
    workers: Dict[str, Worker]


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
    cities: Dict[str, Dict[str, Optional[str]]] = {}
    for city in catalog:
        if not isinstance(city, dict):
            raise QueueError("a catalog city has a slug, a name and a region")
        cities[_slug(city.get("slug"))] = {
            "name": _text(city.get("name"), "a city name"),
            "region": _text(city.get("region"), "a region"),
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
            cities.setdefault(slug, {"name": None, "region": None})
    return Roster(cities=cities, workers=out)


def validate_settings(body: Any, stored_tiers: Mapping[str, Any]) -> Dict[str, Any]:
    """DEFAULTS with the given keys replaced, plus `tiers`: the stored tier
    settings with any given in the body on top. Nothing is saved."""
    body = {} if body is None else body
    if not isinstance(body, dict) or set(body) - set(DEFAULTS) - {"tiers"}:
        raise QueueError(f"settings take only {', '.join([*DEFAULTS, 'tiers'])}")
    out = {**DEFAULTS, "eligibility": {}}
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
) -> Fleet:
    # A city outside every region is its own, so only its home workers and
    # their partners are eligible for it.
    region = {slug: c["region"] or f"city:{slug}" for slug, c in roster.cities.items()}
    home = {wid: set(w.home) for wid, w in roster.workers.items()}
    partners = {
        wid: {
            other
            for other, o in roster.workers.items()
            if other != wid and w.partner_key and o.partner_key == w.partner_key
        }
        for wid, w in roster.workers.items()
    }
    eligible: Dict[str, Set[str]] = {}
    for wid in roster.workers:
        if wid in settings["eligibility"]:
            eligible[wid] = set(settings["eligibility"][wid])
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
    ranked = city_tiers.rank(list(roster.cities), scores, settings["tiers"], pins)
    per_day = {r["slug"]: r["per_day"] for r in ranked}
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
