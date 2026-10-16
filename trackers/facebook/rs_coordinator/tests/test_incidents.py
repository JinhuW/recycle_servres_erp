"""One page per fleet-wide fault, however many workers report it or how often
it flaps. The rules live in `incidents.apply`; the endpoint just persists."""

from datetime import datetime, timedelta, timezone

import pytest

from rs_coordinator import incidents

T0 = datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc)
COOL = timedelta(hours=6)


def _run(steps, cooldown=COOL, vote_ttl=incidents.DEFAULT_VOTE_TTL):
    """Fold (minutes, worker, state) steps; return the texts that were paged."""
    row = None
    paged = []
    for minutes, worker, state in steps:
        row, text = incidents.apply(
            "ai_unavailable", row, worker, state, "402 Payment Required",
            now=T0 + timedelta(minutes=minutes), cooldown=cooldown, vote_ttl=vote_ttl,
        )
        paged.append(text)
    return row, [t for t in paged if t]


def test_first_down_pages_once_and_further_workers_are_absorbed():
    row, paged = _run([(0, "ne-1", "down"), (1, "sc-1", "down"), (2, "ne-1", "down")])
    assert len(paged) == 1
    assert "AI evaluation DOWN" in paged[0]
    assert "ne\\-1" in paged[0]
    assert "402 Payment Required" in paged[0]
    assert row["is_open"] == 1


def test_recovery_speaks_only_when_every_voter_is_back():
    _, paged = _run([
        (0, "ne-1", "down"), (1, "sc-1", "down"),
        (5, "ne-1", "up"),                     # sc-1 still down: quiet
        (6, "sc-1", "up"),                     # last voter: recovered
    ])
    assert len(paged) == 2
    assert "recovered" in paged[1]


def test_a_flap_inside_the_cooldown_costs_two_messages_not_two_per_cycle():
    steps = []
    minute = 0
    for _ in range(40):  # 40 down/up cycles over ~3 hours
        steps.append((minute, "ne-1", "down"))
        steps.append((minute + 2, "ne-1", "up"))
        minute += 5
    row, paged = _run(steps)
    assert len(paged) == 2
    assert row["is_open"] == 0


def test_a_relapse_after_the_cooldown_is_a_new_incident():
    _, paged = _run([
        (0, "ne-1", "down"), (10, "ne-1", "up"),
        (7 * 60, "ne-1", "down"), (7 * 60 + 5, "ne-1", "up"),
    ])
    assert len(paged) == 4


def test_a_silent_reopen_closes_silently():
    _, paged = _run([
        (0, "ne-1", "down"), (10, "ne-1", "up"),
        (20, "sc-1", "down"),  # inside cooldown: silent
        (30, "sc-1", "up"),    # nothing was paged for this opening
    ])
    assert len(paged) == 2


def test_a_stopped_workers_vote_expires_so_the_incident_can_close():
    _, paged = _run([
        (0, "ne-1", "down"), (1, "sc-1", "down"),
        # ne-1 is stopped and never says `up`; a day later sc-1 recovers.
        (25 * 60, "sc-1", "up"),
    ])
    assert len(paged) == 2
    assert "recovered" in paged[1]


def test_an_up_from_a_worker_that_never_voted_changes_nothing():
    row, paged = _run([(0, "ne-1", "up"), (1, "sc-1", "up")])
    assert paged == []
    assert row["is_open"] == 0


def test_unknown_state_is_rejected():
    with pytest.raises(ValueError):
        incidents.apply("ai_unavailable", None, "ne-1", "sideways")


def test_cooldown_env_parsing(monkeypatch):
    monkeypatch.setenv("RS_INCIDENT_COOLDOWN_HOURS", "2.5")
    assert incidents.cooldown_from_env() == timedelta(hours=2.5)
    monkeypatch.setenv("RS_INCIDENT_COOLDOWN_HOURS", "nope")
    assert incidents.cooldown_from_env() == incidents.DEFAULT_COOLDOWN
    monkeypatch.setenv("RS_INCIDENT_COOLDOWN_HOURS", "0")
    assert incidents.cooldown_from_env() == incidents.DEFAULT_COOLDOWN


# -- endpoint --------------------------------------------------------------

from tests.test_coordinator import AUTH, client  # noqa: E402,F401 - fixture reuse


def _ops_sent(client, monkeypatch):
    import rs_coordinator.app as app_module

    sent = []
    monkeypatch.setattr(
        app_module.ops_notifier, "send",
        lambda text, message_thread_id=None: (sent.append(text), True)[1],
    )
    return sent


def test_endpoint_pages_once_across_workers_and_persists(client, monkeypatch):
    sent = _ops_sent(client, monkeypatch)
    body = {"worker_id": "ne-1", "key": "ai_unavailable", "state": "down", "detail": "boom"}
    first = client.post("/api/v1/incidents", json=body, headers=AUTH).json()
    assert first == {"status": "ok", "open": True, "alerted": True}
    second = client.post(
        "/v1/incidents", json={**body, "worker_id": "sc-1"}, headers=AUTH
    ).json()
    assert second == {"status": "ok", "open": True, "alerted": False}

    client.drain()
    assert len(sent) == 1 and "DOWN" in sent[0]

    stored = client.db.get_incident("ai_unavailable")
    assert stored["is_open"] == 1
    assert "ne-1" in stored["reporters"] and "sc-1" in stored["reporters"]

    for w in ("ne-1", "sc-1"):
        last = client.post(
            "/api/v1/incidents",
            json={"worker_id": w, "key": "ai_unavailable", "state": "up"},
            headers=AUTH,
        ).json()
    assert last == {"status": "ok", "open": False, "alerted": True}
    client.drain()
    assert len(sent) == 2 and "recovered" in sent[1]


def test_endpoint_requires_auth_and_a_worker_id(client):
    body = {"key": "ai_unavailable", "state": "down"}
    assert client.post("/api/v1/incidents", json=body).status_code == 401
    assert client.post("/api/v1/incidents", json=body, headers=AUTH).status_code == 422
    bad = {"worker_id": "ne-1", "key": "AI Unavailable!", "state": "down"}
    assert client.post("/api/v1/incidents", json=bad, headers=AUTH).status_code == 422
