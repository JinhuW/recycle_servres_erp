"""A10-10: an enqueue failure after the claim leaves the listing seen and never alerted."""
from test_coordinator import client, sample_listing, AUTH  # noqa: F401


def test_enqueue_blip_loses_the_lead(client, monkeypatch):
    real = client.db.enqueue_alert
    calls = {"n": 0}

    def flaky(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("pool timeout")
        return real(*a, **kw)

    monkeypatch.setattr(client.db, "enqueue_alert", flaky)
    payload = {"worker_id": "denver-1", "listings": [sample_listing()]}
    first = client.post("/api/v1/listings", json=payload, headers=AUTH).json()
    second = client.post("/api/v1/listings", json=payload, headers=AUTH).json()
    client.drain()
    print("first:", first, "retry:", second, "telegram sends:", len(client.sent))
    assert first.get("failed") == 1
    assert second == {"accepted": 0, "duplicates": 1, "queued": 0}
    assert client.sent == []
