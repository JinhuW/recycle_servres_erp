"""Read-mostly facade between the ERP console and the coordinator.

Why this service exists: the coordinator holds every Facebook account's
secrets and answers 2FA/credential requests, so it stays loopback-only on the
VM — deliberately unreachable from anywhere. The ERP dashboard still needs the
harmless slice of it (fleet health, the checkpoint queue, review stats), so
this facade is what gets exposed through the Cloudflare tunnel instead.

The safety property, stated once: **the coordinator admin token never leaves
this process, and no auth/credential/session route is forwarded.** The routes
below are a closed allowlist — nine reads and two writes (resolving a
checkpoint, and queuing a worker re-login). Neither write moves a credential
or names an account. A full compromise of this service's own token yields
fleet metadata, not accounts.

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
It reaches a worker only if that worker is listed in RS_VNC_TARGETS, only
with a single-use ticket minted against the console token, and it never
touches the coordinator.
"""

import asyncio
import hashlib
import os
import secrets as pysecrets
import tomllib
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
from fastapi import (
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
from . import vnc

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


@app.post("/v1/workers/{worker_id}/relogin", dependencies=[Depends(require_token)])
async def worker_relogin(worker_id: str) -> Response:
    """Queue a Facebook re-login for one worker (console "Re-login" button).

    A write, but a harmless one: it only flags the worker to re-run its own
    login on its next heartbeat — it moves no credentials and names no account.
    """
    return await _forward("POST", f"/v1/workers/{worker_id}/relogin")


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


def _vnc_targets() -> Dict[str, vnc.Target]:
    return vnc.parse_targets(_env("RS_VNC_TARGETS"))


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
    master = _read_toml(_env("RS_MASTER_CONFIG", "/config/master.toml"))
    fleet_cfg = _read_toml(_env("RS_FLEET_CONFIG", "/config/fleet.toml"))
    monitor = _read_toml(_env("RS_MONITOR_CONFIG", "/config/monitor.toml"))
    monitor_worker_id = _env("RS_MONITOR_WORKER_ID") or _env("RS_WORKER_ID")

    rows: Optional[list] = None
    accounts: Optional[list] = None
    sessions: Dict[str, Dict[str, Any]] = {}
    coordinator_version: Optional[str] = None
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

            if rows is not None:
                # Accounts are one list; session metadata is per worker, so ask
                # for every worker the config or the coordinator knows about.
                acc = await client.get("/v1/accounts")
                if acc.status_code == 200:
                    accounts = (acc.json() or {}).get("accounts") or []
                worker_ids = fleet_view.known_worker_ids(fleet_cfg, monitor_worker_id, rows)
                metas = await asyncio.gather(
                    *(client.get(f"/v1/session/{wid}/meta") for wid in worker_ids),
                    return_exceptions=True,
                )
                for wid, meta in zip(worker_ids, metas):
                    if isinstance(meta, httpx.Response) and meta.status_code == 200:
                        sessions[wid] = meta.json()
    except (httpx.HTTPError, ValueError):
        error = "Coordinator is unreachable"

    return fleet_view.compose(
        master=master,
        fleet=fleet_cfg,
        monitor=monitor,
        monitor_worker_id=monitor_worker_id,
        health_rows=rows,
        health_error=error,
        accounts=accounts,
        sessions=sessions,
        versions={"console": __version__, "coordinator": coordinator_version},
        vnc_pages=_vnc_pages(),
    )


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
