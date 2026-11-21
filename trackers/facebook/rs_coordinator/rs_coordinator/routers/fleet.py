"""The fleet's control surface: what each host runs, and how to change it.

Host routes take a host token (`rsc mint-host-token`) and only ever see their
own host. Admin routes are the operator's and the console's: the console
publishes worker configs here and reads assignments to reach each worker's
VNC. The decisions themselves live in `fleet.py`.
"""

import hashlib
import logging
import re
import tomllib
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException

from .. import deps, fleet
from ..deps import require_admin, require_host
from ..schemas import WORKER_ID_PATTERN
from ..tokens import TokenError

logger = logging.getLogger(__name__)

router = APIRouter()

# A real worker config is a few kilobytes; this is room, not a target.
MAX_CONFIG_BYTES = 256 * 1024


def _own_host(host: str, host_id: str) -> None:
    if host != host_id:
        raise HTTPException(status_code=403, detail=f"Host '{host}' may not act for '{host_id}'.")


# -- the agents ---------------------------------------------------------------


@router.get("/v1/fleet/hosts/{host_id}/desired")
def desired(host_id: str, host: str = Depends(require_host)) -> Dict[str, Any]:
    """What this host's agent should run. An unknown host is registered on
    first ask, observe-only and with no workers, so a new VM shows up in
    `rsc fleet hosts` for an operator to give capacity and trust."""
    _own_host(host, host_id)
    if deps.db.get_fleet_host(host_id) is None:
        deps.db.upsert_fleet_host(host_id, {})
        logger.warning("Fleet: new host %s registered, observe-only", host_id)
    try:
        return fleet.desired_for_host(deps.db, host_id)
    except TokenError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@router.get("/v1/fleet/hosts/{host_id}/configs/{worker_id}")
def host_config(host_id: str, worker_id: str, host: str = Depends(require_host)) -> Dict[str, Any]:
    """A worker's config, for the host it is assigned to and no other."""
    _own_host(host, host_id)
    assignment = deps.db.get_assignment(worker_id)
    if assignment is None or assignment["host_id"] != host_id:
        raise HTTPException(status_code=403, detail=f"Worker '{worker_id}' is not on host '{host_id}'.")
    config = deps.db.get_worker_config(worker_id)
    if config is None:
        raise HTTPException(status_code=404, detail=f"No config is published for worker '{worker_id}'.")
    return {"worker_id": worker_id, "sha256": config["sha256"], "toml": config["toml"]}


@router.post("/v1/fleet/hosts/{host_id}/report")
def host_report(
    host_id: str, report: Dict[str, Any] = Body(...), host: str = Depends(require_host)
) -> Dict[str, str]:
    _own_host(host, host_id)
    fleet.record_report(deps.db, host_id, report)
    return {"status": "ok"}


# -- the operator and the console -------------------------------------------


@router.get("/v1/fleet/state", dependencies=[Depends(require_admin)])
def state() -> Dict[str, Any]:
    """Hosts, assignments, slots, configs and the recent releases."""
    db = deps.db
    workers = {w["worker_id"]: w for w in db.list_workers()}
    return {
        "hosts": [
            {k: v for k, v in h.items() if k != "report_json"} | {"live": fleet.host_live(h, fleet._moment(None))}
            for h in db.list_fleet_hosts()
        ],
        "assignments": [
            a | {"version": (workers.get(a["worker_id"]) or {}).get("version"),
                 "worker_state": (workers.get(a["worker_id"]) or {}).get("state")}
            for a in db.list_assignments()
        ],
        "slots": [
            {
                "account_id": a["account_id"],
                "worker_id": a.get("worker_id"),
                "fleet_enabled": bool(a.get("fleet_enabled")),
                "pin_host": a.get("pin_host"),
            }
            for a in db.list_accounts()
        ],
        "configs": db.list_worker_configs(),
        "image": fleet.fleet_image(db),
        "releases": db.list_releases(limit=10),
    }


@router.get("/v1/fleet/configs", dependencies=[Depends(require_admin)])
def list_configs() -> Dict[str, Any]:
    return {"configs": deps.db.list_worker_configs()}


@router.get("/v1/fleet/configs/{worker_id}", dependencies=[Depends(require_admin)])
def get_config(worker_id: str) -> Dict[str, Any]:
    config = deps.db.get_worker_config(worker_id)
    if config is None:
        raise HTTPException(status_code=404, detail=f"No config is published for worker '{worker_id}'.")
    return config


@router.put("/v1/fleet/configs/{worker_id}", dependencies=[Depends(require_admin)])
def put_config(worker_id: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Publish a worker's config as it should run. Refused unless it parses:
    an agent would write it straight into a running worker."""
    if not re.match(WORKER_ID_PATTERN, worker_id):
        raise HTTPException(status_code=400, detail="Not a valid worker id")
    text = body.get("toml")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="toml is required")
    if len(text.encode()) > MAX_CONFIG_BYTES:
        raise HTTPException(status_code=413, detail="That is not a worker config")
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Not valid TOML: {e}") from e
    sha = hashlib.sha256(text.encode()).hexdigest()
    current = deps.db.get_worker_config(worker_id)
    by = body.get("updated_by") if isinstance(body.get("updated_by"), str) else None
    if current is None or current["sha256"] != sha:
        deps.db.put_worker_config(worker_id, text, sha, (by or "")[:120] or None)
    return {"worker_id": worker_id, "sha256": sha, "changed": current is None or current["sha256"] != sha}
