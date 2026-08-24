"""Review-volume stats: workers report, the console reads.

The daily totals behind the ERP dashboard's review-volume card. Workers POST
per-cycle deltas (how many listings the AI filter freshly evaluated, how many
alerted) after each search sweep; the coordinator accumulates them into one row
per worker per UTC day, and the admin route serves fleet-wide daily sums.

Nothing in the alert path depends on this: a worker that never reports simply
contributes nothing to the chart.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import deps
from ..deps import require_admin, require_worker
from ..schemas import ReviewStatsDay, ReviewStatsList, ReviewStatsReport, StatusResponse

router = APIRouter()

# The window the console may ask for. Wide enough for a quarter's view, small
# enough that the GROUP BY stays trivial.
MAX_DAYS = 92


@router.post("/api/v1/stats/reviews", response_model=StatusResponse)
@router.post("/v1/stats/reviews", response_model=StatusResponse)
def report_reviews(
    payload: ReviewStatsReport, worker: Optional[str] = Depends(require_worker)
) -> StatusResponse:
    # Same precedence as heartbeats: a per-worker token names the worker; the
    # legacy fleet-wide token falls back to what the body claims.
    worker_id = worker or payload.worker_id
    if not worker_id:
        raise HTTPException(status_code=422, detail="worker_id is required")
    if payload.reviewed or payload.alerted:
        deps.db.add_review_stats(
            worker_id, reviewed=payload.reviewed, alerted=payload.alerted
        )
    return StatusResponse()


@router.get(
    "/v1/stats/reviews", response_model=ReviewStatsList, dependencies=[Depends(require_admin)]
)
def daily_reviews(days: int = Query(default=14, ge=1, le=MAX_DAYS)) -> ReviewStatsList:
    return ReviewStatsList(
        days=[ReviewStatsDay(**row) for row in deps.db.review_stats_daily(days)]
    )
