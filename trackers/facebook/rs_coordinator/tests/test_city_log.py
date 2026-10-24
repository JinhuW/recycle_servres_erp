"""The city log: each city on each worker, from its handout or start to its
end.

The steps come from both sides: the coordinator logs the hand-out, each search
page, each alert and a lease given back; the monitor reports started, finished
(with the city's counts) and stopped. A visit's end is the monitor's own word
when it sent one, else its lease, else the worker moving on to another city,
which is all an older monitor leaves.
"""

import importlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from rs_coordinator import city_log
from rs_coordinator.tokens import mint_worker_token

ADMIN = {"Authorization": "Bearer admin-token"}
LEGACY = {"Authorization": "Bearer test-token"}
SECRET = "worker-token-secret"
T0 = datetime(2026, 10, 24, 13, tzinfo=timezone.utc).timestamp()
NAMES = {"miami": "Miami, FL", "nyc": "New York, NY", "reno": "Reno, NV"}


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat(timespec="seconds")


def ev(wid, item, city, event, at, **detail):
    return {
        "worker_id": wid,
        "item": item,
        "city": city,
        "event": event,
        "at": iso(T0 + at),
        "detail": detail,
    }


def lease(wid, item, city, at, closed=None, expires=None):
    return {
        "worker_id": wid,
        "item": item,
        "city": city,
        "leased_at": iso(T0 + at),
        "expires_at": iso(T0 + (expires if expires is not None else at + 1800)),
        "closed_at": iso(T0 + closed) if closed is not None else None,
        "why": "home",
    }


def page(wid, item, city, at, phrase=None, cards=30, opened=2, reviewed=1, alerted=0):
    detail = dict(cards=cards, title_pass=4, opened=opened, keyword_pass=2, fresh=1)
    detail.update(reviewed=reviewed, alerted=alerted)
    if phrase:
        detail["phrase"] = phrase
    return ev(wid, item, city, "searched", at, **detail)


def one(found, city):
    (visit,) = [v for v in found if v["city"] == city]
    return visit


# -- grouping the steps into visits --------------------------------------------------


def test_a_queue_city_on_a_new_monitor_reads_from_handout_to_its_report():
    events = [
        ev("nyc-1", "server_ram", "miami", "handed", 0, why="home"),
        ev("nyc-1", "server_ram", "miami", "started", 1, searches=2, radius=100, via="queue"),
        page("nyc-1", "server_ram", "miami", 60, phrase="dell poweredge", alerted=1),
        ev(
            "nyc-1",
            "server_ram",
            "miami",
            "alerted",
            70,
            title="Dell R740 2x Gold 6148",
            price="$900",
            score=4,
            url="https://fb/1",
        ),
        page("nyc-1", "server_ram", "miami", 150, phrase="hp proliant", cards=0, opened=0),
        ev(
            "nyc-1",
            "server_ram",
            "miami",
            "finished",
            151,
            searches=2,
            cards=31,
            opened=2,
            reviewed=2,
            alerted=1,
            empty=1,
            seconds=150,
        ),
    ]
    (visit,) = city_log.visits(
        events, [lease("nyc-1", "server_ram", "miami", 0, closed=152)], NAMES, T0 + 600
    )
    assert visit["name"] == "Miami, FL" and (visit["via"], visit["why"]) == ("queue", "home")
    assert (visit["outcome"], visit["reported"], visit["seconds"]) == ("finished", True, 150)
    assert visit["totals"]["cards"] == 31 and visit["totals"]["empty"] == 1
    assert visit["alerts"][0]["title"] == "Dell R740 2x Gold 6148"
    assert [e["event"] for e in visit["events"]] == [
        "handed",
        "started",
        "searched",
        "alerted",
        "searched",
        "finished",
    ]
    assert city_log.summary(visit["totals"]) == (
        "2 searches, 31 cards, 2 opened, 2 reviewed, 1 alert, 1 empty"
    )


def test_an_older_queue_monitor_ends_its_visit_when_its_lease_closes():
    events = [
        ev("va-2", "server_ram", "reno", "handed", 0, why="other"),
        page("va-2", "server_ram", "reno", 60),
        page("va-2", "server_ram", "reno", 120),
        page("va-2", "server_ram", "reno", 180),
    ]
    (visit,) = city_log.visits(
        events, [lease("va-2", "server_ram", "reno", 0, closed=200)], NAMES, T0 + 300
    )
    assert (visit["outcome"], visit["reported"]) == ("finished", False)
    assert visit["ended_at"] == iso(T0 + 200) and visit["seconds"] == 200
    assert visit["totals"]["searches"] == 3 and visit["totals"]["cards"] == 90


def test_own_list_pages_end_when_the_worker_moves_on_or_goes_quiet():
    events = [
        page("ne-1", None, "nyc", 0),
        page("ne-1", None, "nyc", 60),
        page("ne-1", None, "reno", 120),
    ]
    found = city_log.visits(events, [], NAMES, T0 + 200)
    assert one(found, "nyc")["outcome"] == "finished" and one(found, "nyc")["via"] is None
    assert one(found, "reno")["outcome"] == "searching"
    later = city_log.visits(events, [], NAMES, T0 + 3600)
    assert one(later, "reno")["outcome"] == "finished"
    # Newest first.
    assert [v["city"] for v in found] == ["reno", "nyc"]


def test_a_wall_stops_the_city_and_the_park_gives_it_back_in_one_visit():
    events = [
        ev("phl-1", "server_ram", "nyc", "handed", 0, why="familiar"),
        ev("phl-1", "server_ram", "nyc", "started", 1, searches=3, via="queue"),
        page("phl-1", "server_ram", "nyc", 60, cards=0, opened=0),
        ev("phl-1", "server_ram", "nyc", "released", 61, reason="CHECKPOINT"),
        ev(
            "phl-1",
            "server_ram",
            "nyc",
            "stopped",
            62,
            reason="wall",
            wall="checkpoint",
            searches=1,
            of=3,
            cards=0,
        ),
    ]
    (visit,) = city_log.visits(
        events, [lease("phl-1", "server_ram", "nyc", 0, expires=61)], NAMES, T0 + 600
    )
    assert (visit["outcome"], visit["reason"], visit["wall"]) == ("stopped", "wall", "checkpoint")
    assert city_log.outcome_text(visit) == "stopped: wall (checkpoint)"
    assert "after 1 of 3 searches" in city_log.event_text(visit["events"][-1])


def test_a_restart_gives_the_city_back_and_the_next_handout_is_a_new_visit():
    events = [
        ev("mw-1", "server_ram", "miami", "handed", 0, why="other"),
        page("mw-1", "server_ram", "miami", 60),
        ev("mw-1", "server_ram", "miami", "released", 400, reason="restarted"),
        ev("mw-1", "server_ram", "miami", "handed", 400, why="other"),
    ]
    leases = [
        lease("mw-1", "server_ram", "miami", 0, expires=400),
        lease("mw-1", "server_ram", "miami", 400),
    ]
    first, second = reversed(city_log.visits(events, leases, NAMES, T0 + 500))
    assert (first["outcome"], first["reason"]) == ("released", "restarted")
    assert city_log.outcome_text(first) == "given back: restarted"
    assert second["outcome"] == "searching" and len(second["events"]) == 1


def test_a_silent_worker_lets_its_lease_expire():
    events = [ev("sc-1", "enterprise_ssd", "reno", "handed", 0, why="other")]
    (visit,) = city_log.visits(
        events, [lease("sc-1", "enterprise_ssd", "reno", 0)], NAMES, T0 + 3600
    )
    assert visit["outcome"] == "expired" and visit["ended_at"] == iso(T0 + 1800)
    assert visit["events"][-1]["event"] == "expired"


def test_a_start_with_no_word_after_it_goes_quiet():
    events = [ev("west-1", "server_ram", "reno", "started", 0, searches=2, via="own")]
    (visit,) = city_log.visits(events, [], NAMES, T0 + 3600)
    assert (visit["outcome"], visit["via"]) == ("quiet", "own")
    assert visit["ended_at"] is None


def test_the_log_is_narrowed_after_grouping_and_renders_one_line_a_visit():
    events = [
        page("ne-1", None, "nyc", 0),
        page("ne-1", None, "reno", 120),
        ev("nyc-1", "enterprise_ssd", "nyc", "handed", 10, why="home"),
    ]
    found = city_log.visits(events, [], NAMES, T0 + 200)
    nyc = city_log.select(found, city="nyc")
    assert [(v["worker_id"], v["outcome"]) for v in nyc] == [
        ("nyc-1", "searching"),
        ("ne-1", "finished"),
    ]
    assert city_log.select(found, item="enterprise_ssd", limit=5)[0]["worker_id"] == "nyc-1"
    lines = city_log.render(nyc, with_events=True)
    assert "New York, NY" in lines[0] and "queue/home" in lines[0]
    assert any("from the queue (home)" in line for line in lines)


# -- the routes that write and read it --------------------------------------------------


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


ROSTER = {
    "catalog": [
        {"slug": "miami", "name": "Miami, FL", "region": "se", "radius": 100},
        {"slug": "nyc", "name": "New York, NY", "region": "ne", "radius": 100},
    ],
    "workers": {"nyc-1": {"home": ["nyc"], "start_at": ["13:00"]}},
}


def beat(client, wid, state="HEALTHY"):
    body = {"worker_id": wid, "state": state, "version": "0.13.17 (test)"}
    assert client.post("/v1/heartbeat", json=body, headers=LEGACY).status_code == 200


def ask(client, wid, done=None):
    now = (datetime.now(timezone.utc) - timedelta(minutes=1)).strftime("%H:%M")
    res = client.post(
        f"/v1/workers/{wid}/next-city",
        json={"item": "server_ram", "home": ["nyc"], "start_at": [now], "done": done},
        headers=auth(wid),
    )
    assert res.status_code == 200, res.text
    return res.json()


def steps(client, wid="nyc-1"):
    return [(e["event"], e["city"], e["detail"]) for e in client.deps.db.city_events_since("0", wid)]


def test_a_monitor_reports_only_its_own_cities_and_only_known_steps(client):
    url = "/v1/workers/nyc-1/city-events"
    body = {"item": "server_ram", "city": "Miami", "event": "started", "searches": 2}
    assert client.post(url, json=body, headers=auth("ne-1")).status_code == 403
    assert client.post(url, json={**body, "event": "paused"}, headers=auth("nyc-1")).status_code == 422
    assert client.post(url, json={**body, "cards": -1}, headers=auth("nyc-1")).status_code == 422
    assert client.post(url, json={**body, "error": "x" * 201}, headers=auth("nyc-1")).status_code == 422
    assert client.post(url, json=body, headers=auth("nyc-1")).status_code == 200
    assert steps(client) == [("started", "miami", {"searches": 2})]


def test_the_queue_logs_each_handout_and_what_a_restart_or_a_park_gives_back(client):
    client.put("/v1/queue/roster", json=ROSTER, headers=ADMIN)
    client.put("/v1/queue/settings", json={"enrolled": ["nyc-1"]}, headers=ADMIN)
    beat(client, "nyc-1")
    assert ask(client, "nyc-1")["city"]["slug"] == "nyc"
    # A restart asks again without saying the first city is done.
    assert ask(client, "nyc-1")["city"]["slug"] == "nyc"
    beat(client, "nyc-1", "CHECKPOINT")
    assert [s[0] for s in steps(client)] == ["handed", "released", "handed", "released"]
    assert steps(client)[1][2] == {"reason": "restarted"}
    assert steps(client)[3][2] == {"reason": "CHECKPOINT"}
    handed = client.deps.db.city_events_since("0", "nyc-1")[0]
    assert handed["detail"] == {"why": "home"}
    assert handed["at"] == client.deps.db.city_leases_since("0")[0]["leased_at"]


def test_each_search_page_and_alert_is_a_step(client):
    report = {
        "worker_id": "nyc-1",
        "searches": 1,
        "cards": 30,
        "title_pass": 4,
        "opened": 2,
        "reviewed": 1,
        "alerted": 1,
        "search_city": "nyc",
        "item": "server_ram",
        "search_phrase": "dell poweredge",
    }
    assert client.post("/v1/stats/reviews", json=report, headers=LEGACY).status_code == 200
    # A batch that counted no search (a late AI verdict) is no page.
    late = {"worker_id": "nyc-1", "reviewed": 1}
    assert client.post("/v1/stats/reviews", json=late, headers=LEGACY).status_code == 200
    alert = {
        "worker_id": "nyc-1",
        "chat_id": "-100",
        "message_id": 7,
        "listing_id": "123",
        "post_url": "https://fb/123",
        "item_name": "server_ram",
        "search_city": "nyc",
        "search_phrase": "dell poweredge",
        "ai_score": 4,
        "title": "Dell R740",
        "price": "$900",
    }
    assert client.post("/v1/alerts/telegram", json=alert, headers=LEGACY).status_code == 200
    # The second part of a split message is the same alert.
    second = {**alert, "message_id": 8, "part": 2, "parts": 2}
    assert client.post("/v1/alerts/telegram", json=second, headers=LEGACY).status_code == 200
    (searched, alerted) = steps(client)
    assert searched[0] == "searched" and searched[2]["phrase"] == "dell poweredge"
    assert searched[2]["cards"] == 30 and "searches" not in searched[2]
    assert alerted[0] == "alerted" and alerted[2]["title"] == "Dell R740"
    assert alerted[2]["price"] == "$900" and alerted[2]["score"] == 4
    assert client.deps.db.review_stats_daily(1)[0]["searches"] == 1


def test_the_log_reads_back_by_worker_and_city(client):
    client.put("/v1/queue/roster", json=ROSTER, headers=ADMIN)
    client.put("/v1/queue/settings", json={"enrolled": ["nyc-1"]}, headers=ADMIN)
    beat(client, "nyc-1")
    ask(client, "nyc-1")
    finished = {"item": "server_ram", "city": "nyc", "event": "finished", "searches": 2, "cards": 9}
    client.post("/v1/workers/nyc-1/city-events", json=finished, headers=auth("nyc-1"))
    ask(client, "nyc-1", done="nyc")

    assert client.get("/v1/city-log", headers=LEGACY).status_code == 401
    assert client.get("/v1/city-log?hours=73", headers=ADMIN).status_code == 422
    log = client.get("/v1/city-log?worker_id=nyc-1&city=NYC", headers=ADMIN).json()
    (visit,) = log["visits"]
    assert (visit["name"], visit["outcome"], visit["reported"]) == ("New York, NY", "finished", True)
    assert visit["totals"]["cards"] == 9 and log["hours"] == 24
    assert client.get("/v1/city-log?city=miami", headers=ADMIN).json()["visits"][0]["city"] == "miami"
    assert client.get("/v1/city-log?worker_id=ne-1", headers=ADMIN).json()["visits"] == []


def test_rsc_queue_log_prints_each_visit(tmp_path, monkeypatch, capsys):
    from rs_coordinator import cli
    from rs_coordinator.db import open_database

    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "cli.db"))
    monkeypatch.delenv("RS_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert cli.main(["queue", "log"]) == 0
    assert "no city searched" in capsys.readouterr().out
    db = open_database()
    db.log_city_event("ne-1", "server_ram", "nyc", "started", {"searches": 1, "via": "own"})
    db.log_city_event("ne-1", "server_ram", "nyc", "finished", {"searches": 1, "cards": 5})
    assert cli.main(["queue", "log", "--events", "--worker", "ne-1"]) == 0
    out = capsys.readouterr().out
    assert "ne-1" in out and "1 search, 5 cards" in out and "finished" in out
    assert cli.main(["queue", "log", "--json"]) == 0
    assert '"outcome": "finished"' in capsys.readouterr().out
