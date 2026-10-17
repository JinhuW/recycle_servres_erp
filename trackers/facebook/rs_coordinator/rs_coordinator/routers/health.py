"""Worker heartbeats and fleet health.

STREAM B OWNS THIS FILE. The heartbeat handler keeps the pre-control-plane
behavior (upsert on heartbeat, list workers) and records the extended health
payload from `HeartbeatRequest`; on top of that it compares each heartbeat with
the worker's previous one and raises an ops alert when — and only when — the
fleet crosses a line. The comparison itself lives in `..health` so it can be
tested without a clock or an HTTP client.
"""

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends

from .. import deps, health
from ..deps import require_admin, require_worker
from ..schemas import HeartbeatRequest, HeartbeatResponse, WorkerList, WorkerOut

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/v1/heartbeat", response_model=HeartbeatResponse)
@router.post("/v1/heartbeat", response_model=HeartbeatResponse)
def heartbeat(
    payload: HeartbeatRequest, worker: Optional[str] = Depends(require_worker)
) -> HeartbeatResponse:
    worker_id = worker or payload.worker_id
    db = deps.db

    # Read before writing: the alert decision is a comparison against what this
    # worker last reported, and the upsert below overwrites exactly that.
    previous = db.get_worker(worker_id)

    # Keep the original row semantics (status/region/detail + heartbeat stamp)…
    db.upsert_worker(
        worker_id,
        status=payload.status,
        region=payload.region,
        detail=payload.detail,
        heartbeat=True,
    )

    # …then record whatever health fields this worker reported. Absent fields
    # are left untouched rather than blanked.
    health_fields: Dict[str, Any] = {}
    for name, value in (
        ("state", payload.state.value if payload.state else None),
        ("account_id", payload.account_id),
        ("session_expiry", payload.session_expiry),
        ("last_search_at", payload.last_search_at),
        ("error_count", payload.error_count),
        ("vnc_url", payload.vnc_url),
        ("version", payload.version),
    ):
        if value is not None:
            health_fields[name] = value
    for name, flag in (("browser_ok", payload.browser_ok), ("proxy_ok", payload.proxy_ok)):
        if flag is not None:
            health_fields[name] = 1 if flag else 0

    if health_fields:
        db.update_worker_health(worker_id, health_fields)

    # The stored row, not the payload: a partial heartbeat still carries the
    # account and VNC link an earlier one reported, and the alert needs them.
    current = db.get_worker(worker_id) or {}
    alert = health.transition_alert(
        previous,
        payload.state.value if payload.state else None,
        worker_id,
        current,
    )
    if alert:
        try:
            deps.ops_notifier.send(alert)
        except Exception:  # noqa: BLE001 - a broken Telegram must not stop the fleet
            # The heartbeat has already been persisted, so swallowing this only
            # costs an alert; failing it would make workers retry and thrash.
            logger.exception("Ops alert failed for worker %s", worker_id)

    # Deliver any push-style directives the console has queued for this worker.
    # `take_relogin` clears the flag as it reads it, so the worker re-logs in
    # once per button press rather than on every heartbeat that follows it.
    directives: list[str] = []
    if db.take_relogin(worker_id):
        directives.append("relogin")
        logger.info("Delivered re-login directive to worker %s", worker_id)

    return HeartbeatResponse(directives=directives)


@router.post("/v1/workers/{worker_id}/relogin", dependencies=[Depends(require_admin)])
def request_relogin(worker_id: str) -> Dict[str, Any]:
    """Queue a re-login for a worker; its next heartbeat picks it up.

    Admin-only: the console facade forwards an operator's button press here.
    """
    deps.db.request_relogin(worker_id)
    return {"status": "ok", "worker_id": worker_id, "relogin": "requested"}


@router.get("/api/v1/workers")
def list_workers(_worker: Optional[str] = Depends(require_worker)) -> Dict[str, Any]:
    """Legacy listing, still reachable with a worker/legacy token.

    Returns raw rows on purpose: workers deployed before the control plane
    parse this shape, so the derived fields go on the admin route instead.
    """
    return {"workers": deps.db.list_workers()}


@router.get("/v1/workers", response_model=WorkerList, dependencies=[Depends(require_admin)])
def list_workers_admin() -> WorkerList:
    """Console-facing fleet view, with liveness and expiry derived on read."""
    workers = [
        WorkerOut(
            **{
                name: value
                for name, value in health.enrich(row).items()
                if name in WorkerOut.model_fields
            }
        )
        for row in deps.db.list_workers()
    ]
    return WorkerList(workers=workers)
