"""The Docker CLI, as the agent uses it.

Through the CLI and the mounted socket rather than an SDK: nothing to install,
and every command the agent runs is one an operator can paste. Each call
returns an error string instead of raising, so one failed `docker` never takes
the loop down with it.
"""

import json
import subprocess
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .plan import CONTAINER_PREFIX, Container, Settings, WorkerSpec

LABEL_MANAGED = "rs.fleet.managed"
LABEL_WORKER = "rs.fleet.worker"
LABEL_SPEC = "rs.fleet.spec"
LABEL_IMAGE = "rs.fleet.image"
LABEL_GENERATION = "rs.fleet.generation"

# The monitor saves its Facebook session on SIGTERM and supervisord gives it
# 25 s; the container gets 30.
STOP_TIMEOUT = 30
CONFIG_TARGET = "/root/.ai-marketplace-monitor/config.toml"
CACHE_TARGET = "/root/.ai-marketplace-monitor"
HEALTHCHECK_TARGET = "/usr/local/bin/rs-healthcheck"

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


def run_args(spec: WorkerSpec, settings: Settings) -> List[str]:
    """The `docker run` argv for a worker: the compose files' service, as flags."""
    args = [
        "run", "-d",
        "--name", spec.container,
        "--restart", "unless-stopped",
        "--stop-timeout", str(STOP_TIMEOUT),
        "--shm-size", "1g",
        "--add-host", "host.docker.internal:host-gateway",
        "--network", spec.network,
        "--log-driver", "json-file",
        "--log-opt", "max-size=20m",
        "--log-opt", "max-file=5",
        "--label", f"{LABEL_MANAGED}=1",
        "--label", f"{LABEL_WORKER}={spec.worker_id}",
        "--label", f"{LABEL_SPEC}={spec.spec_hash()}",
        "--label", f"{LABEL_IMAGE}={spec.image}",
        "--label", f"{LABEL_GENERATION}={spec.generation}",
    ]
    for env_file in spec.env_files:
        args += ["--env-file", env_file]
    # -e after --env-file, and -e wins: the shared secrets file carries the
    # phase-1 monitor's own RS_WORKER_ID and token, which must not leak in.
    for name, value in spec.env:
        args += ["-e", f"{name}={value}"]
    args += [
        "-v", f"{spec.config_path}:{CONFIG_TARGET}:ro",
        "-v", f"{spec.cache_volume}:{CACHE_TARGET}",
        "-v", f"{spec.data_dir}:/data",
    ]
    if settings.healthcheck:
        args += [
            "-v", f"{settings.healthcheck}:{HEALTHCHECK_TARGET}:ro",
            "--health-cmd", HEALTHCHECK_TARGET,
            "--health-interval", "5m",
            "--health-timeout", "1m",
            "--health-retries", "1",
            "--health-start-period", "10m",
        ]
    if spec.vnc_port is not None:
        args += ["-p", f"{settings.vnc_bind}:{spec.vnc_port}:5900"]
    args.append(spec.image)
    return args


class Docker:
    def __init__(self: "Docker", runner: Optional[Runner] = None, binary: str = "docker") -> None:
        self._runner = runner or subprocess.run
        self.binary = binary

    def call(self: "Docker", args: Sequence[str], timeout: float = 120) -> Tuple[bool, str]:
        """(succeeded, stdout or the error) for one docker command."""
        try:
            done = self._runner(
                [self.binary, *args], capture_output=True, text=True, timeout=timeout, check=False
            )
        except (OSError, subprocess.SubprocessError) as e:
            return False, f"docker {args[0]}: {e}"
        if done.returncode != 0:
            detail = (done.stderr or done.stdout or "").strip().splitlines()
            return False, f"docker {' '.join(args[:2])}: {detail[-1] if detail else 'exit ' + str(done.returncode)}"
        return True, done.stdout

    # -- observing ------------------------------------------------------------

    def observe(
        self: "Docker", adopted: Dict[str, Dict[str, str]]
    ) -> Tuple[Optional[Dict[str, Container]], List[str]]:
        """Every fleet worker container on the host, by worker id.

        Those carrying the agent's labels, plus the compose containers named in
        `adopt.toml` that still exist. None when the daemon cannot be asked at
        all: no plan can be trusted then.
        """
        errors: List[str] = []
        ok, out = self.call(["ps", "-a", "-q", "--no-trunc", "--filter", f"label={LABEL_MANAGED}=1"])
        if not ok:
            return None, [out]
        ids = [line.strip() for line in out.splitlines() if line.strip()]
        found: Dict[str, Container] = {}
        for record in self._inspect(ids, errors):
            container = _container(record, managed=True)
            if container is not None:
                found[container.worker_id] = container
        for worker_id, entry in sorted(adopted.items()):
            records = self._inspect([entry["container"]], [])
            if not records:
                continue
            if worker_id in found:
                errors.append(
                    f"{worker_id}: adopted container {entry['container']} still exists beside "
                    f"{found[worker_id].name}; one session in two browsers — remove the old one"
                )
                continue
            container = _container(records[0], managed=False, worker_id=worker_id)
            if container is not None:
                found[worker_id] = container
        return found, errors

    def _inspect(self: "Docker", refs: List[str], errors: List[str]) -> List[Dict[str, Any]]:
        if not refs:
            return []
        ok, out = self.call(["inspect", *refs])
        if not ok:
            errors.append(out)
            return []
        try:
            records = json.loads(out)
        except ValueError:
            errors.append("docker inspect: unreadable output")
            return []
        return [r for r in records if isinstance(r, dict)] if isinstance(records, list) else []

    # -- acting ---------------------------------------------------------------

    def ensure_image(self: "Docker", image: str) -> Optional[str]:
        """None when `image` is on the host, pulling it if need be; else why not."""
        ok, _ = self.call(["image", "inspect", image], timeout=30)
        if ok:
            return None
        ok, out = self.call(["pull", image], timeout=900)
        return None if ok else out

    def run(self: "Docker", spec: WorkerSpec, settings: Settings) -> Optional[str]:
        ok, out = self.call(run_args(spec, settings), timeout=300)
        return None if ok else out

    def start(self: "Docker", name: str) -> Optional[str]:
        ok, out = self.call(["start", name])
        return None if ok else out

    def stop_and_remove(self: "Docker", name: str) -> Optional[str]:
        """Stop with time to save the session, then remove. Volumes stay."""
        ok, out = self.call(["stop", "-t", str(STOP_TIMEOUT), name], timeout=STOP_TIMEOUT + 60)
        if not ok:
            return out
        ok, out = self.call(["rm", name])
        return None if ok else out


def _container(record: Dict[str, Any], managed: bool, worker_id: Optional[str] = None) -> Optional[Container]:
    config = record.get("Config") or {}
    labels = config.get("Labels") or {}
    status = record.get("State") or {}
    name = str(record.get("Name") or "").lstrip("/")
    if managed:
        worker_id = labels.get(LABEL_WORKER)
        if not worker_id or not name.startswith(CONTAINER_PREFIX):
            return None
    try:
        generation = int(labels[LABEL_GENERATION]) if managed and LABEL_GENERATION in labels else None
    except (TypeError, ValueError):
        generation = None
    health = (status.get("Health") or {}).get("Status") or "none"
    return Container(
        name=name,
        worker_id=str(worker_id),
        managed=managed,
        running=bool(status.get("Running")),
        image=(labels.get(LABEL_IMAGE) if managed else None) or config.get("Image"),
        spec=labels.get(LABEL_SPEC) if managed else None,
        generation=generation,
        health=str(health),
        started_at=status.get("StartedAt"),
    )
