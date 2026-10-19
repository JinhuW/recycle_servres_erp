"""One tick of the agent: desired state in, docker commands out, a report back.

    1. fetch the desired state (online), or read the cached copy (offline)
    2. online: bring each worker's config file up to date, in place
    3. observe the containers; plan (see plan.py); apply unless observe-only
    4. online: report what the host runs, the plan, and what went wrong

Observe-only is either side's call: the coordinator's `authoritative: false`
or RS_FLEET_OBSERVE_ONLY here. It plans and reports, and runs nothing.
"""

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Set

from . import __version__, plan, state
from .docker import Docker
from .plan import Action, Container, Settings, WorkerSpec

logger = logging.getLogger(__name__)


class Client(Protocol):
    def desired(self) -> Optional[Dict[str, Any]]: ...

    def config(self, worker_id: str) -> Optional[Dict[str, Any]]: ...

    def report(self, payload: Dict[str, Any]) -> bool: ...


@dataclass
class TickResult:
    online: bool
    observe_only: bool
    actions: List[Action] = field(default_factory=list)
    applied: List[Action] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    containers: Dict[str, Container] = field(default_factory=dict)

    def summary(self: "TickResult") -> Dict[str, Any]:
        return {
            "online": self.online,
            "observe_only": self.observe_only,
            "plan": [a.as_dict() for a in self.actions],
            "applied": [a.as_dict() for a in self.applied],
            "errors": self.errors,
        }


class Agent:
    def __init__(
        self: "Agent",
        settings: Settings,
        client: Client,
        docker: Docker,
        observe_only: bool = False,
        healthcheck_source: Optional[Path] = None,
    ) -> None:
        self.settings = settings
        self.client = client
        self.docker = docker
        self.observe_only = observe_only
        self.healthcheck_source = healthcheck_source

    def tick(self: "Agent", apply: bool = True, write: bool = True) -> TickResult:
        """One pass. `apply=False, write=False` is the read-only `plan` command."""
        root = self.settings.root
        errors: List[str] = []

        desired = self.client.desired()
        online = desired is not None
        if online and write:
            try:
                state.save_desired(root, desired)
            except OSError as e:
                errors.append(f"could not cache the desired state: {e}")
        if not online:
            desired = state.load_desired(root)
        assert desired is not None
        observe_only = self.observe_only or not desired.get("authoritative")
        result = TickResult(online=online, observe_only=observe_only, errors=errors)

        if write:
            self._install_healthcheck(errors)
        adopted = state.load_adopted(root)
        specs, spec_errors = plan.build_specs(desired, self.settings, adopted)
        errors += spec_errors
        if online and write:
            for spec in specs:
                problem = self._sync_config(spec)
                if problem:
                    errors.append(problem)
        ready: Set[str] = {s.worker_id for s in specs if Path(s.config_path).is_file()}

        containers, docker_errors = self.docker.observe(adopted)
        errors += docker_errors
        if containers is None:
            # Nothing can be planned against a daemon that will not answer.
            if write:
                self._report(result)
            return result
        result.containers = containers

        actions, plan_errors = plan.plan(
            specs,
            containers,
            online=online,
            authoritative=bool(desired.get("authoritative")),
            configs_ready=ready,
        )
        result.actions = actions
        errors += plan_errors
        if apply and not observe_only:
            by_id = {s.worker_id: s for s in specs}
            for action in actions:
                problem = self._apply(action, by_id.get(action.worker_id))
                if problem:
                    errors.append(problem)
                else:
                    result.applied.append(action)
                    logger.info("%s %s: %s", action.kind, action.worker_id, action.reason)
            if result.applied:
                # Report what runs now, not what ran before this tick.
                after, _ = self.docker.observe(adopted)
                if after is not None:
                    result.containers = after
        if write:
            self._report(result)
        return result

    # -- steps ------------------------------------------------------------------

    def _install_healthcheck(self: "Agent", errors: List[str]) -> None:
        if self.healthcheck_source is None:
            return
        try:
            self.settings.healthcheck = str(state.install_healthcheck(self.settings.root, self.healthcheck_source))
        except OSError as e:
            errors.append(f"could not install the worker healthcheck: {e}")

    def _sync_config(self: "Agent", spec: WorkerSpec) -> Optional[str]:
        """Bring the worker's config file to the coordinator's copy; why not, if not."""
        if not spec.config_sha256:
            return None
        path = Path(spec.config_path)
        if state.file_sha256(path) == spec.config_sha256:
            return None
        served = self.client.config(spec.worker_id)
        if served is None:
            return f"{spec.worker_id}: could not fetch its config"
        if state.sha256_text(served["toml"]) != served["sha256"] or served["sha256"] != spec.config_sha256:
            return f"{spec.worker_id}: the config served does not match its checksum; kept the old one"
        try:
            state.write_in_place(path, served["toml"])
        except OSError as e:
            return f"{spec.worker_id}: could not write its config: {e}"
        logger.info("config of %s updated (%s)", spec.worker_id, spec.config_sha256[:12])
        return None

    def _apply(self: "Agent", action: Action, spec: Optional[WorkerSpec]) -> Optional[str]:
        if action.kind == plan.START:
            return self.docker.start(action.container or "")
        if action.kind == plan.REMOVE:
            return self.docker.stop_and_remove(action.container or "")
        assert spec is not None
        # The image first: a pull that fails must leave the old container running.
        problem = self.docker.ensure_image(spec.image)
        if problem:
            return f"{spec.worker_id}: image {spec.image} is not available: {problem}"
        if not spec.adopted:
            try:
                os.makedirs(spec.data_dir, mode=0o700, exist_ok=True)
            except OSError as e:
                return f"{spec.worker_id}: could not create {spec.data_dir}: {e}"
        if action.kind == plan.RECREATE and action.container:
            problem = self.docker.stop_and_remove(action.container)
            if problem:
                return f"{spec.worker_id}: could not replace {action.container}: {problem}"
        problem = self.docker.run(spec, self.settings)
        return f"{spec.worker_id}: {problem}" if problem else None

    def _report(self: "Agent", result: TickResult) -> None:
        if not result.online:
            return
        payload = {
            "agent_version": __version__,
            "observe_only": result.observe_only,
            "offline": False,
            "workers": [
                {
                    "worker_id": c.worker_id,
                    "container": c.name,
                    "image": c.image,
                    "generation": c.generation if c.managed else None,
                    "managed": c.managed,
                    "running": c.running,
                    "health": c.health,
                    "started_at": c.started_at,
                }
                for _, c in sorted(result.containers.items())
            ],
            "plan": [a.as_dict() for a in result.actions],
            "errors": result.errors,
        }
        if not self.client.report(payload):
            logger.warning("the coordinator did not take this tick's report")
