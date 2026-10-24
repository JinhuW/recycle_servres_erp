"""Worker heartbeats and fleet health.

STREAM B OWNS THIS FILE. The heartbeat handler keeps the pre-control-plane
behavior (upsert on heartbeat, list workers) and records the extended health
payload from `HeartbeatRequest`; on top of that it compares each heartbeat with
the worker's previous one and raises an ops alert when — and only when — the
fleet crosses a line. The comparison itself lives in `..health` so it can be
tested without a clock or an HTTP client.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends

from .. import city_queue, deps, health
from ..db import as_utc_stamp
from ..deps import require_admin, require_worker
from ..schemas import (
    DirectivesResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    WorkerList,
    WorkerOut,
    WorkerState,
)

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
        ("login_step", payload.login_step),
        ("login_step_at", payload.login_step_at),
        ("host_id", payload.host_id),
    ):
        if value is not None:
            health_fields[name] = value
    for name, flag in (("browser_ok", payload.browser_ok), ("proxy_ok", payload.proxy_ok)):
        if flag is not None:
            health_fields[name] = 1 if flag else 0

    if health_fields:
        db.update_worker_health(worker_id, health_fields)

    # The monitor stamps last_search_at once per item cycle and its repeater
    # re-sends that stamp every few minutes, so only a changed stamp is a new
    # cycle. It is what the fleet table's day strip starts from.
    if payload.last_search_at and payload.last_search_at != (previous or {}).get("last_search_at"):
        item = payload.detail.get("item")
        try:
            db.log_search_cycle(
                worker_id,
                as_utc_stamp(payload.last_search_at),
                item if isinstance(item, str) else None,
            )
        except Exception:  # noqa: BLE001 - the strip is a nicety; the heartbeat is not
            logger.exception("Could not log a search cycle for worker %s", worker_id)

    # A city queue lease lives as long as its worker reports HEALTHY; one that
    # parks gives its city back now, not when the lease would have run out.
    if payload.state is not None:
        try:
            now = datetime.now(timezone.utc)
            until = now
            if payload.state is WorkerState.HEALTHY:
                stored = db.queue_config("settings")
                minutes = ((stored or {}).get("body") or {}).get(
                    "lease_minutes", city_queue.DEFAULTS["lease_minutes"]
                )
                until = now + timedelta(minutes=minutes)
            stamp = now.isoformat(timespec="seconds")
            moved = db.extend_city_leases(worker_id, until.isoformat(timespec="seconds"), stamp)
            if until == now:
                for lease in moved:
                    db.log_city_event(
                        worker_id,
                        lease["item"],
                        lease["city"],
                        "released",
                        {"reason": payload.state.value},
                        at=stamp,
                    )
        except Exception:  # noqa: BLE001 - a lease runs out on its own; the heartbeat must land
            logger.exception("Could not move the city leases of worker %s", worker_id)

    log_beat(worker_id, previous, payload.state.value if payload.state else None)

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

    return HeartbeatResponse(directives=_take_directives(worker_id))


def log_beat(
    worker_id: str, previous: Optional[Dict[str, Any]], incoming_state: Optional[str] = None
) -> None:
    """Record what a beat changed in the worker's status log.

    `previous` is the row before the beat stamped it. The listing upload calls
    this too, because it stamps the heartbeat as well.
    """
    row = previous or {}
    changes, logged = health.liveness_changes(
        row.get("logged_liveness"), row.get("last_heartbeat_at"), beat=True
    )
    state = health.state_change(row.get("state"), incoming_state)
    if state:
        changes.append(state)
    if not changes and logged == row.get("logged_liveness"):
        return
    try:
        deps.db.log_status_changes(worker_id, changes, logged)
    except Exception:  # noqa: BLE001 - the log is a record; the heartbeat is not
        logger.exception("Could not log a status change for worker %s", worker_id)


def _take_directives(worker_id: str) -> list[str]:
    """Hand out the push-style directives queued for this worker.

    `take_relogin` clears the flag as it reads it, so the worker re-logs in
    once per button press, whichever of the heartbeat or the poll asks first.
    """
    directives: list[str] = []
    if deps.db.take_relogin(worker_id):
        directives.append("relogin")
        logger.info("Delivered re-login directive to worker %s", worker_id)
    if deps.db.take_restore(worker_id):
        directives.append("restore")
        logger.info("Delivered session-restore directive to worker %s", worker_id)
    if deps.db.take_sweep(worker_id):
        directives.append("sweep")
        logger.info("Delivered sweep directive to worker %s", worker_id)
    return directives


@router.post("/v1/workers/{worker_id}/directives", response_model=DirectivesResponse)
def poll_directives(
    worker_id: str, worker: Optional[str] = Depends(require_worker)
) -> DirectivesResponse:
    """Directives without a heartbeat, polled every few seconds by workers.

    Writes no health, so it can run far more often than the heartbeat. As
    with the heartbeat, a per-worker token wins over the id in the path.
    """
    return DirectivesResponse(directives=_take_directives(worker or worker_id))


@router.post("/v1/workers/{worker_id}/relogin", dependencies=[Depends(require_admin)])
def request_relogin(worker_id: str) -> Dict[str, Any]:
    """Queue a re-login for a worker; its next directive poll picks it up.

    Admin-only: the console facade forwards an operator's button press here.
    """
    deps.db.request_relogin(worker_id)
    return {"status": "ok", "worker_id": worker_id, "relogin": "requested"}


@router.post("/v1/workers/{worker_id}/restore-session", dependencies=[Depends(require_admin)])
def request_restore(worker_id: str) -> Dict[str, Any]:
    """Queue a session restore for a worker; its next directive poll picks it up.

    Admin-only: the cookie-first Assign seeds the slot a snapshot through
    `PUT /v1/workers/{id}/session`, then calls this so the worker restores it
    at once rather than at its next sweep — the gentle counterpart to relogin.
    """
    deps.db.request_restore(worker_id)
    return {"status": "ok", "worker_id": worker_id, "restore": "requested"}


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
