"""Read-mostly facade between the ERP console and the coordinator.

Why this service exists: the coordinator holds every Facebook account's
secrets and answers 2FA/credential requests, so it stays loopback-only on the
VM — deliberately unreachable from anywhere. The ERP dashboard still needs the
harmless slice of it (fleet health, the checkpoint queue, review stats), so
this facade is what gets exposed through the Cloudflare tunnel instead.

The safety property, stated once: **the coordinator admin token never leaves
this process, and no auth/credential/session route is forwarded.** The routes
below are a closed allowlist — nine reads and five writes (resolving a
checkpoint, queuing a worker re-login, setting a vault account's login
details, saving search settings, and saving one worker's cities). The first
two move no credential and name no account. The third is the one route
through which a credential enters the fleet, and it is blind: a value goes
upstream, a presence flag comes back, and nothing here can read a stored
secret. The last two change what the workers search for, where, and how they
judge it — never as whom, through which proxy or to which chat (settings.py
lists what they can reach). A full compromise of this service's own token can
therefore overwrite a worker's login or its search, but still yields fleet
metadata, not accounts.

It also serves the fleet dashboard: a single static page (`/`, assets under
`/static`) that calls the routes below with the console token the operator
pastes in once. The page is the standalone face of this data; the ERP's
Facebook-tracker page is meant to grow the same cards by forwarding
`/v1/fleet` through its own `/api/coordinator` proxy, which is why the
page's markup uses the ERP's class names and tokens verbatim.

It also serves the fleet dashboard: a single static page (`/`, assets under
`/static`) that calls the routes below with the console token the operator
pastes in once. The page is the standalone face of this data; the ERP's
Facebook-tracker page is meant to grow the same cards by forwarding
`/v1/fleet` through its own `/api/coordinator` proxy, which is why the
page's markup uses the ERP's class names and tokens verbatim.

Configuration (env):
    RS_CONSOLE_TOKEN            bearer token callers must present (required)
    RS_COORDINATOR_URL          coordinator base, default http://coordinator:8500
    RS_COORDINATOR_ADMIN_TOKEN  admin token used upstream (required)
    RS_MONITOR_CONFIG           monitor TOML for the filter prompt and the
                                phase-1 city list, default /config/monitor.toml
    RS_MASTER_CONFIG            master.toml (regions, items, search settings),
                                default /config/master.toml
    RS_FLEET_CONFIG             fleet.toml (worker -> region), default
                                /config/fleet.toml
    RS_WORKER_CONFIGS           comma-separated `worker_id=path` worker configs
                                a settings save writes into (a bare path has
                                no editable cities), default RS_MONITOR_CONFIG
    RS_SETTINGS_STATE           the saved settings (settings.py), default
                                /state/settings.json
    RS_MONITOR_WORKER_ID        the phase-1 monitor's control-plane id, so its
                                heartbeat row joins its config; falls back to
                                RS_WORKER_ID (the same variable the monitor
                                itself reads from secrets.env)
    RS_VNC_TARGETS              `worker_id=container:5900,...` — which workers'
                                browsers the console may bridge to (vnc.py)
    RS_CONSOLE_PUBLIC_URL       optional public base for absolute VNC links

The one exception to "read-mostly" besides resolving a checkpoint is the VNC
bridge (`/v1/vnc/...`): it moves bytes between the operator's browser and a
worker's x11vnc, so the dashboard's "Watch" button shows the live Chromium.
It reaches a worker only if that worker is listed in RS_VNC_TARGETS or run
by a trusted fleet host (the coordinator's `/v1/fleet/state`), only with a
single-use ticket minted against the console token.
"""

import asyncio
import hashlib
import json
import os
import re
import secrets as pysecrets
import threading
import time
import tomllib
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import (
    Body,
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
)
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from . import fleet as fleet_view
from . import proxy_exit, settings, vnc

STATIC_DIR = Path(__file__).parent / "static"


def _asset_version() -> str:
    """A tag that changes whenever the page's own assets do.

    Browsers cache `/static/*` heuristically when no Cache-Control is sent,
    and served an old fleet.css for a day after the viewer shipped — the
    page connected fine and drew into a zero-size box. The shells reference
    their assets as `fleet.css?v=<tag>` so a rebuild is a new URL.
    """
    digest = hashlib.sha1()
    for name in ("fleet.css", "fleet.js", "vnc.js"):
        try:
            digest.update((STATIC_DIR / name).read_bytes())
        except OSError:
            continue
    return digest.hexdigest()[:10]


ASSET_VERSION = _asset_version()

TIMEOUT_S = 10.0
# A checkpoint screenshot is a full browser-window PNG the coordinator may be
# capturing on demand; give it a longer budget than the JSON calls.
SCREENSHOT_TIMEOUT_S = 20.0

app = FastAPI(title="rs-console", docs_url=None, redoc_url=None)

# The dashboard shell is public — it holds no data, only markup and script.
# Everything it shows comes from the token-guarded routes below, after the
# operator pastes the console token into the page.
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.middleware("http")
async def revalidate_static(request: Request, call_next):
    """Make every static and shell response revalidate.

    `no-cache` is not "do not cache": the browser keeps the file and asks
    with If-None-Match, so unchanged assets are a 304 — and a changed
    fleet.css is never served stale again. The novnc modules are imported
    by URL without a version tag, so this is what keeps them current.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/static/") or path == "/" or path.startswith("/vnc/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _shell(name: str) -> HTMLResponse:
    """A page shell with its asset links versioned."""
    html = (STATIC_DIR / name).read_text(encoding="utf-8")
    return HTMLResponse(html.replace("__ASSET_V__", ASSET_VERSION))


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name, default)
    return value.strip() if isinstance(value, str) else value


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    expected = _env("RS_CONSOLE_TOKEN")
    if not expected:
        # Fail closed: an unset token must never mean "open".
        raise HTTPException(status_code=503, detail="RS_CONSOLE_TOKEN is not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    supplied = authorization[len("Bearer ") :].strip()
    if not pysecrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid bearer token")


def _upstream() -> tuple[str, Dict[str, str]]:
    base = (_env("RS_COORDINATOR_URL", "http://coordinator:8500") or "").rstrip("/")
    # RS_ADMIN_TOKEN is the fallback so the compose file can hand this service
    # the fleet's secrets.env unchanged (env_file values are not available to
    # compose ${...} interpolation, only inside the container).
    token = _env("RS_COORDINATOR_ADMIN_TOKEN") or _env("RS_ADMIN_TOKEN")
    if not base or not token:
        raise HTTPException(status_code=503, detail="Coordinator upstream is not configured")
    return base, {"Authorization": f"Bearer {token}"}


async def _forward(
    method: str,
    path: str,
    params: Dict[str, Any] | None = None,
    json_body: Dict[str, Any] | None = None,
    timeout: float = TIMEOUT_S,
) -> Response:
    base, headers = _upstream()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.request(
                method, base + path, params=params, json=json_body, headers=headers
            )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Coordinator is unreachable") from None
    # Pass body and status through verbatim; the coordinator's 4xx bodies carry
    # messages the console shows as-is.
    media_type = res.headers.get("content-type", "application/json")
    return Response(content=res.content, status_code=res.status_code, media_type=media_type)


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/workers", dependencies=[Depends(require_token)])
async def workers() -> Response:
    return await _forward("GET", "/v1/workers")


_WORKER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


@app.post("/v1/workers/{worker_id}/relogin", dependencies=[Depends(require_token)])
async def worker_relogin(worker_id: str) -> Response:
    """Queue a Facebook re-login for one worker (console "Re-login" button).

    A write, but a harmless one: it only flags the worker to re-run its own
    login on its next heartbeat — it moves no credentials and names no account.
    """
    return await _forward("POST", f"/v1/workers/{worker_id}/relogin")


@app.post("/v1/workers/{worker_id}/restore-session", dependencies=[Depends(require_token)])
async def worker_restore(worker_id: str) -> Response:
    """Queue a session restore for one worker (RS-308), the gentle counterpart
    to Re-login: the worker restores the snapshot the cookie-first Assign just
    sealed rather than forcing a password login. Moves no credentials itself.
    """
    if not _WORKER_ID.match(worker_id):
        raise HTTPException(status_code=400, detail="Not a valid worker id")
    return await _forward("POST", f"/v1/workers/{worker_id}/restore-session")


# What the ERP's "Edit credentials" form may set on a vault account. Listed
# rather than passed through so that a field the coordinator adds later (a
# proxy URL, a VNC address) is a decision here, not something the ERP can
# reach by accident. Secrets are write-only end to end: the coordinator's
# answer carries presence flags, never a value.
ACCOUNT_WRITE_FIELDS = ("worker_id", "fb_username", "fb_uid", "region", "allow_password_login")
ACCOUNT_SECRET_FIELDS = (
    "password",
    "email",
    "email_password",
    "totp_secret",
    "imap_host",
    "imap_port",
    "fb_token",
)
_ACCOUNT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$")
# The login's legacy device. Only these two cookies may cross: the pool cookie
# they come from also carries a live session (c_user, xs), and that must never
# reach a worker.
DEVICE_COOKIE_NAMES = ("datr", "sb")
DEVICE_COOKIE_FIELDS = ("name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite")


def _device_cookies(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 4:
        raise HTTPException(status_code=400, detail="device_cookies must be 1 to 4 cookies")
    cookies = []
    for cookie in raw:
        if not isinstance(cookie, dict) or cookie.get("name") not in DEVICE_COOKIE_NAMES:
            raise HTTPException(
                status_code=400, detail="device_cookies may hold only datr and sb"
            )
        cookies.append({k: cookie[k] for k in DEVICE_COOKIE_FIELDS if k in cookie})
    return cookies


@app.put("/v1/accounts/{account_id}", dependencies=[Depends(require_token)])
async def put_account(account_id: str, request: Request) -> Response:
    """Set a vault account's login details (the ERP's "Edit credentials" form).

    The write that makes "Re-login" automatic: the worker's next forced login
    takes its username, password and 2FA code from what is stored here. The
    body is reduced to the fields above before it goes upstream; an empty
    secret keeps what is stored and a null clears it, exactly as the
    coordinator reads them.
    """
    if not _ACCOUNT_ID.match(account_id):
        raise HTTPException(status_code=400, detail="Not a valid account id")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Expected a JSON object") from None
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")

    upstream_body: Dict[str, Any] = {k: body[k] for k in ACCOUNT_WRITE_FIELDS if k in body}
    secrets = body.get("secrets")
    if isinstance(secrets, dict):
        upstream_body["secrets"] = {
            k: v
            for k, v in secrets.items()
            if k in ACCOUNT_SECRET_FIELDS and (v is None or isinstance(v, str))
        }
    if body.get("device_cookies") is not None:
        upstream_body["device_cookies"] = _device_cookies(body["device_cookies"])
    return await _forward("PUT", f"/v1/accounts/{account_id}", json_body=upstream_body)


@app.put("/v1/workers/{worker_id}/session", dependencies=[Depends(require_token)])
async def seed_worker_session(worker_id: str, request: Request) -> Response:
    """Seal a pool account's cookie as this worker's restorable session (RS-308).

    The cookie-first Assign: the worker restores this instead of a password
    login. Only `cookie` and `reason` cross; the coordinator validates the
    cookie and files it under the account the slot already holds, so the ERP
    can seed a session but still cannot read one back.
    """
    if not _WORKER_ID.match(worker_id):
        raise HTTPException(status_code=400, detail="Not a valid worker id")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Expected a JSON object") from None
    if not isinstance(body, dict) or not isinstance(body.get("cookie"), str):
        raise HTTPException(status_code=400, detail="Expected a JSON object with a cookie")
    upstream: Dict[str, Any] = {"cookie": body["cookie"]}
    if isinstance(body.get("reason"), str):
        upstream["reason"] = body["reason"]
    return await _forward("PUT", f"/v1/workers/{worker_id}/session", json_body=upstream)


@app.get("/v1/challenges", dependencies=[Depends(require_token)])
async def challenges(status: str = Query(default="open")) -> Response:
    return await _forward("GET", "/v1/challenges", params={"status": status})


@app.post("/v1/challenges/{challenge_id}/resolve", dependencies=[Depends(require_token)])
async def resolve_challenge(challenge_id: int, request: Request) -> Response:
    # Only resolved_by crosses; anything else in the body is dropped here.
    try:
        body = await request.json()
    except Exception:
        body = {}
    resolved_by = body.get("resolved_by") if isinstance(body, dict) else None
    return await _forward(
        "POST",
        f"/v1/challenges/{challenge_id}/resolve",
        json_body={"resolved_by": resolved_by},
    )


@app.get("/v1/challenges/{challenge_id}/screenshot", dependencies=[Depends(require_token)])
async def challenge_screenshot(challenge_id: int) -> Response:
    return await _forward(
        "GET", f"/v1/challenges/{challenge_id}/screenshot", timeout=SCREENSHOT_TIMEOUT_S
    )


# The login ledger, one worker at a time, for the ERP's account timeline. The
# datr fingerprint and device id stay here: they identify a browser, and the
# ERP only needs what each attempt was and how it ended.
LOGIN_FIELDS = (
    "id", "worker_id", "account_id", "identity_key", "trigger", "outcome",
    "started_at", "finished_at",
)


@app.get("/v1/logins", dependencies=[Depends(require_token)])
async def logins(
    worker_id: str = Query(...), limit: int = Query(default=200, ge=1, le=500)
) -> Dict[str, Any]:
    if not _WORKER_ID.match(worker_id):
        raise HTTPException(status_code=400, detail="Not a valid worker id")
    res = await _forward("GET", "/v1/logins", params={"worker_id": worker_id, "limit": limit})
    if res.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Coordinator answered {res.status_code}")
    rows = json.loads(res.body).get("logins") or []
    out = []
    for row in rows:
        try:
            detail = json.loads(row.get("detail_json") or "null")
        except ValueError:
            detail = None
        out.append({**{k: row.get(k) for k in LOGIN_FIELDS}, "detail": detail})
    return {"logins": out}


@app.get("/v1/stats/reviews", dependencies=[Depends(require_token)])
async def review_stats(days: int = Query(default=14, ge=1, le=92)) -> Response:
    return await _forward("GET", "/v1/stats/reviews", params={"days": days})


@app.get("/v1/stats/alert-hits", dependencies=[Depends(require_token)])
async def alert_hit_stats(days: int = Query(default=14, ge=1, le=92)) -> Response:
    return await _forward("GET", "/v1/stats/alert-hits", params={"days": days})


@app.get("/", include_in_schema=False)
def dashboard() -> HTMLResponse:
    return _shell("index.html")


# ── Watching a worker's browser ────────────────────────────────────────────────

_tickets = vnc.TicketStore()


# How long the fleet's VNC addresses are reused. A worker the fleet just
# started is watchable within this, and a page of Watch clicks costs the
# coordinator one request.
FLEET_VNC_TTL_S = 30.0
_fleet_vnc: Dict[str, Any] = {"at": 0.0, "targets": {}}
_fleet_vnc_lock = threading.Lock()


def _fleet_configs() -> Optional[settings.FleetConfigs]:
    try:
        base, headers = _upstream()
    except HTTPException:
        return None
    return settings.FleetConfigs(base, headers)


def _fleet_vnc_targets() -> Dict[str, vnc.Target]:
    """Where to reach each worker a trusted fleet host runs.

    On the console's own host (no vnc_host) the worker's container is on the
    rs-fleet network by name; elsewhere it publishes its own port. A host that
    only observes runs nothing yet, so its workers keep their RS_VNC_TARGETS
    entry until it is trusted.
    """
    with _fleet_vnc_lock:
        if time.monotonic() - _fleet_vnc["at"] < FLEET_VNC_TTL_S:
            return dict(_fleet_vnc["targets"])
        targets: Dict[str, vnc.Target] = {}
        fleet = _fleet_configs()
        try:
            body = fleet.state() if fleet is not None else {}
        except (settings.FleetError, ValueError):
            body = {}
        hosts = {h["host_id"]: h for h in body.get("hosts") or []}
        for a in body.get("assignments") or []:
            host = hosts.get(a.get("host_id")) or {}
            if a.get("state") != "run" or not host.get("authoritative") or a.get("move_to_host"):
                continue
            if host.get("vnc_host"):
                if a.get("vnc_port"):
                    targets[a["worker_id"]] = (str(host["vnc_host"]), int(a["vnc_port"]))
            else:
                targets[a["worker_id"]] = (f"rs-worker-{a['worker_id']}", 5900)
        _fleet_vnc.update(at=time.monotonic(), targets=targets)
        return dict(targets)


def _vnc_targets() -> Dict[str, vnc.Target]:
    return {**vnc.parse_targets(_env("RS_VNC_TARGETS")), **_fleet_vnc_targets()}


def _vnc_pages() -> Dict[str, str]:
    base = _env("RS_CONSOLE_PUBLIC_URL")
    return {wid: vnc.page_url(wid, base) for wid in _vnc_targets()}


@app.get("/vnc/{worker_id}", include_in_schema=False)
def vnc_page(worker_id: str) -> HTMLResponse:
    """The viewer shell. Public like `/`: it holds no data and connects
    only after the page has traded the operator's token for a ticket."""
    if worker_id not in _vnc_targets():
        raise HTTPException(status_code=404, detail="No VNC target for this worker")
    return _shell("vnc.html")


@app.post("/v1/vnc/{worker_id}/ticket", dependencies=[Depends(require_token)])
def vnc_ticket(worker_id: str) -> Dict[str, Any]:
    """Trade the bearer token for a single-use WebSocket ticket."""
    if worker_id not in _vnc_targets():
        raise HTTPException(status_code=404, detail="No VNC target for this worker")
    ticket = _tickets.issue(worker_id)
    return {
        "worker_id": worker_id,
        "ticket": ticket,
        "expires_in": int(vnc.TICKET_TTL_S),
        "path": f"/v1/vnc/{worker_id}/ws?ticket={ticket}",
    }


@app.websocket("/v1/vnc/{worker_id}/ws")
async def vnc_socket(websocket: WebSocket, worker_id: str, ticket: str = Query(default="")) -> None:
    target = _vnc_targets().get(worker_id)
    if target is None or not ticket or not _tickets.redeem(ticket, worker_id):
        # Before accept(), a close is a plain 403 to the client: no
        # handshake, no hint about whether the worker exists.
        await websocket.close(code=1008)
        return
    # Older noVNC clients ask for the `binary` subprotocol and browsers drop
    # the connection if the server does not echo it; current ones ask for
    # none, and browsers drop the connection if the server names one anyway.
    # Echo exactly what was asked for.
    offered = websocket.scope.get("subprotocols") or []
    await websocket.accept(subprotocol="binary" if "binary" in offered else None)
    await vnc.bridge(websocket, target)


def _read_toml(path: str | None) -> Optional[Dict[str, Any]]:
    """A mounted config, or None when it is absent or unreadable.

    None rather than an error: the fleet route degrades to whatever *is*
    mounted, and a console with only the monitor config still has a page.
    """
    if not path:
        return None
    try:
        with open(path, "rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return None


@app.get("/v1/fleet", dependencies=[Depends(require_token)])
async def fleet() -> Dict[str, Any]:
    """Who searches where, for what, whether they are alive — and as whom.

    Config comes from the mounted TOMLs; health, the vault's account list and
    each worker's session metadata (Facebook user id, browser identity, backup
    age) from the coordinator's admin routes. A coordinator outage is reported
    inside the document (`health.error`) instead of failing it, so the
    configured fleet still renders when the control plane is down — which is
    exactly when someone is looking.
    """
    base, headers = _upstream()
    try:
        saved = settings.load()
    except (OSError, ValueError):
        saved = {"values": {}, "updated_at": None, "updated_by": None, "error": "Saved settings are unreadable"}
    # The values the workers run: master.toml with what the ERP saved on top.
    master = settings.overlay(_read_toml(_env("RS_MASTER_CONFIG", "/config/master.toml")), saved["values"])
    fleet_cfg = _read_toml(_env("RS_FLEET_CONFIG", "/config/fleet.toml"))
    monitor = _read_toml(_env("RS_MONITOR_CONFIG", "/config/monitor.toml"))
    monitor_worker_id = _env("RS_MONITOR_WORKER_ID") or _env("RS_WORKER_ID")
    # What each named worker actually runs, cities included. A fleet worker's
    # config comes from the coordinator below, and wins over a mounted copy.
    worker_cfgs = {
        wid: cfg for wid, path in settings.targets()
        if wid and (cfg := _read_toml(str(path))) is not None
    }
    fleet_ids: list = []

    rows: Optional[list] = None
    accounts: Optional[list] = None
    sessions: Dict[str, Dict[str, Any]] = {}
    coordinator_version: Optional[str] = None
    search_cycles: Optional[list] = None
    worker_reviews: Optional[list] = None
    search_cities: Optional[list] = None
    status_changes: Optional[list] = None
    error: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, base_url=base, headers=headers) as client:
            # healthz is open and cheap; it names the coordinator's build.
            hz = await client.get("/healthz")
            if hz.status_code in (200, 503):
                try:
                    coordinator_version = (hz.json() or {}).get("version")
                except ValueError:
                    coordinator_version = None

            res = await client.get("/v1/workers")
            if res.status_code == 200:
                rows = (res.json() or {}).get("workers") or []
            else:
                error = f"coordinator returned {res.status_code}"

            # An older coordinator answers 404: no fleet, mounted configs only.
            listing = await client.get("/v1/fleet/configs") if rows is not None else None
            if listing is not None and listing.status_code == 200:
                fleet_ids = [c["worker_id"] for c in (listing.json() or {}).get("configs") or []]
                texts = await asyncio.gather(
                    *(client.get(f"/v1/fleet/configs/{wid}") for wid in fleet_ids),
                    return_exceptions=True,
                )
                for wid, text in zip(fleet_ids, texts):
                    if isinstance(text, httpx.Response) and text.status_code == 200:
                        try:
                            worker_cfgs[wid] = tomllib.loads((text.json() or {}).get("toml") or "")
                        except (tomllib.TOMLDecodeError, ValueError):
                            pass

            if rows is not None:
                # Accounts are one list; session metadata is per worker, so ask
                # for every worker the config or the coordinator knows about.
                acc = await client.get("/v1/accounts")
                if acc.status_code == 200:
                    accounts = (acc.json() or {}).get("accounts") or []
                worker_ids = fleet_view.known_worker_ids(fleet_cfg, monitor_worker_id, rows, worker_cfgs)
                metas = await asyncio.gather(
                    *(client.get(f"/v1/session/{wid}/meta") for wid in worker_ids),
                    return_exceptions=True,
                )
                for wid, meta in zip(worker_ids, metas):
                    if isinstance(meta, httpx.Response) and meta.status_code == 200:
                        sessions[wid] = meta.json()

                # Each worker's "today". Two days of rows cover every US
                # zone's local day; an older coordinator answers 404, which
                # leaves `today` (and `status_changes`) null rather than the
                # page broken.
                cycles, reviews, cities, changes = await asyncio.gather(
                    client.get("/v1/stats/search-cycles", params={"hours": 48}),
                    client.get("/v1/stats/reviews/workers", params={"days": 2}),
                    client.get("/v1/stats/search-cities"),
                    client.get("/v1/stats/status-changes", params={"days": 7}),
                    return_exceptions=True,
                )
                if isinstance(cycles, httpx.Response) and cycles.status_code == 200:
                    search_cycles = (cycles.json() or {}).get("rows") or []
                if isinstance(reviews, httpx.Response) and reviews.status_code == 200:
                    worker_reviews = (reviews.json() or {}).get("rows") or []
                if isinstance(cities, httpx.Response) and cities.status_code == 200:
                    search_cities = (cities.json() or {}).get("rows") or []
                if isinstance(changes, httpx.Response) and changes.status_code == 200:
                    status_changes = (changes.json() or {}).get("rows") or []
    except (httpx.HTTPError, ValueError):
        error = "Coordinator is unreachable"

    doc = fleet_view.compose(
        master=master,
        fleet=fleet_cfg,
        monitor=monitor,
        monitor_worker_id=monitor_worker_id,
        worker_configs=worker_cfgs,
        health_rows=rows,
        health_error=error,
        accounts=accounts,
        sessions=sessions,
        versions={"console": __version__, "coordinator": coordinator_version},
        vnc_pages=_vnc_pages(),
        search_cycles=search_cycles,
        worker_reviews=worker_reviews,
        search_cities=search_cities,
    )
    # The week's status changes, newest first, for the ERP's Recent activity.
    doc["status_changes"] = status_changes
    if rows is not None:
        # How often each city is searched. An older coordinator answers 404,
        # which leaves the cities unmarked rather than the page broken.
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_S, base_url=base, headers=headers) as client:
                res = await client.post(
                    "/v1/city-tiers/rank",
                    json={"workers": {
                        w["worker_id"]: [c["slug"] for c in w["cities"]]
                        for w in doc["workers"] if w["cities"]
                    }},
                )
            if res.status_code == 200:
                fleet_view.apply_tiers(doc, res.json() or {})
        except (httpx.HTTPError, ValueError):
            pass
    # Where each worker comes out, asked through its own proxy. Never fails
    # the page: a slow or dead proxy reads `pending` / `error` on its row.
    targets = fleet_view.proxy_targets(doc, dict(os.environ))
    fleet_view.apply_proxies(doc, targets, await proxy_exit.resolve(targets.values()))
    doc["settings"] = {
        "editable": master is not None and "error" not in saved and settings.writable(bool(fleet_ids)),
        "updated_at": saved.get("updated_at"),
        "updated_by": saved.get("updated_by"),
        "error": saved.get("error"),
    }
    return doc


# One save at a time: two interleaved saves would each write the worker
# configs from a different merge.
_settings_lock = threading.Lock()


@app.put("/v1/config/settings", dependencies=[Depends(require_token)])
def put_settings(body: Any = Body(default=None)) -> Dict[str, Any]:
    """Save search settings the ERP's flow card edits, and write them into
    every worker config.

    Only the keys in settings.py can change. Every config is rendered before
    any is written, so a bad value changes nothing; a worker picks the change
    up between jobs (its monitor hashes the file) and sweeps straight away.
    """
    master = _read_toml(_env("RS_MASTER_CONFIG", "/config/master.toml"))
    if master is None:
        raise HTTPException(status_code=503, detail="master.toml is not mounted")
    fleet = _fleet_configs()
    if not settings.writable(fleet is not None):
        raise HTTPException(
            status_code=409,
            detail="This console mounts the worker configs read-only; redeploy it to save settings",
        )
    with _settings_lock:
        try:
            saved = settings.load()
            effective = settings.overlay(master, saved["values"]) or {}
            current = {"search": fleet_view.search_settings(effective)}
            patch = settings.validate(body, list((master.get("item") or {}).keys()), current)
            values = settings.merge(saved["values"], patch)
            changed = settings.apply(values, fleet=fleet)
        except settings.SettingsError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except OSError:
            raise HTTPException(status_code=500, detail="A worker config could not be written") from None
        by = body.get("updated_by") if isinstance(body.get("updated_by"), str) else None
        state = settings.stamp(values, (by or "").strip()[:120] or None)
        settings.save(state)
    return {"updated_at": state["updated_at"], "updated_by": state["updated_by"], "changed": changed}


@app.put("/v1/workers/{worker_id}/cities", dependencies=[Depends(require_token)])
def put_worker_cities(worker_id: str, body: Any = Body(default=None)) -> Dict[str, Any]:
    """Save the cities one worker searches, and write them into its config
    only. The worker picks them up between jobs and sweeps straight away."""
    path = settings.config_for(worker_id)
    fleet = _fleet_configs()
    try:
        in_fleet = fleet is not None and worker_id in fleet.ids()
    except settings.FleetError:
        in_fleet = False
    if path is None and not in_fleet:
        raise HTTPException(status_code=404, detail=f"No config is mounted for worker {worker_id}")
    if not settings.writable(in_fleet):
        raise HTTPException(
            status_code=409,
            detail="This console mounts the worker configs read-only; redeploy it to save cities",
        )
    with _settings_lock:
        try:
            city_list = settings.validate_cities(body)
            saved = settings.load()
            values = settings.merge(saved["values"], {"workers": {worker_id: {"cities": city_list}}})
            changed = settings.apply(
                values,
                [(worker_id, path)] if path is not None else [],
                fleet if in_fleet else None,
                [worker_id],
            )
        except settings.SettingsError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except OSError:
            raise HTTPException(status_code=500, detail="The worker config could not be written") from None
        by = body.get("updated_by") if isinstance(body.get("updated_by"), str) else None
        state = settings.stamp(values, (by or "").strip()[:120] or None)
        settings.save(state)
    return {
        "worker_id": worker_id,
        "cities": city_list,
        "updated_at": state["updated_at"],
        "updated_by": state["updated_by"],
        "changed": changed,
    }


@app.get("/v1/city-tiers", dependencies=[Depends(require_token)])
async def city_tiers() -> Response:
    """How often cities are searched: the tier settings, the pins, and each
    city's alert score over the window."""
    return await _forward("GET", "/v1/city-tiers")


@app.put("/v1/city-tiers", dependencies=[Depends(require_token)])
async def put_city_tiers(body: Any = Body(default=None)) -> Response:
    """Save the tier settings and/or the whole pin map. The coordinator
    validates both; only these keys cross. Workers follow from their next
    search, with no config rewrite."""
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object")
    upstream_body = {k: body[k] for k in ("settings", "pins") if k in body}
    by = body.get("updated_by")
    if isinstance(by, str) and by.strip():
        upstream_body["updated_by"] = by.strip()[:120]
    return await _forward("PUT", "/v1/city-tiers", json_body=upstream_body)


@app.get("/v1/config/filter-prompt", dependencies=[Depends(require_token)])
def filter_prompt() -> Dict[str, Any]:
    """The AI content-filter prompt actually mounted into the live monitor.

    Read from the monitor's own TOML rather than restated, so the console can
    never show a stale copy. Only these three fields ever leave: the config
    also holds proxy settings and an API-key reference nobody outside needs.
    """
    path = _env("RS_MONITOR_CONFIG", "/config/monitor.toml") or ""
    try:
        with open(path, "rb") as handle:
            config = tomllib.load(handle)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Monitor config is not mounted") from None
    except (OSError, tomllib.TOMLDecodeError):
        raise HTTPException(status_code=502, detail="Monitor config is unreadable") from None

    facebook = (config.get("marketplace") or {}).get("facebook") or {}
    ai_tables = config.get("ai") or {}
    model = next(
        (table.get("model") for table in ai_tables.values() if isinstance(table, dict)),
        None,
    )
    return {
        "prompt": facebook.get("prompt"),
        "rating_prompt": facebook.get("rating_prompt"),
        "model": model,
    }
