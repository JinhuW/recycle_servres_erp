"""Read-mostly facade between the ERP console and the coordinator.

Why this service exists: the coordinator holds every Facebook account's
secrets and answers 2FA/credential requests, so it stays loopback-only on the
VM — deliberately unreachable from anywhere. The ERP dashboard still needs the
harmless slice of it (fleet health, the checkpoint queue, review stats), so
this facade is what gets exposed through the Cloudflare tunnel instead.

The safety property, stated once: **the coordinator admin token never leaves
this process, and no auth/credential/session route is forwarded.** The routes
below are a closed allowlist — seven reads and one write (resolving a
checkpoint). A full compromise of this service's own token yields fleet
metadata, not accounts.

Configuration (env):
    RS_CONSOLE_TOKEN            bearer token callers must present (required)
    RS_COORDINATOR_URL          coordinator base, default http://coordinator:8500
    RS_COORDINATOR_ADMIN_TOKEN  admin token used upstream (required)
    RS_MONITOR_CONFIG           monitor TOML for the filter prompt,
                                default /config/monitor.toml
"""

import os
import secrets as pysecrets
import tomllib
from typing import Any, Dict, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response

TIMEOUT_S = 10.0
# A checkpoint screenshot is a full browser-window PNG the coordinator may be
# capturing on demand; give it a longer budget than the JSON calls.
SCREENSHOT_TIMEOUT_S = 20.0

app = FastAPI(title="rs-console", docs_url=None, redoc_url=None)


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
