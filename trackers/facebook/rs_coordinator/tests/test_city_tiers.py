"""City search frequency: the rank, the slots, and the routes over them.

The contract: busy cities (by alerts sent + reacted to) are searched more
often, a city with no alerts is never promoted, a pin wins, every city is
searched exactly its per-day count of slots a day, and a worker's plan depends
only on the slot — so several items in one slot search the same cities.
"""

import importlib
from collections import Counter

import pytest
from fastapi.testclient import TestClient

from rs_coordinator import city_tiers
from rs_coordinator.tokens import mint_worker_token

SETTINGS = dict(city_tiers.DEFAULTS)
TEN = [f"c{i}" for i in range(10)]


def test_rank_promotes_the_busiest_and_never_a_quiet_city():
    scores = {"c3": 9, "c7": 5, "c1": 5, "c9": 1}
    rows = city_tiers.rank(TEN, scores, SETTINGS, {})
    per_day = {r["slug"]: r["per_day"] for r in rows}
    # Top 20% of ten is two cities; equal scores keep list order (c1 before c7).
    assert per_day["c3"] == 3 and per_day["c1"] == 3
    assert per_day["c7"] == 2 and per_day["c9"] == 2
    assert [c for c, p in per_day.items() if p == 1] == ["c0", "c2", "c4", "c5", "c6", "c8"]
    assert [r["slug"] for r in rows] == TEN


def test_a_fleet_with_no_alerts_searches_every_city_once():
    rows = city_tiers.rank(TEN, {}, SETTINGS, {})
    assert {r["per_day"] for r in rows} == {1}


def test_a_pin_wins_over_the_rank():
    rows = city_tiers.rank(TEN, {"c3": 9}, SETTINGS, {"c3": 1, "c5": 3})
    by = {r["slug"]: r for r in rows}
    assert by["c3"] == {"slug": "c3", "score": 9, "computed": 3, "pin": 1, "per_day": 1}
    assert by["c5"]["per_day"] == 3 and by["c5"]["computed"] == 1


@pytest.mark.parametrize("slots", [1, 2, 3, 4, 6])
@pytest.mark.parametrize("per_day", [1, 2, 3])
def test_each_city_is_searched_its_count_of_slots(slots, per_day):
    for city in TEN + ["denver", "atlanta", "120129314672398"]:
        used = city_tiers.slots_for(city, per_day, slots)
        assert len(used) == min(per_day, slots)
        assert all(0 <= s < slots for s in used)


def test_once_a_day_cities_spread_over_the_slots():
    cities = [f"city-{i}" for i in range(60)]
    rows = city_tiers.rank(cities, {}, SETTINGS, {})
    per_slot = Counter(s for c in cities for s in city_tiers.slots_for(c, 1, 3))
    assert sum(per_slot.values()) == 60
    assert min(per_slot.values()) >= 10
    plans = [city_tiers.plan(rows, slot, 3) for slot in range(3)]
    assert sorted(c for p in plans for c in p) == sorted(cities)


def test_one_slot_a_day_searches_everything():
    rows = city_tiers.rank(TEN, {"c3": 9}, SETTINGS, {})
    assert city_tiers.plan(rows, 0, 1) == TEN


@pytest.mark.parametrize(
    "body",
    [
        {"top_pct": 80, "mid_pct": 30},
        {"per_day": [1, 2, 3]},
        {"per_day": [3, 2]},
        {"window_days": 0},
        {"top_pct": True},
        {"nope": 1},
    ],
)
def test_bad_settings_are_refused(body):
    with pytest.raises(city_tiers.TierError):
        city_tiers.validate_settings(body, {})


def test_scores_add_sent_and_reacted():
    rows = [
        {"search_city": "denver", "sent": 3, "hit": 1},
        {"search_city": "denver", "sent": 2, "hit": 0},
        {"search_city": None, "sent": 7, "hit": 7},
    ]
    assert city_tiers.scores(rows) == {"denver": 6}


# -- routes -------------------------------------------------------------------

ADMIN = {"Authorization": "Bearer admin-token"}
LEGACY = {"Authorization": "Bearer test-token"}


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


def alert(client, message_id, city):
    return client.post(
        "/v1/alerts/telegram",
        json={
            "worker_id": "se-1",
            "chat_id": "-100",
            "message_id": message_id,
            "part": 1,
            "parts": 1,
            "item_name": "server_ram",
            "search_city": city,
        },
        headers=LEGACY,
    )


def test_settings_and_pins_round_trip(client):
    first = client.get("/v1/city-tiers", headers=ADMIN).json()
    assert first["settings"] == city_tiers.DEFAULTS and first["pins"] == {}

    r = client.put(
        "/v1/city-tiers",
        json={"settings": {"top_pct": 10}, "pins": {"Denver": 3}, "updated_by": "alex@x"},
        headers=ADMIN,
    )
    assert r.status_code == 200
    assert r.json()["settings"]["top_pct"] == 10 and r.json()["settings"]["mid_pct"] == 20
    assert r.json()["pins"] == {"denver": 3}
    assert r.json()["updated_by"] == "alex@x"

    # Pins alone replace the map and leave the settings be.
    r = client.put("/v1/city-tiers", json={"pins": {}}, headers=ADMIN)
    assert r.json()["pins"] == {} and r.json()["settings"]["top_pct"] == 10

    bad = client.put("/v1/city-tiers", json={"settings": {"per_day": [1, 2, 3]}}, headers=ADMIN)
    assert bad.status_code == 422 and "grow" in bad.json()["detail"]
    assert client.put("/v1/city-tiers", json={}, headers=ADMIN).status_code == 422
    assert client.get("/v1/city-tiers", headers=LEGACY).status_code == 401


def test_rank_and_plan_follow_the_alerts(client):
    for i in range(3):
        assert alert(client, 100 + i, "c4").status_code == 200
    alert(client, 200, "c8")

    ranked = client.post(
        "/v1/city-tiers/rank", json={"workers": {"se-1": TEN}}, headers=ADMIN
    ).json()
    by = {r["slug"]: r for r in ranked["workers"]["se-1"]}
    assert by["c4"]["score"] == 3 and by["c4"]["per_day"] == 3
    assert by["c8"]["per_day"] == 3
    assert by["c0"]["per_day"] == 1

    token = mint_worker_token("se-1", "worker-token-secret")
    auth = {"Authorization": f"Bearer {token}"}
    seen = Counter()
    for slot in range(3):
        r = client.post(
            "/v1/workers/se-1/search-plan",
            json={"cities": TEN, "slot": slot, "slots": 3},
            headers=auth,
        )
        assert r.status_code == 200
        seen.update(r.json()["search"])
    assert seen["c4"] == 3 and seen["c8"] == 3
    assert all(seen[c] == 1 for c in TEN if c not in ("c4", "c8"))

    other = client.post(
        "/v1/workers/ne-1/search-plan", json={"cities": TEN, "slot": 0, "slots": 3}, headers=auth
    )
    assert other.status_code == 403
    bad = client.post(
        "/v1/workers/se-1/search-plan", json={"cities": TEN, "slot": 3, "slots": 3}, headers=auth
    )
    assert bad.status_code == 422
