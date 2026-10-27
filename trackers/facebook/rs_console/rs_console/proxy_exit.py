"""Where a worker's traffic comes out: its proxy's exit IP and city.

Asked of an IP-geo service *through* the proxy, so the answer is the address
Facebook sees, not the one written in config. A worker without a proxy asks
without one, which names the VM's own address.

The fleet page refreshes every 30 s and the ERP gives the whole document 10 s,
so a lookup never holds the page: whatever has not answered within `WAIT_S`
reads `pending` and keeps running, and the next refresh finds it cached. The
wait is short because an exit is cached for hours: after a console restart a
long wait would add itself to every first load, for an answer that the next
refresh shows anyway.
"""

import asyncio
import time
from typing import Any, Dict, Iterable, Optional, Tuple
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

LOOKUP_URL = "https://ipinfo.io/json"
LOOKUP_TIMEOUT_S = 8.0
WAIT_S = 0.5
# A dedicated exit keeps its address for months; a failure is retried soon
# because it is usually the proxy having a bad minute.
OK_TTL_S = 6 * 3600
FAIL_TTL_S = 300
EXIT_KEYS = ("ip", "city", "region", "country", "org")

# (proxy URL or None, username, password)
Key = Tuple[Optional[str], Optional[str], Optional[str]]

_cache: Dict[Key, Tuple[float, Dict[str, Any]]] = {}
_inflight: Dict[Key, "asyncio.Task[Dict[str, Any]]"] = {}


def with_credentials(url: str, user: Optional[str], password: Optional[str]) -> str:
    """The proxy URL httpx dials. The monitor keeps a proxy's login in two
    separate vars and uses them only when both are set; so does this."""
    if not (user and password):
        return url
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    login = f"{quote(user, safe='')}:{quote(password, safe='')}"
    return urlunsplit((parts.scheme, f"{login}@{host}", parts.path, parts.query, parts.fragment))


async def _lookup(key: Key) -> Dict[str, Any]:
    proxy, user, password = key
    try:
        async with httpx.AsyncClient(
            timeout=LOOKUP_TIMEOUT_S,
            proxy=with_credentials(proxy, user, password) if proxy else None,
        ) as client:
            res = await client.get(LOOKUP_URL, headers={"Accept": "application/json"})
            res.raise_for_status()
            body = res.json() or {}
        found: Dict[str, Any] = {k: body.get(k) for k in EXIT_KEYS}
        ttl = OK_TTL_S
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        found = {"error": "Exit lookup failed"}
        ttl = FAIL_TTL_S
    _cache[key] = (time.monotonic() + ttl, found)
    return found


async def resolve(keys: Iterable[Key], wait_s: float = WAIT_S) -> Dict[Key, Dict[str, Any]]:
    now = time.monotonic()
    out: Dict[Key, Dict[str, Any]] = {}
    waiting: Dict[Key, "asyncio.Task[Dict[str, Any]]"] = {}
    for key in set(keys):
        hit = _cache.get(key)
        if hit and hit[0] > now:
            out[key] = hit[1]
            continue
        task = _inflight.get(key)
        if task is None:
            task = asyncio.create_task(_lookup(key))
            _inflight[key] = task
            task.add_done_callback(lambda _done, k=key: _inflight.pop(k, None))
        waiting[key] = task
    if waiting:
        await asyncio.wait(waiting.values(), timeout=wait_s)
    for key, task in waiting.items():
        out[key] = task.result() if task.done() else {"pending": True}
    return out


# The health check is a fresh dial every time, so a proxy that went down an
# hour ago is not reported up from the exit cache. Repeat asks within
# CHECK_TTL_S share one answer: the ERP probes every five minutes, and a
# manager's "Check now" must not turn into a burst through a vendor port.
CHECK_TTL_S = 60.0
CHECK_CONCURRENCY = 8
_checks: Dict[Key, Tuple[float, Dict[str, Any]]] = {}


async def _check(key: Key) -> Dict[str, Any]:
    proxy, user, password = key
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(
            timeout=LOOKUP_TIMEOUT_S,
            proxy=with_credentials(proxy, user, password) if proxy else None,
        ) as client:
            res = await client.get(LOOKUP_URL, headers={"Accept": "application/json"})
            res.raise_for_status()
            body = res.json() or {}
        found: Dict[str, Any] = {"ok": True, **{k: body.get(k) for k in EXIT_KEYS}}
    except httpx.ProxyError:
        found = {"ok": False, "error": "Proxy refused the connection"}
    except httpx.TimeoutException:
        found = {"ok": False, "error": "Timed out"}
    except httpx.HTTPStatusError as e:
        found = {"ok": False, "error": f"Lookup answered {e.response.status_code}"}
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        found = {"ok": False, "error": "Could not connect"}
    found["latency_ms"] = round((time.monotonic() - started) * 1000)
    # A good answer also refreshes the exit the fleet page shows.
    if found["ok"]:
        _cache[key] = (time.monotonic() + OK_TTL_S, {k: found[k] for k in EXIT_KEYS})
    return found


async def check(keys: Iterable[Key]) -> Dict[Key, Dict[str, Any]]:
    """Probe each proxy now, through itself: ok, latency_ms and the exit, or
    error. Never names the login; the error is worded here, not passed on."""
    gate = asyncio.Semaphore(CHECK_CONCURRENCY)

    async def one(key: Key) -> Dict[str, Any]:
        hit = _checks.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        async with gate:
            found = await _check(key)
        _checks[key] = (time.monotonic() + CHECK_TTL_S, found)
        return found

    unique = list(dict.fromkeys(keys))
    return dict(zip(unique, await asyncio.gather(*(one(k) for k in unique))))
