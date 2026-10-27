"""Where a proxy exits: asked through the proxy, cached, never holding the page."""

import asyncio

import httpx
import pytest

from rs_console import fleet, proxy_exit

from conftest import REAL_LOOKUP

IPINFO = {
    "ip": "203.0.113.7", "city": "Ashburn", "region": "Virginia", "country": "US",
    "org": "AS7922 Comcast", "loc": "39.0,-77.4", "readme": "https://ipinfo.io/missingauth",
}


@pytest.fixture()
def geo(monkeypatch):
    monkeypatch.setattr(proxy_exit, "_lookup", REAL_LOOKUP)
    state = {"calls": [], "response": httpx.Response(200, json=IPINFO), "proxies": []}

    async def transport(request):
        state["calls"].append(str(request.url))
        return state["response"]

    real_client = httpx.AsyncClient

    class FakeClient(real_client):
        def __init__(self, *args, **kwargs):
            state["proxies"].append(kwargs.pop("proxy", None))
            kwargs["transport"] = httpx.MockTransport(transport)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(proxy_exit.httpx, "AsyncClient", FakeClient)
    return state


def test_public_url_cuts_the_login_out():
    assert fleet.public_proxy_url("http://isp.decodo.com:10002") == "http://isp.decodo.com:10002"
    assert fleet.public_proxy_url(" http://user:pa%2Bss@host.example:8080 ") == "http://host.example:8080"
    assert fleet.public_proxy_url("socks5://u@host.example") == "socks5://host.example"
    assert fleet.public_proxy_url("http://u:p@[2001:db8::1]:3128") == "http://[2001:db8::1]:3128"
    for junk in (None, "", "not a url", "http://host:notaport", "://host"):
        assert fleet.public_proxy_url(junk) is None


def test_login_is_quoted_into_the_url_only_when_both_halves_are_set():
    url = "http://isp.decodo.com:10001"
    assert proxy_exit.with_credentials(url, "user", "8Hg+/b@x") == "http://user:8Hg%2B%2Fb%40x@isp.decodo.com:10001"
    assert proxy_exit.with_credentials(url, "user", None) == url
    assert proxy_exit.with_credentials(url, None, "pw") == url


def test_lookup_goes_through_the_proxy_and_is_cached(geo):
    key = ("http://isp.example:10001", "user", "pw")
    first = asyncio.run(proxy_exit.resolve([key, key]))
    assert first == {key: {k: IPINFO[k] for k in proxy_exit.EXIT_KEYS}}
    assert geo["proxies"] == ["http://user:pw@isp.example:10001"]
    assert geo["calls"] == [proxy_exit.LOOKUP_URL]

    asyncio.run(proxy_exit.resolve([key]))
    assert len(geo["calls"]) == 1

    # The VM's own address: same service, no proxy.
    own = (None, None, None)
    assert asyncio.run(proxy_exit.resolve([own]))[own]["city"] == "Ashburn"
    assert geo["proxies"][-1] is None


def test_a_failed_lookup_is_an_error_and_cached_briefly(geo, monkeypatch):
    geo["response"] = httpx.Response(407, text="Proxy Authentication Required")
    key = ("http://isp.example:10001", None, None)
    assert asyncio.run(proxy_exit.resolve([key])) == {key: {"error": "Exit lookup failed"}}
    expires, _ = proxy_exit._cache[key]
    assert expires - proxy_exit.time.monotonic() <= proxy_exit.FAIL_TTL_S


def test_a_slow_lookup_reads_pending_and_keeps_running(monkeypatch):
    release = None

    async def slow(key):
        await release.wait()
        proxy_exit._cache[key] = (proxy_exit.time.monotonic() + 60, {"ip": "203.0.113.9"})
        return {"ip": "203.0.113.9"}

    monkeypatch.setattr(proxy_exit, "_lookup", slow)
    key = ("http://slow.example:1", None, None)

    async def scenario():
        nonlocal release
        release = asyncio.Event()
        assert await proxy_exit.resolve([key], wait_s=0.01) == {key: {"pending": True}}
        task = proxy_exit._inflight[key]
        # A second page load joins the lookup already running.
        assert await proxy_exit.resolve([key], wait_s=0.01) == {key: {"pending": True}}
        assert proxy_exit._inflight[key] is task
        release.set()
        await task
        return await proxy_exit.resolve([key], wait_s=0.01)

    assert asyncio.run(scenario()) == {key: {"ip": "203.0.113.9"}}


def test_an_empty_cache_holds_the_page_only_briefly(monkeypatch):
    release = None

    async def never(key):
        await release.wait()
        return {"ip": "203.0.113.9"}

    monkeypatch.setattr(proxy_exit, "_lookup", never)
    key = ("http://slow.example:1", None, None)

    async def scenario():
        nonlocal release
        release = asyncio.Event()
        started = asyncio.get_running_loop().time()
        answer = await proxy_exit.resolve([key])
        waited = asyncio.get_running_loop().time() - started
        release.set()
        await proxy_exit._inflight[key]
        return answer, waited

    answer, waited = asyncio.run(scenario())
    assert answer == {key: {"pending": True}}
    # A first load after a restart must not wait seconds on lookups that the
    # next refresh shows anyway.
    assert waited < 1.0


def test_check_dials_fresh_and_shares_an_answer_for_a_minute(geo):
    key = ("http://isp.example:10001", "user", "pw")
    proxy_exit._checks.clear()
    first = asyncio.run(proxy_exit.check([key, key]))[key]
    assert first["ok"] is True and first["ip"] == IPINFO["ip"]
    assert isinstance(first["latency_ms"], int)
    assert geo["proxies"] == ["http://user:pw@isp.example:10001"]
    # A good check refreshes the exit the fleet page shows.
    assert proxy_exit._cache[key][1]["city"] == "Ashburn"

    asyncio.run(proxy_exit.check([key]))
    assert len(geo["calls"]) == 1
    proxy_exit._checks.clear()
    asyncio.run(proxy_exit.check([key]))
    assert len(geo["calls"]) == 2


def test_a_failed_check_is_worded_here_and_names_no_login(geo):
    proxy_exit._checks.clear()
    geo["response"] = httpx.Response(502, text="bad gateway user:pw")
    key = ("http://isp.example:10001", "user", "pw")
    found = asyncio.run(proxy_exit.check([key]))[key]
    assert found["ok"] is False and found["error"] == "Lookup answered 502"
    assert "pw" not in str(found)
