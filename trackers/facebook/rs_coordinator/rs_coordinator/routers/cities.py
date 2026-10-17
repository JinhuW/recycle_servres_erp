"""City search frequency: the tier settings, the rank, and a worker's plan.

Workers ask for their plan before each search (`/search-plan`); the console
reads and edits the settings and pins, and asks for the rank of every worker's
cities to show on the fleet page. The logic is in `city_tiers.py`.
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from .. import city_tiers, deps
from ..deps import require_admin, require_worker

router = APIRouter()

MAX_SLOTS = 24
MAX_WORKERS = 100


def _cities(value: Any) -> List[str]:
    if not isinstance(value, list) or len(value) > city_tiers.MAX_CITIES:
        raise HTTPException(status_code=422, detail="cities is a list of city slugs")
    out: List[str] = []
    for city in value:
        if not isinstance(city, str) or not city.strip() or len(city) > city_tiers.MAX_SLUG:
            raise HTTPException(status_code=422, detail="cities is a list of city slugs")
        out.append(city.strip().lower())
    return out


def _ranked(worker_cities: Dict[str, List[str]]) -> Dict[str, Any]:
    config = deps.db.city_tier_config()
    settings = city_tiers.merge_settings(config["settings"])
    scores = city_tiers.scores(deps.db.alert_hit_stats(days=settings["window_days"]))
    return {
        "settings": settings,
        "workers": {
            wid: city_tiers.rank(cities, scores, settings, config["pins"])
            for wid, cities in worker_cities.items()
        },
    }


@router.post("/v1/workers/{worker_id}/search-plan")
def search_plan(
    worker_id: str,
    body: Dict[str, Any] = Body(...),
    worker: Optional[str] = Depends(require_worker),
) -> Dict[str, Any]:
    """The cities to search in this slot, of the worker's own list."""
    if worker is not None and worker != worker_id:
        raise HTTPException(status_code=403, detail="A worker plans only its own searches")
    cities = _cities(body.get("cities"))
    slots, slot = body.get("slots"), body.get("slot")
    if isinstance(slots, bool) or not isinstance(slots, int) or not 1 <= slots <= MAX_SLOTS:
        raise HTTPException(status_code=422, detail=f"slots is 1 to {MAX_SLOTS}")
    if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < slots:
        raise HTTPException(status_code=422, detail="slot is 0 to slots - 1")
    rows = _ranked({worker_id: cities})["workers"][worker_id]
    return {"cities": rows, "search": city_tiers.plan(rows, slot, slots)}


@router.get("/v1/city-tiers", dependencies=[Depends(require_admin)])
def get_tiers() -> Dict[str, Any]:
    config = deps.db.city_tier_config()
    settings = city_tiers.merge_settings(config["settings"])
    scores = city_tiers.scores(deps.db.alert_hit_stats(days=settings["window_days"]))
    return {**config, "settings": settings, "defaults": city_tiers.DEFAULTS, "scores": scores}


@router.put("/v1/city-tiers", dependencies=[Depends(require_admin)])
def put_tiers(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    if set(body) - {"settings", "pins", "updated_by"} or not {"settings", "pins"} & set(body):
        raise HTTPException(status_code=422, detail="Send settings, pins, or both")
    current = deps.db.city_tier_config()
    try:
        settings = (
            city_tiers.validate_settings(body["settings"], current["settings"])
            if "settings" in body
            else None
        )
        pins = city_tiers.validate_pins(body["pins"]) if "pins" in body else None
    except city_tiers.TierError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    by = body.get("updated_by") if isinstance(body.get("updated_by"), str) else None
    deps.db.put_city_tier_config(settings, pins, by)
    return get_tiers()


@router.post("/v1/city-tiers/rank", dependencies=[Depends(require_admin)])
def rank_tiers(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Every named worker's cities with their score and searches a day."""
    workers = body.get("workers")
    if not isinstance(workers, dict) or len(workers) > MAX_WORKERS:
        raise HTTPException(status_code=422, detail="workers maps worker ids to city slugs")
    return _ranked({str(wid): _cities(cities) for wid, cities in workers.items()})
