"""Challenges that need a human, and the console endpoints that clear them.

This is the path a worker takes when it hits something it cannot solve: a
CAPTCHA or a hard checkpoint. The worker gives up deliberately, files a
challenge with a screenshot, and an operator is pinged with a link that drops
them into that worker's browser.

The guiding rule here is that an escalation must never be lost. A worker that
is stuck is already not scraping; if we also drop its cry for help it stays
stuck silently. So an unregistered account, a missing VNC URL, or a Telegram
outage all degrade to a stored challenge rather than an error.
"""

import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from .. import deps
from ..deps import require_admin, require_worker
from ..escalation import (
    ScreenshotError,
    decode_screenshot,
    format_alert,
    resolve_vnc_url,
    save_screenshot,
    to_challenge_out,
)
from ..schemas import (
    ChallengeList,
    ChallengeOut,
    EscalateRequest,
    EscalateResponse,
    ResolveRequest,
    StatusResponse,
)
from ..vault import VaultError

logger = logging.getLogger(__name__)

router = APIRouter()


def _account_for(worker_id: str, claimed: str | None) -> Optional[str]:
    """The account behind a worker, best effort.

    `deps.resolve_account` 404s (or 503s without a vault key) when the fleet
    config has no mapping. That is the right answer when a worker asks for a
    secret, but refusing an escalation over it would throw away the only signal
    that a worker is stuck — so fall back to what the worker claims, then to
    nothing, and let the operator sort it out in the console.
    """
    try:
        return deps.resolve_account(worker_id)
    except (HTTPException, VaultError) as e:
        logger.info("Escalating worker %s with no registered account (%s)", worker_id, e)
        return claimed


@router.post("/v1/auth/escalate", response_model=EscalateResponse)
def escalate(
    payload: EscalateRequest, worker: Optional[str] = Depends(require_worker)
) -> EscalateResponse:
    """File a challenge a worker could not clear, and page ops once."""
    # A per-worker token identifies the reporter authoritatively; the legacy
    # fleet token falls back to whatever the body claims.
    worker_id = worker or payload.worker_id
    if not worker_id:
        raise HTTPException(status_code=400, detail="worker_id is required")

    db = deps.db

    # Decode before inserting: an unusable payload should answer 400 without
    # leaving an empty challenge in the operator's queue.
    try:
        blob = decode_screenshot(payload.screenshot_b64)
    except ScreenshotError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    account_id = _account_for(worker_id, payload.account_id)
    account_row = db.account_row_for_worker(worker_id)
    if account_row is None and account_id:
        account_row = db.get_account_row(account_id)
    vnc_url = resolve_vnc_url(db.get_worker(worker_id), account_row)

    challenge_id = db.insert_challenge(
        {
            "worker_id": worker_id,
            "account_id": account_id,
            "kind": payload.kind or "captcha",
            "vnc_url": vnc_url,
            "detail_json": json.dumps(payload.detail or {}),
        }
    )

    # The row exists now, so a disk problem here costs the evidence, not the
    # escalation itself.
    try:
        path = save_screenshot(challenge_id, blob)
    except (ScreenshotError, OSError) as e:
        logger.error("Could not store screenshot for challenge %s: %s", challenge_id, e)
        path = None
    if path:
        db.update_challenge(challenge_id, {"screenshot_path": path})

    # The lock page is not cleared by a code or a puzzle, and each further
    # password login deepens Facebook's suspicion: stop handing them out.
    if payload.kind == "locked" and account_id:
        db.lock_account(account_id, "Facebook lock page")

    # Exactly one page per challenge, and a Telegram outage must not turn into
    # a failed escalation the worker would have to retry.
    try:
        deps.ops_notifier.send(
            format_alert(challenge_id, worker_id, payload.kind, vnc_url, payload.detail)
        )
    except Exception:  # noqa: BLE001 - alerting is best effort by design
        logger.exception("Ops alert failed for challenge %s", challenge_id)

    return EscalateResponse(challenge_id=challenge_id, vnc_url=vnc_url)


@router.get("/v1/challenges", response_model=ChallengeList, dependencies=[Depends(require_admin)])
def list_challenges(
    status: str = Query(default="open", description="open, resolved, or all"),
    limit: int = Query(default=100, ge=1, le=1000),
) -> ChallengeList:
    """The operator's queue. Defaults to what still needs attention."""
    rows = deps.db.list_challenges(status=status, limit=limit)
    return ChallengeList(challenges=[ChallengeOut(**to_challenge_out(row)) for row in rows])


@router.post(
    "/v1/challenges/{challenge_id}/resolve",
    response_model=StatusResponse,
    dependencies=[Depends(require_admin)],
)
def resolve_challenge(
    challenge_id: int, payload: Optional[ResolveRequest] = None
) -> StatusResponse:
    """Mark a challenge cleared once a human has dealt with it."""
    if deps.db.get_challenge(challenge_id) is None:
        raise HTTPException(status_code=404, detail=f"No challenge with id {challenge_id}")

    resolved_by = payload.resolved_by if payload else None
    changed = deps.db.resolve_challenge(challenge_id, resolved_by)
    # Two operators clicking the same row is normal, not an error: report the
    # state rather than failing the second click.
    return StatusResponse(status="ok" if changed else "already_resolved")


@router.get(
    "/v1/challenges/{challenge_id}/screenshot", dependencies=[Depends(require_admin)]
)
def get_screenshot(challenge_id: int) -> FileResponse:
    """The captured screen, so ops can triage without opening a VNC session."""
    row: Dict[str, Any] | None = deps.db.get_challenge(challenge_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"No challenge with id {challenge_id}")

    path = row.get("screenshot_path")
    if not path or not Path(path).is_file():
        raise HTTPException(
            status_code=404, detail=f"Challenge {challenge_id} has no stored screenshot"
        )
    return FileResponse(path, media_type="image/png", filename=f"challenge-{challenge_id}.png")
