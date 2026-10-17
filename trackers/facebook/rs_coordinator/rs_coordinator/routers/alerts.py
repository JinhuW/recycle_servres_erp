"""The alert delivery ledger: which Telegram message carries which listing.

The homelab monitor sends listing alerts straight to Telegram (routing them
through the coordinator's outbox buys nothing for a single worker — see the
compose file) and used to discard the message_id the Bot API returned. Partners
mark an alert they are acting on with an emoji reaction, and a reaction only
identifies its message — so without the message_id there is nothing to join it
back to. The monitor now reports every delivered alert message here.

The report is fail-open by design: it happens after the Telegram send has
already succeeded, so a coordinator outage costs only a hit-rate data point,
never an alert.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from .. import deps
from ..deps import require_worker
from ..schemas import AlertMessageReport, StatusResponse

router = APIRouter()


@router.post("/api/v1/alerts/telegram", response_model=StatusResponse)
@router.post("/v1/alerts/telegram", response_model=StatusResponse)
def report_alert_message(
    payload: AlertMessageReport, worker: Optional[str] = Depends(require_worker)
) -> StatusResponse:
    # Same precedence as heartbeats: a per-worker token names the worker; the
    # legacy fleet-wide token falls back to what the body claims.
    worker_id = worker or payload.worker_id
    if not worker_id:
        raise HTTPException(status_code=422, detail="worker_id is required")
    record = payload.model_dump(exclude_none=True)
    record["worker_id"] = worker_id
    # Claim-style insert: a retried report of the same message is a no-op.
    # A direct-send worker's alert bypasses ingest and the outbox, so this is
    # where both of the coordinator's funnel stages see it; once per alert, not
    # per part of a split message.
    if deps.db.add_alert_message(record) and payload.part == 1:
        deps.db.add_review_stats(worker_id, coordinated=1, sent=1)
    return StatusResponse()
