import httpx
import pytest

from rs_console import app as console
from rs_console import proxy_exit, settings

REAL_LOOKUP = proxy_exit._lookup


@pytest.fixture(autouse=True)
def no_exit_lookups(monkeypatch):
    """Every /v1/fleet asks where each proxy exits; tests must not reach the
    internet doing it. test_proxy_exit puts REAL_LOOKUP back."""
    async def offline(key):
        return {"error": "offline in tests"}

    monkeypatch.setattr(proxy_exit, "_lookup", offline)
    proxy_exit._cache.clear()
    proxy_exit._inflight.clear()


class FakeFleet:
    """The coordinator's fleet routes, in memory. Off by default: it answers
    like a coordinator from before the fleet, so no test reaches the network
    and the mounted-config behaviour stays what it was."""

    def __init__(self):
        self.enabled = False
        self.configs = {}
        self.state = {}
        self.writes = []

    def call(self, method, path, **kwargs):
        if not self.enabled:
            return httpx.Response(404, json={"detail": "Not Found"})
        if path == "/v1/fleet/state":
            return httpx.Response(200, json=self.state)
        if path == "/v1/fleet/configs":
            return httpx.Response(200, json={"configs": [{"worker_id": w} for w in sorted(self.configs)]})
        worker_id = path.rsplit("/", 1)[-1]
        if method == "GET":
            if worker_id not in self.configs:
                return httpx.Response(404, json={"detail": "none"})
            return httpx.Response(200, json={"worker_id": worker_id, "toml": self.configs[worker_id]})
        text = kwargs["json"]["toml"]
        changed = self.configs.get(worker_id) != text
        self.configs[worker_id] = text
        self.writes.append(worker_id)
        return httpx.Response(200, json={"worker_id": worker_id, "changed": changed})


@pytest.fixture(autouse=True)
def fake_fleet(monkeypatch):
    fleet = FakeFleet()
    monkeypatch.setattr(settings.FleetConfigs, "_call", fleet.call)
    console._fleet_vnc.update(at=0.0, targets={})
    return fleet
