"""Workers report system faults here; the coordinator pages ops once per fault.

The monitor evaluates every listing through one shared AI provider, so when
that provider fails every worker sees it at once. Each worker reports the
crossing (`down` after several consecutive failures, `up` after several
successes) and this endpoint folds the reports into one incident per key —
`incidents.apply` holds the rules. The page rides the durable outbox as an
`ops` alert, so a Telegram hiccup delays it rather than losing it.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from .. import deps, incidents
from ..deps import require_admin, require_worker
from ..schemas import IncidentReport, IncidentResponse

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/v1/incidents", response_model=IncidentResponse)
@router.post("/v1/incidents", response_model=IncidentResponse)
def report_incident(
    payload: IncidentReport, worker: Optional[str] = Depends(require_worker)
) -> IncidentResponse:
    # Same precedence as heartbeats: a per-worker token names the worker; the
    # legacy fleet-wide token falls back to what the body claims.
    worker_id = worker or payload.worker_id
    if not worker_id:
        raise HTTPException(status_code=422, detail="worker_id is required")

    db = deps.db
    row, text = incidents.apply(
        payload.key,
        db.get_incident(payload.key),
        worker_id,
        payload.state,
        payload.detail,
        cooldown=incidents.cooldown_from_env(),
        vote_ttl=incidents.vote_ttl_from_env(),
    )
    db.save_incident(row)
    if text:
        db.enqueue_alert("ops-incident", text, dedupe_key=payload.key)
        logger.info("Incident %s %s by %s: paged", payload.key, payload.state, worker_id)
    else:
        logger.info("Incident %s %s by %s: absorbed", payload.key, payload.state, worker_id)
    return IncidentResponse(open=bool(row.get("is_open")), alerted=bool(text))


@router.get("/v1/incidents", dependencies=[Depends(require_admin)])
def list_incidents() -> dict:
    """Console-facing: every incident key with its current state."""
    return {"incidents": deps.db.list_incidents()}
