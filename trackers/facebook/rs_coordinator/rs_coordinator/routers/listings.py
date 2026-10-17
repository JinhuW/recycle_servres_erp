"""Listing ingestion and query — the original coordinator job.

Workers report matched listings here; the control plane dedupes them across the
fleet and owns the single Telegram alert stream.
"""

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query, Response

from .. import __version__, deps
from ..db import utcnow
from ..dedupe import Verdict, classify, dedupe_key
from ..deps import require_worker
from ..schemas import ListingsRequest
from ..telegram_notify import format_listing

logger = logging.getLogger(__name__)

router = APIRouter()

# Listing fields the workers send that map onto our columns. Anything else in
# the payload (aimm may add fields) is ignored rather than rejected.
LISTING_COLUMNS = (
    "title",
    "price",
    "location",
    "post_url",
    "condition",
    "seller",
    "description",
    "image",
    "listing_hash",
    "ai_score",
    "ai_comment",
    "ai_count",
)


@router.get("/healthz")
def healthz(response: Response) -> Dict[str, Any]:
    """Is this coordinator able to do its job right now?

    It touches the database, because without that it cannot. Every route that
    matters here reads or writes, so a coordinator with a dead Postgres pool
    accepts listings and loses them — and Docker's healthcheck (see
    deploy/docker-compose.coordinator.yml) only asks this endpoint, so a
    healthz that never queried reported a healthy container throughout.

    Answers 503 when the database is unreachable, so the healthcheck fails
    instead of the operator having to notice.
    """
    body: Dict[str, Any] = {
        "status": "ok",
        # The build this process runs, so the dashboards can name it next to
        # each worker's.
        "version": __version__,
        "telegram": deps.notifier.enabled,
    }

    try:
        # The open itself is lazy and can fail (unreachable Postgres at boot);
        # after that, the cheapest statement that proves a usable connection:
        # it takes one from the pool, round-trips it, and returns it.
        db = deps.db
        # Report the backend actually in use, not the SQLite path constant:
        # during an incident "db: /data/coordinator.db" on a Postgres
        # deployment sends the operator looking for a file that is not the
        # source of truth.
        postgres = type(db).__name__ == "PostgresDatabase"
        body["backend"] = "postgres" if postgres else "sqlite"
        body["db"] = "(remote postgres)" if postgres else db.path
        with db.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
        # Alerts waiting on Telegram. A growing number with a live database
        # means the *other* half of the job is failing, and quietly.
        body["alert_backlog"] = db.outbox_backlog()
    except Exception as e:
        logger.exception("healthz could not reach the database")
        response.status_code = 503
        body["status"] = "degraded"
        body["database"] = f"unreachable: {type(e).__name__}: {e}"
        return body

    body["database"] = "ok"
    return body


@router.post("/api/v1/listings")
def report_listings(
    payload: ListingsRequest, worker: Optional[str] = Depends(require_worker)
) -> Dict[str, Any]:
    # A per-worker token identifies the reporter authoritatively; the legacy
    # fleet token falls back to whatever the body claims.
    worker_id = worker or payload.worker_id
    db = deps.db
    accepted = 0
    duplicates = 0
    queued = 0
    failed = 0

    for listing in payload.listings:
        try:
            verdict = _ingest_one(db, listing, worker_id)

            if verdict.should_notify:
                # Enqueued, not sent: the background loop (background.py) owns
                # delivery, so a Telegram outage delays this alert instead of
                # losing it, and a big batch does not hold this request behind
                # the notifier's 1 msg/sec pacing past the worker's timeout.
                key = dedupe_key(listing.marketplace, listing.id)
                stored = db.get_listing(key) or listing.model_dump()
                db.enqueue_alert(
                    f"listing_{verdict.value}",
                    format_listing(stored, verdict.value, worker_id),
                    dedupe_key=key,
                )
                queued += 1
        except Exception:
            # One malformed or unlucky listing must not cost the worker the rest
            # of its batch: everything after it in the loop would go unrecorded
            # and unalerted, and the worker has no way to tell which.
            logger.exception("Could not ingest listing %s; skipping it", listing.id)
            failed += 1
            continue

        if verdict is Verdict.DUPLICATE:
            duplicates += 1
        else:
            accepted += 1

    db.upsert_worker(worker_id, status="ok", heartbeat=True, saw_listing=True)
    db.add_review_stats(worker_id, coordinated=queued)
    result = {"accepted": accepted, "duplicates": duplicates, "queued": queued}
    if failed:
        result["failed"] = failed
    return result


def _ingest_one(db: Any, listing: Any, worker_id: str) -> Verdict:
    """Record one listing and return what it turned out to be.

    The verdict is decided by whether *our* insert won, not by a read that
    happened earlier: `get_listing` releases the database lock before the insert
    takes it again, and FastAPI runs these handlers in a threadpool, so two
    workers reporting the same border listing can both read "absent". Both would
    then alert, and the loser's plain INSERT would raise a UNIQUE violation.
    """
    key = dedupe_key(listing.marketplace, listing.id)
    incoming = listing.model_dump()
    record = {column: incoming.get(column) for column in LISTING_COLUMNS}
    db.record_sighting(key, worker_id, listing.price, listing.ai_score)

    if classify(incoming, db.get_listing(key)) is Verdict.NEW:
        now = utcnow()
        won = db.claim_listing(
            {
                "dedupe_key": key,
                "marketplace": listing.marketplace,
                "listing_id": listing.id,
                "item_name": listing.name,
                "first_seen_at": now,
                "last_seen_at": now,
                "first_worker_id": worker_id,
                **record,
            }
        )
        if won:
            return Verdict.NEW
        # Someone inserted it between our read and our insert. Re-read and
        # judge against what they wrote, so the loser reports a duplicate (or a
        # genuine price drop) instead of a second "new listing" alert.

    verdict = classify(incoming, db.get_listing(key))
    db.update_listing(key, {**record, "last_seen_at": utcnow()})
    return verdict


@router.get("/api/v1/listings")
def query_listings(
    since: str | None = Query(default=None, description="ISO timestamp lower bound"),
    min_score: int | None = Query(default=None, ge=1, le=5),
    limit: int = Query(default=100, ge=1, le=1000),
    _worker: Optional[str] = Depends(require_worker),
) -> Dict[str, Any]:
    return {"listings": deps.db.query_listings(since=since, min_score=min_score, limit=limit)}
