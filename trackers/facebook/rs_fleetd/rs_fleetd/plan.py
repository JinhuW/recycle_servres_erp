"""From the desired state and the containers on the host, to a list of actions.

Pure: no Docker, no network, no clock. Every rule that decides whether a
running Facebook worker is touched lives here, where it can be tested without
a daemon:

* missing → RUN; out of date (or a compose container being adopted) →
  RECREATE; stopped → START; managed but no longer desired → REMOVE.
* **Offline** (no fresh desired state) the plan only starts what it last knew
  about: never RECREATE, never REMOVE. Blind is not the time to change things.
* REMOVE also needs an authoritative desired state: an observe-only host must
  never lose a worker it does not yet own.
* At most one RUN or RECREATE per tick. Each starts a sweep and a Facebook
  login; ten at once from one host is a pattern worth not showing.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from . import state

RUN = "run"
RECREATE = "recreate"
START = "start"
REMOVE = "remove"

CONTAINER_PREFIX = "rs-worker-"
WORKER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class WorkerSpec:
    """One desired worker, resolved to the exact container it should be."""

    worker_id: str
    image: str
    generation: int
    env: Tuple[Tuple[str, str], ...]
    config_sha256: Optional[str]
    config_path: str
    data_dir: str
    cache_volume: str
    vnc_port: Optional[int]
    network: str
    env_files: Tuple[str, ...]
    adopted: bool = False

    @property
    def container(self: "WorkerSpec") -> str:
        return CONTAINER_PREFIX + self.worker_id

    def spec_hash(self: "WorkerSpec") -> str:
        """What a running container is compared against, as its `rs.fleet.spec`.

        Everything that only takes effect when the container is created. The
        config's *content* is not in it: the config is rewritten in place and
        the monitor reloads it, so a city edit must not recreate the worker.
        """
        canonical = json.dumps(
            {
                "image": self.image,
                "env": dict(self.env),
                "generation": self.generation,
                "config_path": self.config_path,
                "data_dir": self.data_dir,
                "cache_volume": self.cache_volume,
                "vnc_port": self.vnc_port,
                "network": self.network,
                "env_files": list(self.env_files),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Container:
    """A container the agent counts as a fleet worker."""

    name: str
    worker_id: str
    managed: bool
    running: bool
    image: Optional[str] = None
    spec: Optional[str] = None
    generation: Optional[int] = None
    health: str = "none"
    started_at: Optional[str] = None


@dataclass(frozen=True)
class Action:
    kind: str
    worker_id: str
    container: Optional[str] = None
    reason: str = ""

    def as_dict(self: "Action") -> Dict[str, Any]:
        return {"action": self.kind, "worker_id": self.worker_id, "reason": self.reason}


@dataclass
class Settings:
    """What the host contributes to every worker's container."""

    root: Path
    network: str = "rs-fleet"
    env_files: Tuple[str, ...] = ()
    vnc_bind: str = "127.0.0.1"
    healthcheck: Optional[str] = None


def build_specs(
    desired: Dict[str, Any], settings: Settings, adopted: Dict[str, Dict[str, str]]
) -> Tuple[List[WorkerSpec], List[str]]:
    """The desired workers as specs, and an error for each entry that is not one.

    A malformed entry is skipped, never fatal: one bad row from the
    coordinator must not stop the host from keeping its other workers.
    """
    specs: List[WorkerSpec] = []
    errors: List[str] = []
    seen: Set[str] = set()
    for raw in desired.get("workers") or []:
        problem = _invalid(raw)
        if problem:
            errors.append(problem)
            continue
        worker_id = raw["worker_id"]
        if worker_id in seen:
            errors.append(f"{worker_id}: listed twice in the desired state; using the first")
            continue
        seen.add(worker_id)
        adoption = adopted.get(worker_id)
        specs.append(
            WorkerSpec(
                worker_id=worker_id,
                image=raw["image"],
                generation=int(raw.get("generation") or 0),
                env=tuple(sorted((str(k), str(v)) for k, v in (raw.get("env") or {}).items())),
                config_sha256=raw.get("config_sha256") or None,
                config_path=str(state.config_path(settings.root, worker_id)),
                data_dir=adoption["data_dir"] if adoption else str(state.default_data_dir(settings.root, worker_id)),
                cache_volume=adoption["cache_volume"] if adoption else state.default_cache_volume(worker_id),
                vnc_port=int(raw["vnc_port"]) if raw.get("vnc_port") is not None else None,
                network=settings.network,
                env_files=tuple(settings.env_files),
                adopted=adoption is not None,
            )
        )
    return specs, errors


def _invalid(raw: Any) -> Optional[str]:
    if not isinstance(raw, dict):
        return "a desired worker is not an object; skipped"
    worker_id = raw.get("worker_id")
    if not isinstance(worker_id, str) or not WORKER_ID.match(worker_id):
        return f"desired worker id {worker_id!r} is not a valid id; skipped"
    if not isinstance(raw.get("image"), str) or not raw["image"].strip():
        return f"{worker_id}: no image in the desired state; skipped"
    generation = raw.get("generation", 0)
    if isinstance(generation, bool) or not isinstance(generation, int):
        return f"{worker_id}: generation is not an integer; skipped"
    env = raw.get("env") or {}
    if not isinstance(env, dict) or not all(
        isinstance(k, str) and _ENV_NAME.match(k) and isinstance(v, str) for k, v in env.items()
    ):
        return f"{worker_id}: env is not a map of variable names to strings; skipped"
    port = raw.get("vnc_port")
    if port is not None and (isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535):
        return f"{worker_id}: vnc_port is not a port; skipped"
    sha = raw.get("config_sha256")
    if sha is not None and not isinstance(sha, str):
        return f"{worker_id}: config_sha256 is not a string; skipped"
    return None


def plan(
    specs: Iterable[WorkerSpec],
    containers: Dict[str, Container],
    *,
    online: bool,
    authoritative: bool,
    configs_ready: Set[str],
) -> Tuple[List[Action], List[str]]:
    """The actions that bring the host to `specs`, and why any were held back.

    `containers` maps worker id to the container that worker runs in now:
    one carrying the agent's labels, or the compose container `adopt.toml`
    names for it. `configs_ready` is the workers whose config file is on disk;
    a worker is never created without one.
    """
    actions: List[Action] = []
    errors: List[str] = []
    creating = False
    desired_ids: Set[str] = set()

    for spec in sorted(specs, key=lambda s: s.worker_id):
        desired_ids.add(spec.worker_id)
        current = containers.get(spec.worker_id)
        out_of_date = current is not None and (not current.managed or current.spec != spec.spec_hash())

        if current is not None and not out_of_date:
            if not current.running:
                actions.append(Action(START, spec.worker_id, current.name, "stopped"))
            continue
        if current is not None and not online:
            # Offline it is what we last knew about: keep it, never replace it.
            if not current.running:
                actions.append(Action(START, spec.worker_id, current.name, "stopped"))
            continue
        if spec.config_sha256 is None:
            errors.append(f"{spec.worker_id}: the coordinator has no config for it yet; not started")
            continue
        if spec.worker_id not in configs_ready:
            errors.append(f"{spec.worker_id}: its config is not on disk yet; not started")
            continue
        if creating:
            continue
        creating = True
        if current is None:
            actions.append(Action(RUN, spec.worker_id, spec.container, "missing"))
        else:
            actions.append(Action(RECREATE, spec.worker_id, current.name, _why(current, spec)))

    if online and authoritative:
        for worker_id, current in sorted(containers.items()):
            if worker_id not in desired_ids and current.managed:
                actions.append(Action(REMOVE, worker_id, current.name, "no longer desired on this host"))
    return actions, errors


def _why(current: Container, spec: WorkerSpec) -> str:
    if not current.managed:
        return f"adopt {current.name}"
    if current.image and current.image != spec.image:
        return f"image {current.image} -> {spec.image}"
    if current.generation is not None and current.generation != spec.generation:
        return f"generation {current.generation} -> {spec.generation}"
    return "container spec changed"
