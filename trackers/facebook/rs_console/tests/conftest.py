import pytest

from rs_console import proxy_exit

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
