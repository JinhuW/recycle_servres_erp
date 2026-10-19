"""rs-fleetd command line: keep this Docker host's Facebook workers as desired.

    rs-fleetd run           # the loop: one tick every RS_FLEET_INTERVAL seconds
    rs-fleetd once          # one tick, applied (unless observe-only); prints it
    rs-fleetd plan          # what a tick would do; applies and writes nothing
    rs-fleetd adopt --worker va-1 --container rs-monitor-va1 \\
        --data-dir /home/…/configs/sessions/homelab-va1 --cache-volume deploy_aimm-home-va1
                            # take over a compose container, keeping its session

Configured from the environment: RS_FLEET_URL, RS_HOST_ID, RS_HOST_TOKEN,
RS_FLEET_ROOT, RS_FLEET_ENV_FILES, RS_FLEET_NETWORK, RS_FLEET_VNC_BIND,
RS_FLEET_HEALTHCHECK, RS_FLEET_INTERVAL, RS_FLEET_OBSERVE_ONLY. See
deploy/docker-compose.fleetd.yml.
"""

import argparse
import json
import logging
import os
import signal
import sys
import threading
from pathlib import Path
from typing import Dict, List, Optional

from . import __version__, state
from .agent import Agent
from .client import FleetClient
from .docker import Docker
from .plan import WORKER_ID, Settings

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL = 30.0


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def settings_from_env() -> Settings:
    return Settings(
        root=Path(_env("RS_FLEET_ROOT")),
        network=_env("RS_FLEET_NETWORK", "rs-fleet") or "rs-fleet",
        env_files=tuple(f.strip() for f in _env("RS_FLEET_ENV_FILES").split(",") if f.strip()),
        vnc_bind=_env("RS_FLEET_VNC_BIND", "127.0.0.1") or "127.0.0.1",
    )


def missing(names: List[str]) -> List[str]:
    return [name for name in names if not _env(name)]


def build_agent() -> Agent:
    source = _env("RS_FLEET_HEALTHCHECK")
    return Agent(
        settings=settings_from_env(),
        client=FleetClient(_env("RS_FLEET_URL"), _env("RS_HOST_ID"), _env("RS_HOST_TOKEN")),
        docker=Docker(),
        observe_only=_env("RS_FLEET_OBSERVE_ONLY") in ("1", "true", "yes"),
        healthcheck_source=Path(source) if source else None,
    )


def _require(names: List[str]) -> Optional[int]:
    absent = missing(names)
    if absent:
        print(f"error: set {', '.join(absent)}", file=sys.stderr)
        return 2
    return None


def cmd_run(args: argparse.Namespace) -> int:
    failure = _require(["RS_FLEET_URL", "RS_HOST_ID", "RS_HOST_TOKEN", "RS_FLEET_ROOT"])
    if failure:
        return failure
    try:
        interval = float(_env("RS_FLEET_INTERVAL") or DEFAULT_INTERVAL)
    except ValueError:
        interval = DEFAULT_INTERVAL
    agent = build_agent()
    stop = threading.Event()
    # `docker stop` sends SIGTERM: finish the tick in hand, then leave. The
    # workers keep running either way; they never depend on this process.
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    logger.info("rs-fleetd %s on host %s, every %ss", __version__, _env("RS_HOST_ID"), interval)
    while not stop.is_set():
        try:
            result = agent.tick()
            if result.actions or result.errors or not result.online:
                logger.info("tick: %s", json.dumps(result.summary()))
        except Exception:  # noqa: BLE001 - the loop must outlive any one tick
            logger.exception("tick failed; trying again next time")
        stop.wait(interval)
    return 0


def cmd_once(args: argparse.Namespace) -> int:
    failure = _require(["RS_FLEET_URL", "RS_HOST_ID", "RS_HOST_TOKEN", "RS_FLEET_ROOT"])
    if failure:
        return failure
    print(json.dumps(build_agent().tick().summary(), indent=2))
    return 0


def cmd_plan(args: argparse.Namespace) -> int:
    failure = _require(["RS_FLEET_ROOT"])
    if failure:
        return failure
    print(json.dumps(build_agent().tick(apply=False, write=False).summary(), indent=2))
    return 0


def cmd_adopt(args: argparse.Namespace) -> int:
    failure = _require(["RS_FLEET_ROOT"])
    if failure:
        return failure
    if not WORKER_ID.match(args.worker):
        print(f"error: {args.worker!r} is not a worker id", file=sys.stderr)
        return 2
    root = Path(_env("RS_FLEET_ROOT"))
    adopted: Dict[str, Dict[str, str]] = state.load_adopted(root)
    adopted[args.worker] = {
        "container": args.container,
        "data_dir": args.data_dir,
        "cache_volume": args.cache_volume,
    }
    state.save_adopted(root, adopted)
    print(f"{args.worker}: rs-fleetd takes over {args.container}, keeping {args.data_dir} and {args.cache_volume}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rs-fleetd", description=__doc__.splitlines()[0])
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run", help="Keep this host as desired, forever").set_defaults(func=cmd_run)
    sub.add_parser("once", help="One tick, applied unless observe-only").set_defaults(func=cmd_once)
    sub.add_parser("plan", help="What a tick would do; changes nothing").set_defaults(func=cmd_plan)
    adopt = sub.add_parser("adopt", help="Take over a compose container, keeping its session")
    adopt.add_argument("--worker", required=True, help="The worker id the container heartbeats as")
    adopt.add_argument("--container", required=True, help="The compose container's name")
    adopt.add_argument("--data-dir", required=True, help="Host path of its session directory (/data)")
    adopt.add_argument("--cache-volume", required=True, help="Its cache volume (docker volume ls)")
    adopt.set_defaults(func=cmd_adopt)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(
        level=os.environ.get("RS_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
