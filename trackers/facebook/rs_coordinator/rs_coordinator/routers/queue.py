"""The city queue's shadow report: what the fleet did, and what the queue
would have done with the same accounts at the same times.

The console sends the roster (the catalog, and each worker's home cities,
proxy and start_at times), because only it reads the worker configs. The
logic is in `city_queue.py`; workers do not call anything here.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException

from .. import city_queue, city_tiers, deps
from ..deps import require_admin

router = APIRouter()

# Well past what a fleet of MAX_WORKERS logs in MAX_DAYS + the warm-up day.
STATUS_EVENT_LIMIT = 20000


@router.post("/v1/queue/shadow", dependencies=[Depends(require_admin)])
def shadow(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    days = body.get("days", 3)
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= city_queue.MAX_DAYS:
        raise HTTPException(status_code=422, detail=f"days is 1 to {city_queue.MAX_DAYS}")
    config = deps.db.city_tier_config()
    try:
        roster = city_queue.validate_roster(body.get("roster"))
        settings = city_queue.validate_settings(body.get("settings"), config["settings"])
    except city_queue.QueueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    warm = start - timedelta(days=1)
    scores = city_tiers.scores(deps.db.alert_hit_stats(days=settings["tiers"]["window_days"]))
    return city_queue.shadow_report(
        roster,
        settings,
        scores,
        config["pins"],
        # The whole log: the replay starts from the last visit before it.
        deps.db.city_searches_since("0"),
        deps.db.status_events_since(warm.isoformat(timespec="seconds"), STATUS_EVENT_LIMIT),
        deps.db.list_workers(),
        start.timestamp(),
        end.timestamp(),
    )
