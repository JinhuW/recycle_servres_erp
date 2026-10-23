"""The city queue: who gets which city next, and the replay of the fleet.

The contract: only due cities are handed out, home before familiar before the
rest and the most overdue first within each; a worker searches only its
regions, never a city its IP partner holds or searched lately, never while
its partner is busy, and not past its budget; an account that sees 0 cards
where others see some gets nothing; and the replay spreads a long list over
idle neighbours without saving anything.
"""

import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from rs_coordinator import city_queue, city_tiers
from rs_coordinator.city_queue import DAY, State

ADMIN = {"Authorization": "Bearer admin-token"}
LEGACY = {"Authorization": "Bearer test-token"}
# A UTC midnight, so start_at times land on the day they name.
T0 = datetime(2026, 10, 20, tzinfo=timezone.utc).timestamp()
HOUR = 3600.0
SETTINGS = city_queue.validate_settings({}, {})

CATALOG = [
    {"slug": "boston", "name": "Boston, MA", "region": "ne"},
    {"slug": "nyc", "name": "New York, NY", "region": "ne"},
    {"slug": "philly", "name": "Philadelphia, PA", "region": "ne"},
    {"slug": "dc", "name": "Washington, DC", "region": "se"},
    {"slug": "atlanta", "name": "Atlanta, GA", "region": "se"},
]


def roster(workers, catalog=CATALOG):
    return city_queue.validate_roster(
        {
            "catalog": catalog,
            "workers": {w: {"start_at": ["13:00"], **body} for w, body in workers.items()},
        }
    )


def fleet(r, settings=SETTINGS, per_day=None, quarantined=()):
    return city_queue.build_fleet(r, per_day or {}, settings, quarantined)


def pick(wid, now, f, state, settings=SETTINGS):
    return city_queue.pick(wid, now, f, state, settings)


# -- pick --------------------------------------------------------------------------


def test_home_first_then_the_most_overdue_then_the_rest():
    f = fleet(roster({"ne-1": {"home": ["boston", "nyc"]}, "phl-1": {"home": ["philly"]}}))
    state = State()
    state.record("ne-1", "boston", T0 - 2 * DAY, 10)

    assert pick("ne-1", T0, f, state) == ("nyc", "home")  # never searched beats two days
    state.record("ne-1", "nyc", T0, 10)
    assert pick("ne-1", T0, f, state) == ("boston", "home")
    state.record("ne-1", "boston", T0, 10)
    assert pick("ne-1", T0, f, state) == ("philly", "other")
    state.record("ne-1", "philly", T0, 10)
    assert pick("phl-1", T0 + HOUR, f, state) == (None, "nothing_due")


def test_a_city_is_due_a_little_before_its_interval_is_up():
    f = fleet(roster({"bos-1": {"home": ["boston"]}}, catalog=CATALOG[:1]))
    state = State()
    state.record("bos-1", "boston", T0 - 21 * HOUR, 10)
    assert pick("bos-1", T0, f, state)[0] == "boston"  # 0.875 of a day
    state.record("bos-1", "boston", T0 - 20 * HOUR, 10)
    assert pick("bos-1", T0, f, state) == (None, "nothing_due")  # 0.83

    busy = fleet(
        roster({"bos-1": {"home": ["boston"]}}, catalog=CATALOG[:1]), per_day={"boston": 3}
    )
    state.record("bos-1", "boston", T0 - 7 * HOUR, 10)
    assert pick("bos-1", T0, busy, state)[0] == "boston"  # 0.875 of eight hours


def test_a_worker_searches_only_its_regions():
    r = roster({"ne-1": {"home": ["boston"]}})
    state = State()
    for city in ("boston", "nyc", "philly"):
        state.record("ne-1", city, T0, 10)
    assert pick("ne-1", T0 + HOUR, fleet(r), state) == (None, "nothing_due")

    wider = city_queue.validate_settings({"eligibility": {"ne-1": ["ne", "se"]}}, {})
    assert pick("ne-1", T0 + HOUR, fleet(r, wider), state, wider)[0] in ("dc", "atlanta")


def test_a_partner_widens_the_regions_but_keeps_its_cities():
    r = roster(
        {
            "ne-1": {"home": ["boston"], "partner_key": "PROXY_A"},
            "ne-1b": {"home": ["dc"], "partner_key": "PROXY_A"},
        }
    )
    state = State()
    for city in ("boston", "nyc", "philly"):
        state.record("ne-1", city, T0 - 3 * HOUR, 10)
    # Southeast is in reach through the partner's home, but dc is the partner's.
    assert pick("ne-1", T0, fleet(r), state) == ("atlanta", "other")


def test_a_city_both_partners_hold_goes_to_the_first_to_ask():
    r = roster(
        {
            "nyc-2": {"home": ["nyc"], "partner_key": "PROXY_A"},
            "nyc-2b": {"home": ["nyc"], "partner_key": "PROXY_A"},
        },
        catalog=CATALOG[1:2],
    )
    f = fleet(r)
    state = State()
    assert pick("nyc-2", T0, f, state) == ("nyc", "home")
    state.record("nyc-2", "nyc", T0, 10)
    assert pick("nyc-2b", T0 + 2 * DAY, f, state) == (None, "nothing_due")


def test_partners_never_search_at_once():
    r = roster(
        {
            "ne-1": {"home": ["boston"], "partner_key": "PROXY_A"},
            "ne-1b": {"home": ["nyc"], "partner_key": "PROXY_A"},
        }
    )
    f = fleet(r)
    state = State()
    assert pick("ne-1b", T0, f, state) == ("nyc", "home")
    state.record("ne-1b", "nyc", T0, 10)
    assert pick("ne-1", T0 + 5 * 60, f, state) == (None, "partner_busy")
    assert pick("ne-1", T0 + 39 * 60, f, state) == (None, "partner_busy")  # finished 29 min ago
    assert pick("ne-1", T0 + 41 * 60, f, state) == ("boston", "home")


def test_a_partners_recent_city_stays_off_limits():
    r = roster(
        {
            "ne-1": {"home": ["boston"], "partner_key": "PROXY_A"},
            "ne-1b": {"home": ["nyc"], "partner_key": "PROXY_A"},
        },
        catalog=CATALOG[:3],
    )
    f = fleet(r)
    state = State()
    state.record("ne-1", "philly", T0, 10)
    state.record("ne-1b", "nyc", T0 + 2 * DAY, 10)
    # Philly is two days overdue, but ne-1 searched it; boston is ne-1's own.
    assert pick("ne-1b", T0 + 2 * DAY + HOUR, f, state) == (None, "nothing_due")
    state.record("ne-1b", "nyc", T0 + 8 * DAY, 10)
    assert pick("ne-1b", T0 + 8 * DAY + HOUR, f, state) == ("philly", "other")


def test_the_budget_stops_a_worker_until_the_next_utc_day():
    f = fleet(roster({"ne-1": {"home": ["boston", "nyc"]}}))
    state = State()
    state.record("ne-1", "boston", T0 + 13 * HOUR, 180)
    assert pick("ne-1", T0 + 17 * HOUR, f, state) == (None, "budget")
    assert pick("ne-1", T0 + DAY + 13 * HOUR, f, state) == ("nyc", "home")


def test_a_quarantined_account_gets_nothing():
    f = fleet(roster({"nj-2b": {"home": ["nyc"]}}), quarantined={"nj-2b"})
    assert pick("nj-2b", T0, f, State()) == (None, "quarantined")


def test_familiar_cities_come_before_the_rest():
    f = fleet(roster({"ne-1": {"home": ["boston"]}}))
    state = State()
    state.record("ne-1", "boston", T0 - HOUR, 10)
    state.record("ne-1", "nyc", T0 - 3 * DAY, 10)
    # philly has never been searched, but nyc is one ne-1 knows.
    assert pick("ne-1", T0, f, state) == ("nyc", "familiar")


def test_a_city_outside_every_region_is_its_home_workers_alone():
    r = roster({"ca-1": {"home": ["reno"]}, "ne-1": {"home": ["boston"]}})
    f = fleet(r)
    state = State()
    for city in ("boston", "nyc", "philly"):
        state.record("ne-1", city, T0, 10)
    assert pick("ne-1", T0 + HOUR, f, state) == (None, "nothing_due")
    assert pick("ca-1", T0 + HOUR, f, state) == ("reno", "home")
    state.record("ca-1", "reno", T0 + HOUR, 10)
    assert pick("ca-1", T0 + 2 * HOUR, f, state) == (None, "nothing_due")


# -- what the log says ---------------------------------------------------------------


def search(wid, city, at, cards):
    return {
        "worker_id": wid,
        "city": city,
        "at": datetime.fromtimestamp(at, timezone.utc).isoformat(),
        "cards": cards,
    }


def test_an_account_that_sees_nothing_where_others_do_is_quarantined():
    rows = [
        search("nj-2b", "nyc", T0, 0),
        search("nj-2b", "nyc", T0 + HOUR, 0),
        search("nyc-1", "nyc", T0, 120),
        search("nyc-2", "nyc", T0, 100),
        # A city nobody gets anything from is empty, not a verdict.
        search("ca-1", "tinytown", T0, 0),
        search("ca-1", "tinytown", T0 + HOUR, 0),
        search("ca-2", "tinytown", T0, 0),
        # One search is not a pattern; one card is not blind.
        search("va-2b", "nyc", T0, 0),
        search("phl-1", "nyc", T0, 0),
        search("phl-1", "nyc", T0 + HOUR, 3),
    ]
    assert city_queue.quarantined(rows) == {
        "nj-2b": {"searches": 2, "cities": ["nyc"], "others_cards": {"nyc": 100}}
    }


def test_a_search_lasts_the_median_gap_between_reports():
    def at(minutes):
        return search("mw-1", "chicago", T0 + minutes * 60, 1)

    rows = [at(m) for m in (0, 5, 10, 16, 200, 205)]
    rows += [search("nj-2b", "nyc", T0 + m * 60, 0) for m in (0, 1, 2, 3)]
    rows += [search("phl-1", "philly", T0 + m * 60, 1) for m in (0, 5, 10)]
    assert city_queue.search_minutes(rows) == {"mw-1": 5.0, "nj-2b": 2.0}


def test_availability_follows_the_status_changes():
    now = datetime.fromtimestamp(T0 + 6 * HOUR, timezone.utc)
    beat = now.isoformat()

    def event(wid, kind, hours, was, became):
        stamp = datetime.fromtimestamp(T0 + hours * HOUR, timezone.utc).isoformat()
        return {"worker_id": wid, "kind": kind, "at": stamp, "was": was, "became": became}

    up = city_queue.availability(
        [
            {"worker_id": "ne-1", "state": "HEALTHY", "last_heartbeat_at": beat},
            {"worker_id": "nj-1", "state": "SESSION_EXPIRED", "last_heartbeat_at": beat},
            {"worker_id": "mw-1", "state": "HEALTHY", "last_heartbeat_at": beat},
        ],
        [
            event("ne-1", "state", 1, "HEALTHY", "CHECKPOINT"),
            event("ne-1", "state", 5, "CHECKPOINT", "HEALTHY"),
            event("mw-1", "liveness", 2, "live", "dead"),
        ],
        now,
    )
    assert [up("ne-1", T0 + h * HOUR) for h in (0, 2, 6)] == [True, False, True]
    assert not up("nj-1", T0)
    assert up("mw-1", T0 + HOUR) and not up("mw-1", T0 + 3 * HOUR)
    assert not up("se-1", T0)  # never reported


# -- the replay ---------------------------------------------------------------------


def spread_roster():
    catalog = [{"slug": f"c{i:02}", "name": None, "region": "ne"} for i in range(18)]
    return roster(
        {
            "big": {"home": [f"c{i:02}" for i in range(14)]},
            "small-1": {"home": ["c14", "c15"]},
            "small-2": {"home": ["c16", "c17"]},
        },
        catalog=catalog,
    )


def test_the_replay_spreads_a_long_list_over_idle_neighbours():
    r = spread_roster()
    settings = city_queue.validate_settings({"budget_minutes": 60}, {})
    f = city_queue.build_fleet(r, {}, settings)
    start, end = T0 + DAY, T0 + 3 * DAY

    def run():
        return city_queue.simulate(r, f, settings, start, end, [], lambda w, t: True, {})

    visits, _ = run()
    window = [v for v in visits if v.at >= start]
    for day in (1, 2):
        today = [v for v in window if int(v.at // DAY) == int(T0 // DAY) + day]
        assert sorted(v.city for v in today) == [f"c{i:02}" for i in range(18)]
        for wid in ("big", "small-1", "small-2"):
            mine = [v for v in today if v.worker_id == wid]
            assert sum(v.minutes for v in mine) <= 60
            assert len(mine) == 6  # 4.75-minute searches, two phrases each
    assert [(v.worker_id, v.city, v.at) for v in run()[0]] == [
        (v.worker_id, v.city, v.at) for v in visits
    ]


def test_the_replay_keeps_partners_apart():
    catalog = [{"slug": f"c{i}", "name": None, "region": "ne"} for i in range(6)]
    r = roster(
        {
            "a": {"home": ["c0", "c1", "c2"], "partner_key": "PROXY_A"},
            "b": {"home": ["c3", "c4", "c5"], "partner_key": "PROXY_A"},
        },
        catalog=catalog,
    )
    f = city_queue.build_fleet(r, {}, SETTINGS)
    visits, idle = city_queue.simulate(
        r, f, SETTINGS, T0 + DAY, T0 + 2 * DAY, [], lambda w, t: True, {}
    )
    assert {v.city for v in visits if v.worker_id == "a"} == {"c0", "c1", "c2"}
    assert {v.city for v in visits if v.worker_id == "b"} == {"c3", "c4", "c5"}
    ordered = sorted(visits, key=lambda v: v.at)
    for one, two in zip(ordered, ordered[1:]):
        if one.worker_id != two.worker_id:
            assert two.at >= one.at + (one.minutes + SETTINGS["partner_gap_minutes"]) * 60
    assert idle["a"]["partner_busy"] or idle["b"]["partner_busy"]


def test_the_report_counts_a_blind_account_against_itself_only():
    r = roster(
        {"ne-1": {"home": ["boston", "nyc", "philly"]}, "nj-2b": {"home": ["nyc"]}},
        catalog=CATALOG[:3],
    )
    start, end = T0 + DAY, T0 + 2 * DAY
    rows = [
        search("ne-1", c, start + 13 * HOUR + i * 600, 100)
        for i, c in enumerate(("boston", "nyc", "philly"))
    ]
    rows += [search("nj-2b", "nyc", start + 17 * HOUR + i * 60, 0) for i in range(2)]
    beat = datetime.fromtimestamp(end, timezone.utc).isoformat()
    workers = [
        {"worker_id": "ne-1", "state": "HEALTHY", "last_heartbeat_at": beat},
        {"worker_id": "nj-2b", "state": "HEALTHY", "last_heartbeat_at": beat},
    ]
    report = city_queue.shadow_report(r, SETTINGS, {}, {}, rows, [], workers, start, end)

    assert [q["worker_id"] for q in report["quarantined"]] == ["nj-2b"]
    by_city = {c["slug"]: c for c in report["cities"]}
    assert by_city["nyc"]["actual"]["searches"] == 1 and by_city["nyc"]["actual"]["redundant"] == 0
    by_worker = {w["worker_id"]: w for w in report["workers"]}
    assert by_worker["nj-2b"]["actual"]["zero_card_searches"] == 2
    assert by_worker["nj-2b"]["shadow"]["searches"] == 0
    assert by_worker["ne-1"]["shadow"]["searches"] == 6  # three cities, two phrases
    assert set(report["fleet"]["shadow"]) == set(report["fleet"]["actual"])


def test_a_window_older_than_the_log_is_marked_partial():
    r = roster({"ne-1": {"home": ["boston"]}}, catalog=CATALOG[:1])
    rows = [search("ne-1", "boston", T0 + 2 * DAY, 100)]
    report = city_queue.shadow_report(r, SETTINGS, {}, {}, rows, [], [], T0, T0 + 3 * DAY)
    assert report["partial"] is True and report["log_since"].startswith("2026-10-22")


# -- settings and the route ---------------------------------------------------------------


def test_settings_are_checked_and_layered_on_the_stored_tiers():
    s = city_queue.validate_settings(
        {"budget_minutes": 240, "tiers": {"per_day": [2, 1, 1]}}, {"top_pct": 10}
    )
    assert s["budget_minutes"] == 240 and s["window_hours"] == 8
    assert s["tiers"] == {**city_tiers.DEFAULTS, "top_pct": 10, "per_day": [2, 1, 1]}
    for bad in (
        {"budget_minutes": 5},
        {"early": 1},
        {"nope": 1},
        {"eligibility": {"a": "ne"}},
        {"tiers": {"per_day": [1, 2, 3]}},
    ):
        with pytest.raises(city_queue.QueueError):
            city_queue.validate_settings(bad, {})


@pytest.mark.parametrize(
    "body",
    [
        None,
        {"catalog": [], "workers": {}},
        {"catalog": [{"slug": ""}], "workers": {"a": {}}},
        {"catalog": [], "workers": {"a": {"start_at": ["25:00"]}}},
        {"catalog": [], "workers": {"a": {"phrases": 0}}},
        {"catalog": [], "workers": {"a": {"home": "boston"}}},
    ],
)
def test_a_bad_roster_is_refused(body):
    with pytest.raises(city_queue.QueueError):
        city_queue.validate_roster(body)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", "worker-token-secret")
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    monkeypatch.delenv("TELEGRAM_OPS_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)
    yield TestClient(app_module.app)


ROSTER = {
    "catalog": [
        {"slug": "chicago", "name": "Chicago, IL", "region": "mw"},
        {"slug": "peoria", "name": "Peoria, IL", "region": "mw"},
    ],
    "workers": {
        "mw-1": {
            "home": ["chicago", "peoria"],
            "partner_key": "PROXY_MW",
            "start_at": ["13:00"],
            "phrases": 2,
        },
        "mw-1b": {"home": [], "partner_key": "PROXY_MW", "start_at": ["17:00"], "phrases": 2},
    },
}


def test_the_route_is_admin_only_and_checks_its_body(client):
    assert (
        client.post("/v1/queue/shadow", json={"roster": ROSTER}, headers=LEGACY).status_code == 401
    )
    assert client.post("/v1/queue/shadow", json={"roster": {}}, headers=ADMIN).status_code == 422
    assert (
        client.post(
            "/v1/queue/shadow", json={"roster": ROSTER, "days": 15}, headers=ADMIN
        ).status_code
        == 422
    )
    bad = client.post(
        "/v1/queue/shadow",
        json={"roster": ROSTER, "settings": {"budget_minutes": 1}},
        headers=ADMIN,
    )
    assert bad.status_code == 422 and "budget_minutes" in bad.json()["detail"]


def test_the_route_replays_the_log_and_saves_nothing(client):
    for wid, cards in (("mw-1", 120), ("mw-1", 80), ("mw-1b", 0), ("mw-1b", 0)):
        r = client.post(
            "/v1/stats/reviews",
            json={"worker_id": wid, "searches": 1, "cards": cards, "search_city": "chicago"},
            headers=LEGACY,
        )
        assert r.status_code == 200
    for wid in ("mw-1", "mw-1b"):
        client.post("/v1/heartbeat", json={"worker_id": wid, "state": "HEALTHY"}, headers=LEGACY)

    res = client.post(
        "/v1/queue/shadow",
        json={"roster": ROSTER, "days": 1, "settings": {"tiers": {"per_day": [2, 1, 1]}}},
        headers=ADMIN,
    )
    assert res.status_code == 200
    report = res.json()
    assert [q["worker_id"] for q in report["quarantined"]] == ["mw-1b"]
    workers = {w["worker_id"]: w for w in report["workers"]}
    assert workers["mw-1"]["actual"]["searches"] == 2 and workers["mw-1"]["partners"] == ["mw-1b"]
    assert report["settings"]["tiers"]["per_day"] == [2, 1, 1]
    assert report["window"]["days"] == 1

    stored = client.get("/v1/city-tiers", headers=ADMIN).json()
    assert stored["settings"] == city_tiers.DEFAULTS


def test_the_window_reaches_back_no_further_than_asked(client):
    old = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat(timespec="seconds")
    import rs_coordinator.deps as deps_module

    with deps_module.db.cursor() as cur:
        cur.execute(
            "INSERT INTO city_searches (worker_id, city, at, cards) VALUES (?, ?, ?, ?)",
            ("mw-1", "chicago", old, 50),
        )
    report = client.post(
        "/v1/queue/shadow", json={"roster": ROSTER, "days": 2}, headers=ADMIN
    ).json()
    workers = {w["worker_id"]: w for w in report["workers"]}
    assert workers["mw-1"]["actual"]["searches"] == 0
    assert report["partial"] is False
