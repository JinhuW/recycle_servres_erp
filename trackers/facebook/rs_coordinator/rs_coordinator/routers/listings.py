"""Listing ingestion and query — the original coordinator job.

Workers report matched listings here; the control plane dedupes them across the
fleet and owns the single Telegram alert stream.
"""

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query

from .. import deps
from ..db import utcnow
from ..dedupe import Verdict, classify, dedupe_key
from ..deps import require_worker
from ..schemas import ListingsRequest

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
)


@router.get("/healthz")
def healthz() -> Dict[str, Any]:
    # Report the backend actually in use, not the SQLite path constant: during
    # an incident "db: /data/coordinator.db" on a Postgres deployment sends the
    # operator looking for a file that is not the source of truth.
    postgres = type(deps.db).__name__ == "PostgresDatabase"
    return {
        "status": "ok",
        "telegram": deps.notifier.enabled,
        "backend": "postgres" if postgres else "sqlite",
        "db": "(remote postgres)" if postgres else deps.DB_PATH,
    }


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
    notified = 0

    for listing in payload.listings:
        key = dedupe_key(listing.marketplace, listing.id)
        incoming = listing.model_dump()
        existing = db.get_listing(key)
        verdict = classify(incoming, existing)

        record = {column: incoming.get(column) for column in LISTING_COLUMNS}
        db.record_sighting(key, worker_id, listing.price, listing.ai_score)

        if verdict is Verdict.NEW:
            db.insert_listing(
                {
                    "dedupe_key": key,
                    "marketplace": listing.marketplace,
                    "listing_id": listing.id,
                    "item_name": listing.name,
                    "first_seen_at": utcnow(),
                    "last_seen_at": utcnow(),
                    "first_worker_id": worker_id,
                    **record,
                }
            )
            accepted += 1
        else:
            db.update_listing(key, {**record, "last_seen_at": utcnow()})
            if verdict is Verdict.DUPLICATE:
                duplicates += 1
            else:
                accepted += 1

        if verdict.should_notify:
            stored = db.get_listing(key) or record
            if deps.notifier.send_listing(stored, verdict.value, worker_id):
                db.update_listing(key, {"notified_at": utcnow()})
                notified += 1
            else:
                logger.warning("Telegram alert failed for listing %s", listing.id)

    db.upsert_worker(worker_id, status="ok", heartbeat=True, saw_listing=True)
    return {"accepted": accepted, "duplicates": duplicates, "notified": notified}


@router.get("/api/v1/listings")
def query_listings(
    since: str | None = Query(default=None, description="ISO timestamp lower bound"),
    min_score: int | None = Query(default=None, ge=1, le=5),
    limit: int = Query(default=100, ge=1, le=1000),
    _worker: Optional[str] = Depends(require_worker),
) -> Dict[str, Any]:
    return {"listings": deps.db.query_listings(since=since, min_score=min_score, limit=limit)}
