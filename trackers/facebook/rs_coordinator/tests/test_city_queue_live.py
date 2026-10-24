"""The live city queue: enrolled workers ask for their next city.

The contract, on the owner's first-stage defaults (any region, no partner
rules, once a day, 6 hours an account): each (item, city) is handed out once
a day; a city a live worker outside the queue holds stays its own; a worker
outside its start_at window, past its budget or quarantined gets nothing; a
lease lives while its worker reports HEALTHY and comes back to the queue the
moment it parks; and the answer is always a 200, so the monitor falls back to
its own list only when the queue cannot be reached.
"""

import importlib
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from rs_coordinator import city_queue
from rs_coordinator.city_queue import DAY, Live, State
from rs_coordinator.db import Database
from rs_coordinator.tokens import mint_worker_token

ADMIN = {"Authorization": "Bearer admin-token"}
LEGACY = {"Authorization": "Bearer test-token"}
SECRET = "worker-token-secret"
# A UTC midnight, so start_at times land on the day they name.
T0 = datetime(2026, 10, 20, tzinfo=timezone.utc).timestamp()
HOUR = 3600.0
DEFAULTS = city_queue.validate_settings({}, {})

CATALOG = [
    {"slug": "boston", "name": "Boston, MA", "region": "ne", "radius": 100},
    {"slug": "nyc", "name": "New York, NY", "region": "ne", "radius": 100},
    {"slug": "miami", "name": "Miami, FL", "region": "se", "radius": 100},
    {"slug": "reno", "name": "Reno, NV", "region": "mtn", "radius": 60},
]


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat(timespec="seconds")


def roster(workers, catalog=CATALOG):
    return city_queue.validate_roster(
        {
            "catalog": catalog,
            "workers": {w: {"start_at": ["13:00"], **b} for w, b in workers.items()},
        }
    )


# -- the owner's defaults ----------------------------------------------------------


def test_the_first_stage_defaults():
    s = DEFAULTS
    assert (s["regions"], s["partners"], s["per_day"], s["budget_minutes"]) == (
        "any",
        False,
        1,
        360,
    )
    assert s["enrolled"] == [] and s["window_hours"] == 8 and s["lease_minutes"] == 30


def test_any_region_and_no_partner_rules_by_default():
    r = roster(
        {
            "ca-4b": {"home": ["reno"], "partner_key": "PROXY_CA4"},
            "ca-4": {"home": ["miami"], "partner_key": "PROXY_CA4"},
        }
    )
    f = city_queue.build_fleet(r, {}, DEFAULTS)
    state = State()
    state.record("ca-4b", "reno", T0, 10)
    # A Palo Alto exit takes the partner's home city, while the partner is mid-search.
    state.record("ca-4", "boston", T0, 10)
    assert city_queue.pick("ca-4b", T0 + 60, f, state, DEFAULTS) == ("miami", "other")


def test_a_city_held_outside_the_queue_stays_its_holders():
    r = roster({"homelab-1": {"home": ["miami"]}, "ne-1": {"home": ["boston", "nyc"]}})
    f = city_queue.build_fleet(r, {}, DEFAULTS, held={"boston", "nyc", "miami"})
    state = State()
    assert city_queue.pick("homelab-1", T0, f, state, DEFAULTS) == ("miami", "home")
    state.record("homelab-1", "miami", T0, 10)
    assert city_queue.pick("homelab-1", T0, f, state, DEFAULTS) == ("reno", "other")


def test_the_window_follows_start_at():
    assert city_queue.daily_times(["13:00:00", "17:00", "*:15", "*:*:30"]) == ["13:00", "17:00"]
    assert city_queue.in_window(["13:00"], T0 + 13 * HOUR + 300, 8)
    assert city_queue.in_window(["13:00"], T0 + 20 * HOUR + 3540, 8)
    assert not city_queue.in_window(["13:00"], T0 + 21 * HOUR + 60, 8)
    assert not city_queue.in_window(["13:00"], T0 + 3 * HOUR, 8)
    # A 17:00 window runs past midnight into the next UTC day.
    assert city_queue.in_window(["17:00"], T0 + DAY + 30 * 60, 8)
    assert city_queue.in_window([], T0 + 3 * HOUR, 8)


# -- the state from the coordinator's rows -------------------------------------------


def search(wid, city, at, cards=100, item=None):
    return {"worker_id": wid, "city": city, "at": iso(at), "cards": cards, "item": item}


def lease(wid, item, city, at, minutes=30, closed=None, expires=None):
    return {
        "worker_id": wid,
        "item": item,
        "city": city,
        "leased_at": iso(at),
        "expires_at": iso(expires if expires is not None else at + minutes * 60),
        "closed_at": iso(closed) if closed is not None else None,
    }


def test_a_visit_is_per_item_and_an_abandoned_lease_visits_nothing():
    now = T0 + 14 * HOUR
    searches = [
        search("ne-1", "boston", T0 + 13 * HOUR, item="server_ram"),
        search("old-1", "NYC", T0 + 13 * HOUR),  # no item: an older worker searched both
        search("nj-2b", "miami", T0 + 13 * HOUR, cards=0, item="server_ram"),
    ]
    leases = [
        lease("ne-1", "server_ram", "reno", now - 600),  # live
        lease("ne-1", "enterprise_ssd", "boston", now - 3600, closed=now - 3000),
        lease("va-2", "server_ram", "miami", now - 7200, expires=now - 3600),  # abandoned
    ]
    ram = city_queue.live_state("server_ram", now, searches, [], leases, blind={"nj-2b"})
    assert set(ram.last_visit) == {"boston", "nyc", "reno"}
    ssd = city_queue.live_state("enterprise_ssd", now, searches, [], leases, blind={"nj-2b"})
    assert set(ssd.last_visit) == {"nyc", "boston"}
    # Minutes: 10 so far on the live lease, 10 on the closed one, 30 abandoned.
    assert round(ram.minutes[("ne-1", int(now // DAY))]) == 20
    assert round(ram.minutes[("va-2", int(now // DAY))]) == 60


def test_the_budget_counts_lease_minutes():
    now = T0 + 20 * HOUR
    leases = [lease("ne-1", "server_ram", "boston", T0 + 13 * HOUR, closed=T0 + 19 * HOUR)]
    state = city_queue.live_state("server_ram", now, [], [], leases, ())
    f = city_queue.build_fleet(roster({"ne-1": {"home": ["nyc"]}}), {}, DEFAULTS)
    assert city_queue.pick("ne-1", now, f, state, DEFAULTS) == (None, "budget")


def live(rows=(), leases=(), workers=None, r=None, seeded=(), log_since=None):
    return Live(
        roster=r or roster({"ne-1": {"home": ["boston"]}, "homelab-1": {"home": ["miami"]}}),
        worker_rows=(
            workers
            if workers is not None
            else [
                {"worker_id": "ne-1", "state": "HEALTHY", "last_heartbeat_at": iso(T0 + 13 * HOUR)},
                {
                    "worker_id": "homelab-1",
                    "state": "HEALTHY",
                    "last_heartbeat_at": iso(T0 + 13 * HOUR),
                },
            ]
        ),
        searches=list(rows),
        seeded=list(seeded),
        leases=list(leases),
        log_since=log_since,
        scores={},
        pins={},
    )


ENROLLED = city_queue.validate_settings({"enrolled": ["homelab-1"]}, {})


def test_next_city_answers():
    now = T0 + 13 * HOUR + 60
    ask = lambda settings, data, at=now: city_queue.next_city(  # noqa: E731
        "homelab-1", "server_ram", ["miami"], ["13:00"], at, settings, data
    )
    assert ask(DEFAULTS, live()) == {"queue": False}
    assert ask(ENROLLED, live(), at=T0 + 3 * HOUR)["reason"] == "outside_window"
    # ne-1 is live and outside the queue, so boston is its; miami is home first.
    answer = ask(ENROLLED, live())
    assert answer == {
        "queue": True,
        "city": {"slug": "miami", "name": "Miami, FL", "radius": 100},
        "why": "home",
    }
    blind = [
        search("homelab-1", "nyc", now - 600, cards=0),
        search("homelab-1", "nyc", now - 300, cards=0),
    ]
    blind.append(search("ne-1", "nyc", now - 900, cards=120))
    assert ask(ENROLLED, live(blind))["reason"] == "quarantined"


def test_the_round_ends_when_every_city_is_searched():
    now = T0 + 14 * HOUR
    rows = [search("x", c, T0 + 13 * HOUR, item="server_ram") for c in ("miami", "nyc", "reno")]
    answer = city_queue.next_city(
        "homelab-1", "server_ram", ["miami"], ["13:00"], now, ENROLLED, live(rows)
    )
    assert answer == {"queue": True, "city": None, "reason": "nothing_due"}
    # The other item's round is its own.
    other = city_queue.next_city(
        "homelab-1", "enterprise_ssd", ["miami"], ["13:00"], now, ENROLLED, live(rows)
    )
    assert other["city"]["slug"] == "miami"


def test_a_parked_holder_frees_its_cities_and_seeds_count_only_before_the_log():
    now = T0 + 13 * HOUR + 60
    parked = [
        {"worker_id": "ne-1", "state": "CHECKPOINT", "last_heartbeat_at": iso(now)},
        {"worker_id": "homelab-1", "state": "HEALTHY", "last_heartbeat_at": iso(now)},
    ]
    seen = [search("homelab-1", "miami", now - 60, item="server_ram")]
    # Yesterday's sweep, from before the log, counts; today's last search of
    # nyc is in the log for one item only and must not close the other.
    seeded = [
        {"worker_id": "ne-1", "city": "boston", "last_at": iso(now - 3600)},
        {"worker_id": "ne-1", "city": "nyc", "last_at": iso(now - 60)},
    ]
    data = live(seen, workers=parked, seeded=seeded, log_since=now - 1800)
    answer = city_queue.next_city(
        "homelab-1", "server_ram", ["miami"], ["13:00"], now, ENROLLED, data
    )
    assert answer["city"]["slug"] in ("nyc", "reno")
    assert answer["city"]["slug"] != "boston"


# -- the routes ---------------------------------------------------------------------


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", SECRET)
    for name in ("TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_OPS_CHAT_ID"):
        monkeypatch.delenv(name, raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)
    test_client = TestClient(app_module.app)
    test_client.deps = deps_module
    yield test_client


def auth(wid):
    return {"Authorization": f"Bearer {mint_worker_token(wid, SECRET)}"}


def now_window():
    # A start_at a minute ago: the test runs inside the window whenever it runs.
    return [(datetime.now(timezone.utc) - timedelta(minutes=1)).strftime("%H:%M")]


ROSTER = {
    "catalog": CATALOG,
    "workers": {
        "homelab-1": {"home": ["miami"], "start_at": ["13:00"]},
        "nyc-1": {"home": ["nyc"], "start_at": ["13:00"]},
        "ne-1": {"home": ["boston"], "start_at": ["13:00"]},
    },
}


def beat(client, wid, state="HEALTHY", version="0.13.16 (test)"):
    body = {"worker_id": wid, "state": state, "version": version}
    assert client.post("/v1/heartbeat", json=body, headers=LEGACY).status_code == 200


def ask(client, wid, item="server_ram", done=None, home=()):
    res = client.post(
        f"/v1/workers/{wid}/next-city",
        json={"item": item, "home": list(home), "start_at": now_window(), "done": done},
        headers=auth(wid),
    )
    assert res.status_code == 200, res.text
    return res.json()


def setup_pilot(client):
    assert client.put("/v1/queue/roster", json=ROSTER, headers=ADMIN).json() == {
        "cities": 4,
        "workers": 3,
    }
    res = client.put("/v1/queue/settings", json={"enrolled": ["homelab-1", "nyc-1"]}, headers=ADMIN)
    assert res.status_code == 200
    for wid in ("homelab-1", "nyc-1", "ne-1"):
        beat(client, wid)


def test_next_city_checks_who_asks_and_what(client):
    url = "/v1/workers/nyc-1/next-city"
    assert client.post(url, json={"item": "server_ram"}, headers=auth("ne-1")).status_code == 403
    assert client.post(url, json={"item": ""}, headers=auth("nyc-1")).status_code == 422
    assert (
        client.post(url, json={"item": "x", "home": "nyc"}, headers=auth("nyc-1")).status_code
        == 422
    )
    assert ask(client, "nyc-1") == {"queue": False}


def test_each_city_is_handed_out_once_and_a_held_one_never(client):
    setup_pilot(client)
    handed = []
    done = {"homelab-1": None, "nyc-1": None}
    for _ in range(4):
        for wid, home in (("homelab-1", ["miami"]), ("nyc-1", ["nyc"])):
            answer = ask(client, wid, done=done[wid], home=home)
            city = (answer.get("city") or {}).get("slug")
            done[wid] = city
            if city:
                handed.append((wid, city))
    cities = [c for _, c in handed]
    # Boston is ne-1's, which is live and outside the queue.
    assert sorted(cities) == ["miami", "nyc", "reno"] and ("homelab-1", "miami") in handed
    assert (
        ask(client, "homelab-1", done=done["homelab-1"], home=["miami"])["reason"] == "nothing_due"
    )
    # The other item has a round of its own.
    assert ask(client, "nyc-1", item="enterprise_ssd", home=["nyc"])["city"]["slug"] == "nyc"

    status = client.get("/v1/queue/status", headers=ADMIN).json()
    ram = status["items"]["server_ram"]
    assert (ram["searched"], ram["held"], ram["due"], ram["leased"], ram["queue"]) == (
        3,
        1,
        0,
        0,
        3,
    )
    by_city = {c["slug"]: c for c in status["cities"]}
    assert by_city["boston"]["held_by"] == "ne-1"
    assert by_city["boston"]["items"]["server_ram"]["state"] == "held"
    assert by_city["reno"]["items"]["server_ram"]["state"] == "searched"
    assert by_city["nyc"]["items"]["enterprise_ssd"] == {
        "state": "leased",
        "at": by_city["nyc"]["items"]["enterprise_ssd"]["at"],
        "by": "nyc-1",
    }
    workers = {w["worker_id"]: w for w in status["workers"]}
    assert workers["nyc-1"]["enrolled"] and workers["nyc-1"]["capable"]
    assert workers["nyc-1"]["handed"][0] == "nyc" and workers["nyc-1"]["open"][0]["city"] == "nyc"
    assert not workers["ne-1"]["enrolled"] and workers["ne-1"]["handed_today"] == 0


def test_a_parked_worker_gives_its_city_back(client):
    setup_pilot(client)
    first = ask(client, "homelab-1", home=["miami"])["city"]["slug"]
    assert first == "miami"
    beat(client, "homelab-1", "CHECKPOINT")
    # nyc-1 has its own home first, then miami again: the parked lease is gone.
    assert ask(client, "nyc-1", home=["nyc"])["city"]["slug"] == "nyc"
    assert ask(client, "nyc-1", done="nyc", home=["nyc"])["city"]["slug"] == "miami"


def test_a_healthy_heartbeat_keeps_the_lease(client):
    setup_pilot(client)
    ask(client, "homelab-1", home=["miami"])
    db = client.deps.db
    (before,) = db.city_leases_since("0")
    with db.cursor() as cur:
        cur.execute(
            "UPDATE city_leases SET expires_at = ?",
            (iso(datetime.now(timezone.utc).timestamp() + 60),),
        )
    beat(client, "homelab-1")
    (after,) = db.city_leases_since("0")
    assert after["expires_at"] >= before["expires_at"] and after["closed_at"] is None


def test_settings_store_only_what_was_set(client):
    assert client.get("/v1/queue/settings", headers=LEGACY).status_code == 401
    view = client.get("/v1/queue/settings", headers=ADMIN).json()
    assert view["settings"]["budget_minutes"] == 360 and view["updated_at"] is None
    res = client.put(
        "/v1/queue/settings", json={"budget_minutes": 300, "updated_by": "alex"}, headers=ADMIN
    )
    assert res.json()["settings"]["budget_minutes"] == 300 and res.json()["updated_by"] == "alex"
    assert client.deps.db.queue_config("settings")["body"] == {"budget_minutes": 300}
    for bad in ({"tiers": {}}, {"regions": "west"}, {"per_day": 9}, {"enrolled": "ne-1"}):
        assert client.put("/v1/queue/settings", json=bad, headers=ADMIN).status_code == 422, bad
    assert client.put("/v1/queue/roster", json={"catalog": []}, headers=ADMIN).status_code == 422


# -- rsc queue and the schema ---------------------------------------------------------


def test_rsc_queue_enrolls_sets_and_reports(tmp_path, monkeypatch, capsys):
    from rs_coordinator import cli

    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "cli.db"))
    monkeypatch.delenv("RS_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert cli.main(["queue", "enroll", "homelab-1", "nyc-1"]) == 0
    assert cli.main(["queue", "unenroll", "nyc-1"]) == 0
    assert cli.main(["queue", "set", "budget_minutes=300", "regions=home"]) == 0
    assert cli.main(["queue", "set", "per_day=9"]) == 1
    capsys.readouterr()
    assert cli.main(["queue", "show"]) == 0
    shown = capsys.readouterr().out
    assert '"enrolled": [\n    "homelab-1"\n  ]' in shown and '"budget_minutes": 300' in shown
    assert cli.main(["queue", "enroll", "--all"]) == 0
    assert cli.main(["queue", "unenroll", "ne-1"]) == 1
    assert cli.main(["queue", "status"]) == 0
    assert "enrolled *" in capsys.readouterr().out


def test_an_existing_city_search_log_gains_its_item_column(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE city_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, worker_id TEXT NOT NULL,"
        " city TEXT NOT NULL, at TEXT NOT NULL, cards INTEGER NOT NULL DEFAULT 0,"
        " opened INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0,"
        " alerted INTEGER NOT NULL DEFAULT 0)"
    )
    earlier = iso(datetime.now(timezone.utc).timestamp() - 3600)
    conn.execute(
        "INSERT INTO city_searches (worker_id, city, at) VALUES ('ne-1', 'boston', ?)", (earlier,)
    )
    conn.commit()
    conn.close()
    db = Database(path)
    db.log_city_search("ne-1", "nyc", cards=5, item="server_ram")
    rows = db.city_searches_since("0")
    assert [(r["city"], r["item"]) for r in rows] == [("boston", None), ("nyc", "server_ram")]


# -- who can pull, and enrolling one worker ------------------------------------------


def test_only_a_monitor_from_the_queue_on_can_pull():
    assert city_queue.capable({"version": "0.13.14 (93e2566)"})
    assert city_queue.capable({"version": "0.14.0"}) and city_queue.capable({"version": "1.0.0"})
    assert not city_queue.capable({"version": "0.13.12 (96d9204)"})
    assert not city_queue.capable({"version": "unknown (unknown)"})
    assert not city_queue.capable({"version": None}) and not city_queue.capable(None)


def test_an_enrolled_worker_on_an_old_monitor_keeps_its_cities():
    now = T0 + 13 * HOUR
    everyone = city_queue.validate_settings({"enrolled": ["*"]}, {})
    rows = [
        {
            "worker_id": "ne-1",
            "state": "HEALTHY",
            "last_heartbeat_at": iso(now),
            "version": "0.13.12",
        },
        {
            "worker_id": "homelab-1",
            "state": "HEALTHY",
            "last_heartbeat_at": iso(now),
            "version": "0.13.16",
        },
    ]
    r = roster({"ne-1": {"home": ["boston", "nyc"]}, "homelab-1": {"home": ["miami"]}})
    assert city_queue.held_by(r, everyone, rows, (), now) == {"boston": "ne-1", "nyc": "ne-1"}


def test_the_round_names_each_city_state_before_anyone_searched():
    now = T0 + 12 * HOUR
    r = city_queue.validate_roster(
        {"catalog": CATALOG, "items": ["server_ram"], "workers": {"ne-1": {"home": ["boston"]}}}
    )
    data = live(
        r=r,
        workers=[],
        seeded=[{"worker_id": "x", "city": "reno", "last_at": iso(now - 20 * HOUR)}],
    )
    status = city_queue.queue_status(now, DEFAULTS, data)
    assert list(status["items"]) == ["server_ram"]
    states = {c["slug"]: c["items"]["server_ram"]["state"] for c in status["cities"]}
    # ne-1 has no heartbeat, so boston is not held; reno was searched 20 h ago.
    assert states == {"boston": "due", "nyc": "due", "miami": "due", "reno": "later"}
    reno = next(c for c in status["cities"] if c["slug"] == "reno")["items"]["server_ram"]
    assert reno["at"] == iso(now - 20 * HOUR + 0.85 * DAY) and reno["by"] == "x"
    assert status["items"]["server_ram"]["queue"] == 4 and not status["everyone"]


def test_a_roster_names_its_items():
    r = city_queue.validate_roster({"catalog": [], "items": ["a", "b", "a"], "workers": {"w": {}}})
    assert r.items == ["a", "b"] and r.dump()["items"] == ["a", "b"]
    with pytest.raises(city_queue.QueueError):
        city_queue.validate_roster({"catalog": [], "items": "a", "workers": {"w": {}}})


def test_one_worker_goes_in_and_out_of_the_queue(client):
    assert client.put("/v1/queue/roster", json=ROSTER, headers=ADMIN).status_code == 200
    beat(client, "nyc-1")
    beat(client, "ne-1", version="0.13.12 (96d9204)")
    url = "/v1/workers/{}/queue"
    assert (
        client.put(url.format("nyc-1"), json={"enrolled": True}, headers=LEGACY).status_code == 401
    )
    assert (
        client.put(url.format("nyc-1"), json={"enrolled": "yes"}, headers=ADMIN).status_code == 422
    )

    old = client.put(url.format("ne-1"), json={"enrolled": True}, headers=ADMIN)
    assert (
        old.status_code == 409
        and "0.13.12" in old.json()["detail"]
        and "Redeploy" in old.json()["detail"]
    )
    never = client.put(url.format("ghost"), json={"enrolled": True}, headers=ADMIN)
    assert never.status_code == 409 and "an unknown version" in never.json()["detail"]

    res = client.put(
        url.format("nyc-1"), json={"enrolled": True, "updated_by": "Alex"}, headers=ADMIN
    )
    assert res.json() == {"worker_id": "nyc-1", "enrolled": True, "everyone": False}
    stored = client.deps.db.queue_config("settings")
    assert stored["body"] == {"enrolled": ["nyc-1"]} and stored["updated_by"] == "Alex"

    # Out of "every worker": the others are named instead.
    client.put("/v1/queue/settings", json={"enrolled": ["*"]}, headers=ADMIN)
    out = client.put(url.format("nyc-1"), json={"enrolled": False}, headers=ADMIN).json()
    assert out == {"worker_id": "nyc-1", "enrolled": False, "everyone": False}
    assert client.deps.db.queue_config("settings")["body"]["enrolled"] == ["homelab-1", "ne-1"]
