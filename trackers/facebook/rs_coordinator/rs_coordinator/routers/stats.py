"""Funnel stats: workers report, the console reads.

The daily totals behind the ERP dashboard's review-volume card and its
search-to-alert funnel. Workers POST per-search-page deltas for each stage they
run (searches, cards, gates, page visits, fresh AI verdicts, matches); the
coordinator adds the two stages it runs itself (ingest, Telegram delivery).
Everything accumulates into one row per worker per UTC day, and the admin route
serves fleet-wide daily sums.

Nothing in the alert path depends on this: a worker that never reports simply
contributes nothing to the chart.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import deps
from ..db import SEARCH_CYCLE_DAYS
from ..deps import require_admin, require_worker
from ..schemas import (
    AlertHitList,
    AlertHitRow,
    ReviewStatsDay,
    ReviewStatsList,
    ReviewStatsReport,
    SearchCityList,
    SearchCityRow,
    SearchCycleList,
    SearchCycleRow,
    StatusResponse,
    WorkerReviewStatsDay,
    WorkerReviewStatsList,
)

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
    deps.db.add_review_stats(
        worker_id, **payload.model_dump(exclude={"worker_id", "search_city"})
    )
    if payload.search_city and payload.searches:
        deps.db.touch_search_city(worker_id, payload.search_city)
    return StatusResponse()


@router.get(
    "/v1/stats/reviews", response_model=ReviewStatsList, dependencies=[Depends(require_admin)]
)
def daily_reviews(days: int = Query(default=14, ge=1, le=MAX_DAYS)) -> ReviewStatsList:
    return ReviewStatsList(
        days=[ReviewStatsDay(**row) for row in deps.db.review_stats_daily(days)]
    )


@router.get(
    "/v1/stats/reviews/workers",
    response_model=WorkerReviewStatsList,
    dependencies=[Depends(require_admin)],
)
def worker_reviews(days: int = Query(default=2, ge=1, le=MAX_DAYS)) -> WorkerReviewStatsList:
    """The same counters per worker, with when each row last moved: the
    fleet table's searches, new posts and end of a sweep."""
    return WorkerReviewStatsList(
        rows=[WorkerReviewStatsDay(**row) for row in deps.db.review_stats_by_worker(days)]
    )


@router.get(
    "/v1/stats/search-cycles",
    response_model=SearchCycleList,
    dependencies=[Depends(require_admin)],
)
def search_cycles(
    hours: int = Query(default=48, ge=1, le=SEARCH_CYCLE_DAYS * 24),
) -> SearchCycleList:
    """Raw rows, oldest first. The console buckets them into each worker's
    local day, which no single UTC cutoff here could do."""
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    return SearchCycleList(
        rows=[SearchCycleRow(**row) for row in deps.db.search_cycles_since(since)]
    )


@router.get(
    "/v1/stats/search-cities",
    response_model=SearchCityList,
    dependencies=[Depends(require_admin)],
)
def search_cities() -> SearchCityList:
    """Every worker x city with its last search; the console cuts each
    worker's local day from them, as with the search cycles."""
    return SearchCityList(rows=[SearchCityRow(**row) for row in deps.db.search_cities()])


@router.get(
    "/v1/stats/alert-hits", response_model=AlertHitList, dependencies=[Depends(require_admin)]
)
def alert_hits(days: int = Query(default=14, ge=1, le=MAX_DAYS)) -> AlertHitList:
    """Sent-vs-reacted counts per (day, priority, item, city) bucket.

    A "hit" is an alerted listing at least one partner currently has an emoji
    reaction on. Raw emoji stay in the database; nothing is interpreted here,
    so a taxonomy (bought / bad alert / ...) can be layered on later.
    """
    return AlertHitList(
        rows=[AlertHitRow(**row) for row in deps.db.alert_hit_stats(days)],
        unmatched_reactions=deps.db.unmatched_reaction_count(days),
    )
