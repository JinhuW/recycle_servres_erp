"""The console's side of the city queue's shadow report.

What must stay true: the roster is the `/v1/fleet` document's catalog and
workers, with partners named by their shared proxy variable and a city no
region holds still in the catalog; the route needs the console token and
sends the coordinator nothing but days, settings and that roster; and the
report renders as text whatever the coordinator answers.
"""

import json

import httpx
import pytest
from fastapi import Response
from fastapi.testclient import TestClient

import rs_console.app as console
from rs_console import queue_shadow

AUTH = {"Authorization": "Bearer console-token"}

DOC = {
    "regions": [
        {
            "key": "rs_northeast",
            "name": "Northeast",
            "cities": [
                {"slug": "boston", "name": "Boston, MA", "radius_km": 100},
                {"slug": "nyc", "name": "New York, NY", "radius_km": 100},
            ],
        },
        {
            "key": "rs_mountain",
            "name": "Mountain",
            "cities": [{"slug": "reno", "name": "Reno, NV"}],
        },
    ],
    "workers": [
        {
            "worker_id": "ne-1",
            "proxy_env": "PROXY_HOMELAB_NE",
            "start_at": ["13:00"],
            "cities": [
                {"slug": "boston", "name": "Boston, MA"},
                {"slug": "nyc", "name": "New York, NY"},
            ],
            "plan": {"phrases": 2, "cities": 2},
        },
        {
            "worker_id": "ne-1b",
            "proxy_env": "PROXY_HOMELAB_NE",
            "start_at": ["17:00"],
            "cities": [{"slug": "105580889476291", "name": "Atlantic City, NJ"}],
            "plan": {"phrases": 3},
        },
        {"worker_id": "va-1", "proxy_env": "", "start_at": [], "cities": [], "plan": None},
    ],
}


def test_the_roster_is_the_fleet_documents_catalog_and_workers():
    out = queue_shadow.roster(DOC)
    assert out["catalog"] == [
        {"slug": "boston", "name": "Boston, MA", "region": "rs_northeast", "radius": 100},
        {"slug": "nyc", "name": "New York, NY", "region": "rs_northeast", "radius": 100},
        {"slug": "reno", "name": "Reno, NV", "region": "rs_mountain", "radius": None},
        {"slug": "105580889476291", "name": "Atlantic City, NJ", "region": None, "radius": None},
    ]
    assert out["workers"] == {
        "ne-1": {
            "home": ["boston", "nyc"],
            "partner_key": "PROXY_HOMELAB_NE",
            "start_at": ["13:00"],
            "phrases": 2,
        },
        "ne-1b": {
            "home": ["105580889476291"],
            "partner_key": "PROXY_HOMELAB_NE",
            "start_at": ["17:00"],
            "phrases": 3,
        },
        "va-1": {"home": [], "partner_key": None, "start_at": [], "phrases": 2},
    }


REPORT = {
    "window": {"start": "2026-10-20T18:00:00+00:00", "end": "2026-10-23T18:00:00+00:00", "days": 3},
    "log_since": "2026-10-23T19:00:00+00:00",
    "partial": True,
    "quarantined": [
        {"worker_id": "nj-2b", "searches": 2, "cities": ["nyc"], "others_cards": {"nyc": 120}}
    ],
    "fleet": {
        side: {
            "searches_per_day": 10.0,
            "browser_minutes_per_day": 95,
            "accounts_used": 2,
            "max_account_minutes_per_day": 60,
            "median_account_minutes_per_day": 47,
            "redundant_searches": 0,
            "cities_gap_over_26h": 1,
            "overdue_hours": 4,
        }
        for side in ("actual", "shadow")
    },
    "workers": [
        {
            "worker_id": "nj-2b",
            "home": 1,
            "quarantined": True,
            "actual": {"searches": 2, "minutes": 10, "cards": 0, "zero_card_searches": 2},
            "shadow": {"searches": 0, "minutes": 0, "by": {}, "idle_minutes": {"quarantined": 480}},
        },
        {
            "worker_id": "ne-1",
            "home": 2,
            "quarantined": False,
            "actual": {"searches": 8, "minutes": 40, "cards": 900, "zero_card_searches": 0},
            "shadow": {
                "searches": 12,
                "minutes": 60,
                "by": {"home": 4, "other": 2},
                "idle_minutes": {},
            },
        },
    ],
    "cities": [
        {
            "slug": "nyc",
            "name": "New York, NY",
            "region": "rs_northeast",
            "per_day": 2,
            "actual": {"max_gap_h": 21.0, "workers": ["ne-1"]},
            "shadow": {"max_gap_h": 12.0, "workers": ["ne-1"]},
        },
        {
            "slug": "reno",
            "name": None,
            "region": "rs_mountain",
            "per_day": 1,
            "actual": {"max_gap_h": 72.0, "workers": []},
            "shadow": {"max_gap_h": 72.0, "workers": []},
        },
    ],
}


def test_the_report_renders_as_text():
    text = queue_shadow.render(REPORT)
    assert "the search log starts 2026-10-23T19:00:00+00:00" in text
    assert "nj-2b: 2 searches; others get cards on nyc (120)" in text
    assert "nj-2b (Q)" in text and "4/0/2" in text
    # Worst shadow gap first, and a city without a name shows its slug.
    assert text.index("reno") < text.index("New York, NY")


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("RS_CONSOLE_TOKEN", "console-token")
    monkeypatch.setenv("RS_COORDINATOR_URL", "http://upstream:8500")
    monkeypatch.setenv("RS_COORDINATOR_ADMIN_TOKEN", "admin-secret")

    async def fleet_doc():
        return DOC

    monkeypatch.setattr(console, "fleet", fleet_doc)
    calls = []

    async def coordinator(request):
        calls.append(request)
        return httpx.Response(200, json=REPORT)

    real_client = httpx.AsyncClient

    class FakeClient(real_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(coordinator)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(console.httpx, "AsyncClient", FakeClient)
    test_client = TestClient(console.app)
    test_client.calls = calls
    yield test_client


def test_the_route_sends_the_roster_and_only_what_it_was_asked(client):
    assert client.post("/v1/queue/shadow", json={}).status_code == 401
    res = client.post(
        "/v1/queue/shadow",
        json={"days": 7, "settings": {"budget_minutes": 240}, "roster": {"forged": True}},
        headers=AUTH,
    )
    assert res.status_code == 200 and res.json() == REPORT
    (call,) = client.calls
    assert (call.method, call.url.path) == ("POST", "/v1/queue/shadow")
    assert call.headers["authorization"] == "Bearer admin-secret"
    assert json.loads(call.content) == {
        "days": 7,
        "settings": {"budget_minutes": 240},
        "roster": queue_shadow.roster(DOC),
    }
    assert client.post("/v1/queue/shadow", json=[1], headers=AUTH).status_code == 400


def test_the_cli_prints_the_report_or_the_coordinators_refusal(monkeypatch, capsys):
    sent = []

    async def answer(body):
        sent.append(body)
        return Response(content=json.dumps(REPORT), status_code=200, media_type="application/json")

    monkeypatch.setattr(console, "queue_shadow", answer)
    assert (
        queue_shadow.main(
            ["--days", "7", "--budget", "240", "--window", "10", "--per-day", "3,2,1"]
        )
        == 0
    )
    assert sent == [
        {
            "days": 7,
            "settings": {
                "budget_minutes": 240,
                "window_hours": 10.0,
                "tiers": {"per_day": [3, 2, 1]},
            },
        }
    ]
    assert "Shadow city queue" in capsys.readouterr().out

    async def refuse(body):
        return Response(content=json.dumps({"detail": "days is 1 to 14"}), status_code=422)

    monkeypatch.setattr(console, "queue_shadow", refuse)
    assert queue_shadow.main(["--days", "30"]) == 1
    assert "days is 1 to 14" in capsys.readouterr().err


def test_the_roster_is_pushed_to_the_queue(client):
    import asyncio

    assert asyncio.run(console.push_roster()) is True
    (call,) = client.calls
    assert (call.method, call.url.path) == ("PUT", "/v1/queue/roster")
    assert json.loads(call.content) == {**queue_shadow.roster(DOC), "updated_by": "rs-console"}


def test_the_console_pushes_at_startup_and_again_after_a_cities_save(monkeypatch):
    import threading

    pushes = []
    pushed = threading.Event()

    async def push():
        pushes.append(1)
        pushed.set()
        return True

    monkeypatch.setattr(console, "push_roster", push)
    monkeypatch.setattr(console, "ROSTER_PUSH_S", 3600.0)
    with TestClient(console.app):
        assert pushed.wait(5)
        pushed.clear()
        console._push_roster_soon()
        assert pushed.wait(5)
    assert len(pushes) == 2 and console._roster_wake is None
    # Without the loop (no lifespan), a save has nobody to wake.
    console._push_roster_soon()


def test_the_roster_names_the_enabled_items():
    doc = {**DOC, "items": [{"name": "server_ram", "enabled": True}, {"name": "gpu", "enabled": False},
                            {"name": "enterprise_ssd"}]}
    assert queue_shadow.roster(doc)["items"] == ["server_ram", "enterprise_ssd"]


def test_one_worker_and_everyone_go_in_and_out_of_the_queue(client):
    assert client.put("/v1/workers/nyc-1/queue", json={"enrolled": True}).status_code == 401
    assert client.put("/v1/workers/nyc-1/queue", json={"enrolled": "yes"}, headers=AUTH).status_code == 400
    res = client.put(
        "/v1/workers/nyc-1/queue",
        json={"enrolled": True, "updated_by": " Alex ", "worker_id": "evil"},
        headers=AUTH,
    )
    assert res.status_code == 200
    (call,) = client.calls
    assert (call.method, call.url.path) == ("PUT", "/v1/workers/nyc-1/queue")
    assert json.loads(call.content) == {"enrolled": True, "updated_by": "Alex"}

    client.calls.clear()
    assert client.put("/v1/queue/everyone", json={"enrolled": True}, headers=AUTH).status_code == 200
    client.put("/v1/queue/everyone", json={"enrolled": False, "updated_by": "Alex"}, headers=AUTH)
    first, second = client.calls
    assert (first.method, first.url.path) == ("PUT", "/v1/queue/settings")
    assert json.loads(first.content) == {"enrolled": ["*"], "updated_by": None}
    assert json.loads(second.content) == {"enrolled": [], "updated_by": "Alex"}
    assert client.put("/v1/queue/everyone", json=[1], headers=AUTH).status_code == 400


def test_the_round_starts_now_through_the_console(client):
    assert client.post("/v1/queue/start", json={}).status_code == 401
    assert client.get("/v1/queue/start", headers=AUTH).status_code == 200
    res = client.post(
        "/v1/queue/start", json={"updated_by": " Alex Chen ", "at": "2020-01-01"}, headers=AUTH
    )
    assert res.status_code == 200
    preview, start = client.calls
    assert (preview.method, preview.url.path) == ("GET", "/v1/queue/start")
    assert (start.method, start.url.path) == ("POST", "/v1/queue/start")
    assert json.loads(start.content) == {"updated_by": "Alex Chen"}


def test_the_fleet_carries_a_started_round_only_from_a_coordinator_that_has_one():
    from rs_console import fleet

    status = {"at": "x", "items": {}, "cities": [], "workers": []}
    doc = {"workers": []}
    fleet.apply_queue(doc, status)
    assert "started" not in doc["queue"]
    fleet.apply_queue(doc, {**status, "started": None})
    assert doc["queue"]["started"] is None
    started = {"at": "2026-10-24T08:00:00+00:00", "by": "Alex Chen", "until": "x", "fresh_hours": 2}
    fleet.apply_queue(doc, {**status, "started": started})
    assert doc["queue"]["started"] == started
