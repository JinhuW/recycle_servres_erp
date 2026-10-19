"""The fleet: which worker runs on which host, on which image.

This module decides; it never touches a container. Each Docker host runs an
agent (rs-fleetd) that asks for its desired state (`desired_for_host`),
reconciles its containers against it, and reports back. So the coordinator
going down stops nothing: agents keep the last desired state they cached, and
the workers keep running.

Two loops run on the coordinator's background thread (`tick`):

* `reconcile_assignments` keeps one worker per ready slot. A slot is a vault
  account with a worker id; it is ready when the fleet is enabled for it and
  its config has been published. Placement is sticky — a slot turned back on
  returns to the host that holds its session — and otherwise goes to the live,
  uncordoned host with the most room. Nothing ever moves on its own: a worker
  on a dead host stays assigned there until an operator moves it, because two
  hosts running one session is the one failure this must never cause.
* `advance_rollout` moves a release through the fleet one worker at a time.
  The next worker waits until the current one heartbeats on the new version in
  a state no worse than before (`gate_ok`). A worker that does not within
  `GATE_TIMEOUT` goes back to its previous image, and the release stops
  there; every other worker keeps running what it ran.
"""

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from .db import AnyDatabase, utcnow
from .health import _moment, _parse_ts
from .telegram_notify import escape_markdown
from .tokens import mint_worker_token

logger = logging.getLogger(__name__)

# An agent reports every 30 s; a host silent for this long is not placed on
# and not rolled.
HOST_LIVE = timedelta(minutes=2)
# How long a rolled worker has to come back on the new version.
GATE_TIMEOUT = timedelta(minutes=20)
# A heartbeat this recent means the worker was up when its rollout began.
FRESH_HEARTBEAT = timedelta(minutes=15)

RUN = "run"
STOPPED = "stopped"

ROLLING = "rolling"
PAUSED = "paused"
DONE = "done"
FAILED = "failed"
ABORTED = "aborted"
SUPERSEDED = "superseded"
ACTIVE = (ROLLING, PAUSED)

HEALTHY = "HEALTHY"
DEAD = "DEAD"
DOWN = "DOWN"

# VNC ports handed to workers on hosts the console reaches over the LAN.
VNC_PORTS = range(5901, 6000)


def host_live(host: Dict[str, Any], now: datetime) -> bool:
    seen = _parse_ts(host.get("last_seen_at"))
    return seen is not None and now - seen < HOST_LIVE


def fleet_image(db: AnyDatabase) -> Optional[str]:
    """The image new workers start on: the newest release that is not failed
    or aborted. None before the first release, which is what sets it."""
    for release in db.list_releases(limit=50):
        if release["state"] in (*ACTIVE, DONE, SUPERSEDED):
            return str(release["image"])
    return None


def active_release(db: AnyDatabase) -> Optional[Dict[str, Any]]:
    return next((r for r in db.list_releases(limit=5) if r["state"] in ACTIVE), None)


def _free_vnc_port(assignments: List[Dict[str, Any]], host_id: str, worker_id: str) -> Optional[int]:
    taken = {
        a.get("vnc_port")
        for a in assignments
        if a["host_id"] == host_id and a["worker_id"] != worker_id and a.get("vnc_port")
    }
    return next((port for port in VNC_PORTS if port not in taken), None)


def _choose_host(
    pin: Optional[str],
    current: Optional[Dict[str, Any]],
    hosts: Dict[str, Dict[str, Any]],
    load: Dict[str, int],
    now: datetime,
) -> Optional[str]:
    if pin:
        return pin if pin in hosts else None
    if current and current["host_id"] in hosts and not hosts[current["host_id"]]["cordoned"]:
        return current["host_id"]
    candidates = [
        h
        for h in hosts.values()
        if not h["cordoned"] and host_live(h, now) and load.get(h["host_id"], 0) < int(h["capacity"])
    ]
    if not candidates:
        return None
    best = min(candidates, key=lambda h: (load.get(h["host_id"], 0) / max(1, int(h["capacity"])), h["host_id"]))
    return str(best["host_id"])


def reconcile_assignments(db: AnyDatabase, now: Optional[datetime] = None) -> List[str]:
    """One worker per ready slot; stop the ones whose slot is no longer ready.

    Returns what changed, one line each, for the log.
    """
    moment = _moment(now)
    stamp = utcnow()
    hosts = {h["host_id"]: h for h in db.list_fleet_hosts()}
    configs = {c["worker_id"] for c in db.list_worker_configs()}
    assignments = db.list_assignments()
    by_worker = {a["worker_id"]: a for a in assignments}
    load: Dict[str, int] = {}
    for a in assignments:
        if a["state"] == RUN:
            load[a["host_id"]] = load.get(a["host_id"], 0) + 1
    image = fleet_image(db)
    changes: List[str] = []
    slots = set()

    for account in db.list_accounts():
        worker_id = account.get("worker_id")
        if not worker_id:
            continue
        slots.add(worker_id)
        current = by_worker.get(worker_id)
        ready = bool(account.get("fleet_enabled")) and worker_id in configs
        if ready and (current is None or current["state"] != RUN):
            host_id = _choose_host(account.get("pin_host"), current, hosts, load, moment)
            start_image = image or (current or {}).get("image")
            if host_id is None or start_image is None:
                continue
            fields: Dict[str, Any] = {
                "host_id": host_id,
                "state": RUN,
                "image": start_image,
                "generation": int((current or {}).get("generation") or 0) + 1,
                "vnc_port": (
                    _free_vnc_port(assignments, host_id, worker_id)
                    if hosts[host_id].get("vnc_host")
                    else None
                ),
            }
            db.put_assignment(worker_id, fields)
            db.update_worker_health(worker_id, {"retired_at": None})
            assignments = [a for a in assignments if a["worker_id"] != worker_id]
            assignments.append({"worker_id": worker_id, **fields})
            load[host_id] = load.get(host_id, 0) + 1
            changes.append(f"start {worker_id} on {host_id} ({start_image})")
        elif not ready and current is not None and current["state"] == RUN:
            _stop(db, current, stamp)
            load[current["host_id"]] -= 1
            changes.append(f"stop {worker_id}: its slot is not enabled or has no config")

    for worker_id, current in by_worker.items():
        if worker_id not in slots and current["state"] == RUN:
            _stop(db, current, stamp)
            changes.append(f"stop {worker_id}: no vault account names it")
    return changes


def _stop(db: AnyDatabase, assignment: Dict[str, Any], stamp: str) -> None:
    db.put_assignment(assignment["worker_id"], {"state": STOPPED})
    db.update_worker_health(assignment["worker_id"], {"retired_at": stamp})


def gate_ok(pre_state: Optional[str], post_state: Optional[str]) -> bool:
    """Whether a rolled worker came back no worse than it left.

    A healthy worker must come back healthy. One that was parked on a
    challenge or an expired session cannot be asked to come back healthy —
    no new image logs it in — so it only must not come back dead. One that
    was down passes on any heartbeat from the new version.
    """
    if pre_state == HEALTHY:
        return post_state == HEALTHY
    if pre_state in (None, DOWN):
        return True
    return post_state != DEAD


def _on_version(worker: Optional[Dict[str, Any]], version: str, since: datetime) -> bool:
    if not worker:
        return False
    reported = str(worker.get("version") or "")
    beat = _parse_ts(worker.get("last_heartbeat_at"))
    # Both stamps are whole seconds; only the new image reports `version`, so a
    # beat in the same second as the start still counts.
    return (reported == version or reported.startswith(version + " ")) and beat is not None and beat >= since


def _names(raw: Optional[str]) -> List[str]:
    try:
        value = json.loads(raw) if raw else []
    except ValueError:
        return []
    return [str(v) for v in value] if isinstance(value, list) else []


def advance_rollout(db: AnyDatabase, now: Optional[datetime] = None) -> List[str]:
    """Move the active release one step. Returns ops alerts to send."""
    moment = _moment(now)
    release = active_release(db)
    if release is None or release["state"] != ROLLING:
        return []
    release_id = int(release["id"])
    version, image = str(release["version"]), str(release["image"])
    upgraded = _names(release.get("upgraded_json"))
    skipped = _names(release.get("skipped_json"))

    current_id = release.get("current_worker")
    if current_id:
        started = _parse_ts(release.get("current_started_at")) or moment
        assignment = db.get_assignment(current_id)
        worker = db.get_worker(current_id)
        if assignment is None or assignment["state"] != RUN:
            skipped.append(current_id)
        elif _on_version(worker, version, started) and gate_ok(
            release.get("current_pre_state"), (worker or {}).get("state")
        ):
            upgraded.append(current_id)
        elif moment - started > GATE_TIMEOUT:
            db.put_assignment(
                current_id,
                {
                    "image": assignment.get("previous_image") or assignment["image"],
                    "previous_image": image,
                    "generation": int(assignment["generation"]) + 1,
                },
            )
            failure = (
                f"{current_id} did not come back on {version} in a state no worse than "
                f"{release.get('current_pre_state') or 'before'} within "
                f"{int(GATE_TIMEOUT.total_seconds() // 60)} minutes "
                f"(it reports {(worker or {}).get('version') or 'nothing'}, "
                f"{(worker or {}).get('state') or 'no state'}); it is back on its previous image"
            )
            db.update_release(
                release_id,
                {
                    "state": FAILED,
                    "failed_worker": current_id,
                    "failure": failure,
                    "current_worker": None,
                    "finished_at": utcnow(),
                    "upgraded_json": json.dumps(upgraded),
                },
            )
            return [
                f"*Release {escape_markdown(version)} stopped*\n{escape_markdown(failure)}\n"
                f"Upgraded first: {len(upgraded)}"
            ]
        else:
            return []

    hosts = {h["host_id"]: h for h in db.list_fleet_hosts()}
    for assignment in db.list_assignments():
        worker_id = assignment["worker_id"]
        if assignment["state"] != RUN or assignment["image"] == image:
            continue
        if worker_id in upgraded or worker_id in skipped:
            continue
        host = hosts.get(assignment["host_id"])
        if host is None or not host["authoritative"] or not host_live(host, moment):
            skipped.append(worker_id)
            continue
        worker = db.get_worker(worker_id) or {}
        beat = _parse_ts(worker.get("last_heartbeat_at"))
        pre_state = worker.get("state") if beat and moment - beat < FRESH_HEARTBEAT else DOWN
        db.put_assignment(
            worker_id,
            {
                "previous_image": assignment["image"],
                "image": image,
                "generation": int(assignment["generation"]) + 1,
            },
        )
        db.update_release(
            release_id,
            {
                "current_worker": worker_id,
                "current_started_at": moment.isoformat(timespec="seconds"),
                "current_pre_state": pre_state,
                "upgraded_json": json.dumps(upgraded),
                "skipped_json": json.dumps(skipped),
            },
        )
        return []

    db.update_release(
        release_id,
        {
            "state": DONE,
            "current_worker": None,
            "finished_at": utcnow(),
            "upgraded_json": json.dumps(upgraded),
            "skipped_json": json.dumps(skipped),
        },
    )
    note = f"*Release {escape_markdown(version)} done*\nUpgraded: {len(upgraded)}"
    if skipped:
        note += "\n" + escape_markdown(
            f"Skipped (host offline or observe-only): {', '.join(skipped)}"
        )
    return [note]


def start_release(db: AnyDatabase, version: str, image: str, by: Optional[str]) -> int:
    """Begin rolling `image` out; an active release is superseded."""
    for release in db.list_releases(limit=5):
        if release["state"] in ACTIVE:
            db.update_release(int(release["id"]), {"state": SUPERSEDED, "finished_at": utcnow()})
    return db.insert_release(
        {"version": version, "image": image, "state": ROLLING, "created_by": by,
         "upgraded_json": "[]", "skipped_json": "[]"}
    )


def tick(db: AnyDatabase, now: Optional[datetime] = None) -> List[str]:
    """One pass of both loops; returns ops alerts."""
    for change in reconcile_assignments(db, now):
        logger.info("Fleet: %s", change)
    return advance_rollout(db, now)


def desired_for_host(db: AnyDatabase, host_id: str) -> Dict[str, Any]:
    """What `host_id`'s agent should run. Worker tokens are minted here, so the
    hand-written per-worker env files are no longer needed."""
    host = db.get_fleet_host(host_id) or {}
    configs = {c["worker_id"]: c["sha256"] for c in db.list_worker_configs()}
    workers = []
    for a in db.list_assignments():
        if a["state"] != RUN or a["host_id"] != host_id or a.get("move_to_host"):
            continue
        workers.append(
            {
                "worker_id": a["worker_id"],
                "image": a["image"],
                "generation": int(a["generation"]),
                "config_sha256": configs.get(a["worker_id"]),
                "vnc_port": a.get("vnc_port"),
                "env": {
                    "RS_WORKER_ID": a["worker_id"],
                    "RS_CONTROL_PLANE_TOKEN": mint_worker_token(a["worker_id"]),
                    "RS_HOST_ID": host_id,
                },
            }
        )
    return {
        "host_id": host_id,
        "authoritative": bool(host.get("authoritative")),
        "generated_at": utcnow(),
        "workers": workers,
    }


def record_report(db: AnyDatabase, host_id: str, report: Dict[str, Any]) -> None:
    """Store a host's report, and finish the moves away from it that it confirms.

    A move hands a worker to its new host only once its old host reports the
    container gone, so one session never runs in two browsers.
    """
    db.upsert_fleet_host(
        host_id,
        {
            "agent_version": report.get("agent_version"),
            "last_seen_at": utcnow(),
            "report_json": json.dumps(report)[:200_000],
        },
    )
    running = {
        str(w.get("worker_id"))
        for w in report.get("workers") or []
        if isinstance(w, dict) and w.get("running")
    }
    hosts = {h["host_id"]: h for h in db.list_fleet_hosts()}
    assignments = db.list_assignments()
    for a in assignments:
        if a["host_id"] == host_id and a.get("move_to_host") and a["worker_id"] not in running:
            _finish_move(db, a, assignments, hosts)


def _finish_move(
    db: AnyDatabase,
    assignment: Dict[str, Any],
    assignments: List[Dict[str, Any]],
    hosts: Dict[str, Dict[str, Any]],
) -> None:
    target = str(assignment["move_to_host"])
    db.put_assignment(
        assignment["worker_id"],
        {
            "host_id": target,
            "move_to_host": None,
            "move_requested_at": None,
            "generation": int(assignment["generation"]) + 1,
            "vnc_port": (
                _free_vnc_port(assignments, target, assignment["worker_id"])
                if (hosts.get(target) or {}).get("vnc_host")
                else None
            ),
        },
    )
    logger.warning("Fleet: moved %s to %s", assignment["worker_id"], target)


def move_worker(db: AnyDatabase, worker_id: str, host_id: str, force: bool) -> Dict[str, Any]:
    """Move a worker to another host. Without `force` it waits for the old host
    to report the container gone; `force` is the operator saying that host is
    dead, and the session restores on the new one from its snapshot."""
    assignment = db.get_assignment(worker_id)
    if assignment is None:
        raise KeyError(worker_id)
    hosts = {h["host_id"]: h for h in db.list_fleet_hosts()}
    if host_id not in hosts:
        raise LookupError(host_id)
    if force:
        _finish_move(db, {**assignment, "move_to_host": host_id}, db.list_assignments(), hosts)
    else:
        db.put_assignment(worker_id, {"move_to_host": host_id, "move_requested_at": utcnow()})
    return db.get_assignment(worker_id) or {}
