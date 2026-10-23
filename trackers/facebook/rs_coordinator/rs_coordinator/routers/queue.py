"""The city queue: enrolled workers ask it for their next city, operators set
it and read it, and the shadow report replays it.

The console sends the roster (the catalog, and each worker's home cities and
start_at times), because only it reads the worker configs. The logic is in
`city_queue.py`.
"""

import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from .. import city_queue, city_tiers, deps
from ..deps import require_admin, require_worker

router = APIRouter()

# Well past what a fleet of MAX_WORKERS logs in MAX_DAYS + the warm-up day.
STATUS_EVENT_LIMIT = 20000
MAX_ITEM = 120

# Picking a city and leasing it is one step: two workers asking at the same
# moment must not both get it. The coordinator is a single process.
_handout = threading.Lock()


def _stamp(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _slugs(value: Any, what: str) -> list:
    if not isinstance(value, list) or len(value) > city_tiers.MAX_CITIES:
        raise HTTPException(status_code=422, detail=f"{what} is a list of city slugs")
    try:
        return list(dict.fromkeys(city_queue._slug(v) for v in value))
    except city_queue.QueueError:
        raise HTTPException(status_code=422, detail=f"{what} is a list of city slugs") from None


@router.post("/v1/workers/{worker_id}/next-city")
def next_city(
    worker_id: str,
    body: Dict[str, Any] = Body(...),
    worker: Optional[str] = Depends(require_worker),
) -> Dict[str, Any]:
    """The worker's next city for one item, closing the one it just searched.

    Always a 200 with a body: the monitor reads any other answer as no answer
    and falls back to its own list, which is only right when the queue is
    unreachable.
    """
    if worker is not None and worker != worker_id:
        raise HTTPException(status_code=403, detail="A worker asks only for its own cities")
    item = body.get("item")
    if not isinstance(item, str) or not item.strip() or len(item) > MAX_ITEM:
        raise HTTPException(status_code=422, detail="item is the search item's name")
    item = item.strip()
    home = _slugs(body.get("home", []), "home")
    start_at = body.get("start_at", [])
    if not isinstance(start_at, list):
        raise HTTPException(status_code=422, detail="start_at is a list of times")
    done = body.get("done")
    if done is not None:
        done = _slugs([done], "done")[0]

    now = datetime.now(timezone.utc)
    with _handout:
        settings = city_queue.load_settings(deps.db)
        deps.db.settle_city_leases(worker_id, item, done, _stamp(now))
        if not city_queue.enrolled(worker_id, settings):
            return {"queue": False}
        answer = city_queue.next_city(
            worker_id,
            item,
            home,
            city_queue.daily_times(start_at),
            now.timestamp(),
            settings,
            city_queue.load_live(deps.db, now, settings),
        )
        if answer.get("city"):
            deps.db.open_city_lease(
                worker_id,
                item,
                answer["city"]["slug"],
                answer["why"],
                _stamp(now),
                _stamp(now + timedelta(minutes=settings["lease_minutes"])),
            )
    return answer


@router.put("/v1/workers/{worker_id}/queue", dependencies=[Depends(require_admin)])
def put_worker_queue(worker_id: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Put one worker in the queue or take it out. 409 for a worker whose
    monitor never asks the queue, because enrolling it would only free its
    cities to the others."""
    on = body.get("enrolled")
    if not isinstance(on, bool):
        raise HTTPException(status_code=422, detail="enrolled is true or false")
    by = body.get("updated_by") if isinstance(body.get("updated_by"), str) else None
    with _handout:
        try:
            settings = city_queue.enroll(deps.db, worker_id, on, by)
        except city_queue.NotCapable as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
    return {
        "worker_id": worker_id,
        "enrolled": city_queue.enrolled(worker_id, settings),
        "everyone": city_queue.EVERY_WORKER in settings["enrolled"],
    }


@router.put("/v1/queue/roster", dependencies=[Depends(require_admin)])
def put_roster(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """The console's roster: the catalog and each worker's home cities."""
    try:
        roster = city_queue.validate_roster(body)
    except city_queue.QueueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    by = body.get("updated_by") if isinstance(body.get("updated_by"), str) else None
    deps.db.put_queue_config("roster", roster.dump(), by)
    return {"cities": len(roster.cities), "workers": len(roster.workers)}


def _settings_view() -> Dict[str, Any]:
    stored = deps.db.queue_config("settings") or {}
    return {
        "settings": {k: v for k, v in city_queue.load_settings(deps.db).items() if k != "tiers"},
        "defaults": city_queue.DEFAULTS,
        "updated_at": stored.get("updated_at"),
        "updated_by": stored.get("updated_by"),
    }


@router.get("/v1/queue/settings", dependencies=[Depends(require_admin)])
def get_settings() -> Dict[str, Any]:
    return _settings_view()


@router.put("/v1/queue/settings", dependencies=[Depends(require_admin)])
def put_settings(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Change the given keys; the rest keep their stored or default value."""
    changes = {k: v for k, v in body.items() if k != "updated_by"}
    by = body.get("updated_by") if isinstance(body.get("updated_by"), str) else None
    try:
        city_queue.save_settings(deps.db, changes, by)
    except city_queue.QueueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return _settings_view()


@router.get("/v1/queue/status", dependencies=[Depends(require_admin)])
def status() -> Dict[str, Any]:
    now = datetime.now(timezone.utc)
    settings = city_queue.load_settings(deps.db)
    out = city_queue.queue_status(
        now.timestamp(), settings, city_queue.load_live(deps.db, now, settings)
    )
    roster = deps.db.queue_config("roster")
    out["roster_updated_at"] = roster["updated_at"] if roster else None
    return out


@router.post("/v1/queue/shadow", dependencies=[Depends(require_admin)])
def shadow(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    days = body.get("days", 3)
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= city_queue.MAX_DAYS:
        raise HTTPException(status_code=422, detail=f"days is 1 to {city_queue.MAX_DAYS}")
    config = deps.db.city_tier_config()
    try:
        roster = city_queue.validate_roster(body.get("roster"))
        settings = city_queue.load_settings(deps.db, body.get("settings"))
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
        deps.db.status_events_since(_stamp(warm), STATUS_EVENT_LIMIT),
        deps.db.list_workers(),
        start.timestamp(),
        end.timestamp(),
    )
