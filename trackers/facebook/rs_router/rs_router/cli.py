"""rs-router command line: bridge mautrix-meta portals to the coordinator.

    rs-router status              # config, homeserver identity, room map size
    rs-router poll --dry-run      # one sync; print what it would report, send nothing
    rs-router poll                # one sync: report new messages, deliver queued replies
    rs-router run --interval 2    # the same, on a loop (sync long-polls, so this is gentle)

The loop has two duties per tick, both idempotent: report every portal's new
messages to the coordinator (which dedupes by fingerprint and opens a Telegram
topic), and deliver the replies staff queued back into the right portal room,
where mautrix-meta sends them on over Messenger. All durable state — the sync
cursor — lives in a small JSON file, so a restart resumes rather than replays.
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import bridge
from .client import CoordinatorClient, CoordinatorError
from .matrix import MatrixClient, MatrixError

logger = logging.getLogger(__name__)

DEFAULT_STATE_PATH = "/data/router_sync.json"
DEFAULT_INTERVAL = 2.0


class Router:
    """Holds the two clients and the room map, and runs one tick at a time."""

    def __init__(
        self: "Router",
        matrix: MatrixClient,
        coordinator: CoordinatorClient,
        state_path: str = DEFAULT_STATE_PATH,
    ) -> None:
        self.matrix = matrix
        self.coordinator = coordinator
        self.state_path = state_path
        self._own_user_id: Optional[str] = None
        self._thread_to_room: Dict[str, str] = {}
        self._state_cache: Dict[str, List[Dict[str, Any]]] = {}

    # -- identity and cursor ----------------------------------------------

    @property
    def own_user_id(self: "Router") -> str:
        if self._own_user_id is None:
            self._own_user_id = self.matrix.whoami()
        return self._own_user_id

    def _load_since(self: "Router") -> Optional[str]:
        try:
            data = json.loads(Path(self.state_path).read_text())
            return data.get("since")
        except (OSError, ValueError):
            return None

    def _save_since(self: "Router", since: Optional[str]) -> None:
        if not since:
            return
        try:
            Path(self.state_path).parent.mkdir(parents=True, exist_ok=True)
            Path(self.state_path).write_text(json.dumps({"since": since}))
        except OSError as e:
            logger.warning("Could not persist sync cursor: %s", e)

    # -- portal metadata ---------------------------------------------------

    def _merged_state(
        self: "Router", room_id: str, incremental: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """A room's state, fetching full state once if the bridge event is unseen."""
        cached = self._state_cache.get(room_id, [])
        combined = cached + incremental
        if not any(e.get("type") in bridge.BRIDGE_STATE_TYPES for e in combined):
            try:
                cached = self.matrix.room_state(room_id)
            except MatrixError as e:
                logger.warning("Could not read state of %s: %s", room_id, e)
                cached = cached or []
        merged = list(cached) + list(incremental)
        self._state_cache[room_id] = merged
        return merged

    def _resolve_meta(
        self: "Router",
        room_id: str,
        state_events: List[Dict[str, Any]],
        summary: Dict[str, Any],
    ) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        merged = self._merged_state(room_id, state_events)
        thread_id = bridge.thread_id_from_bridge_state(merged)
        if not thread_id:
            return (None, None, None)
        # Remember the reverse mapping so a queued reply finds its room.
        self._thread_to_room[thread_id] = room_id
        counterpart = bridge.counterpart_from_room(summary, merged)
        listing_title = bridge.listing_from_state(merged)
        return (thread_id, counterpart, listing_title)

    def refresh_room_map(self: "Router") -> None:
        """Populate thread→room for every joined portal, before serving replies.

        Run at startup: a reply may target a conversation this process has not
        seen a new message for yet (it was reported before a restart), and
        without its room the reply would have nowhere to go.
        """
        initial = self.matrix.sync(since=None, timeout_ms=0)
        join = ((initial.get("rooms") or {}).get("join")) or {}
        for room_id, room in join.items():
            state_events = ((room.get("state") or {}).get("events")) or []
            summary = room.get("summary") or {}
            self._resolve_meta(room_id, state_events, summary)
        logger.info("Resolved %d portal room(s)", len(self._thread_to_room))

    # -- one tick ----------------------------------------------------------

    def collect_snapshots(self: "Router", sync: Dict[str, Any]) -> List[Dict[str, Any]]:
        return bridge.snapshots_from_sync(sync, self.own_user_id, self._resolve_meta)

    def poll_once(self: "Router") -> Dict[str, int]:
        since = self._load_since()
        sync = self.matrix.sync(since=since)
        snapshots = self.collect_snapshots(sync)
        if snapshots:
            self.coordinator.sync_threads(snapshots)
        # Advance the cursor only after a successful report, so a failed sync
        # push is retried against the same events next tick.
        self._save_since(sync.get("next_batch"))
        delivered = self.drain_outbound()
        return {"threads": len(snapshots), "delivered": delivered}

    def drain_outbound(self: "Router") -> int:
        delivered = 0
        for row in self.coordinator.fetch_outbound():
            thread_id = row.get("thread_id")
            room_id = self._thread_to_room.get(thread_id)
            if not room_id:
                # The room is not mapped yet; leave the reply queued (do not
                # ack) so a later tick delivers it once the portal is resolved.
                logger.info("No room yet for thread %s; leaving reply queued", thread_id)
                continue
            try:
                self.matrix.send_text(room_id, row["text"])
            except MatrixError as e:
                self.coordinator.ack_outbound(row["id"], "failed", str(e))
                logger.warning("Reply %s to %s failed: %s", row["id"], thread_id, e)
                continue
            self.coordinator.ack_outbound(row["id"], "sent")
            delivered += 1
        return delivered

    # -- dry run -----------------------------------------------------------

    def dry_run(self: "Router") -> None:
        """One sync, printing what would be reported. Sends and acks nothing."""
        since = self._load_since()
        sync = self.matrix.sync(since=since)
        snapshots = self.collect_snapshots(sync)
        print(f"whoami: {self.own_user_id}")
        print(f"portals resolved: {len(self._thread_to_room)}")
        if not snapshots:
            print("no new buyer messages this sync")
            return
        for snap in snapshots:
            inbound = [m for m in snap["messages"] if m["direction"] == "in"]
            print(
                f"  thread {snap['thread_id']}  room {snap['matrix_room_id']}  "
                f"from {snap['counterpart'] or '?'}  "
                f"({len(inbound)} inbound / {len(snap['messages'])} total)"
            )
            for m in snap["messages"][-3:]:
                arrow = "<-" if m["direction"] == "in" else "->"
                print(f"      {arrow} {m['text']}")


def run_loop(router: Router, interval: float) -> int:
    router.refresh_room_map()
    logger.info("rs-router up; polling every %.1fs (plus sync long-poll)", interval)
    while True:
        try:
            result = router.poll_once()
            if result["threads"] or result["delivered"]:
                logger.info(
                    "reported %d thread(s), delivered %d repl(y/ies)",
                    result["threads"], result["delivered"],
                )
        except (MatrixError, CoordinatorError) as e:
            logger.warning("tick failed, will retry: %s", e)
        except Exception:  # noqa: BLE001 - the loop must outlive any one failure
            logger.exception("unexpected tick failure; will retry")
        time.sleep(interval)


# -- wiring ------------------------------------------------------------------


def build_clients() -> Tuple[MatrixClient, CoordinatorClient]:
    matrix = MatrixClient(
        homeserver=os.environ.get("MATRIX_HOMESERVER_URL", ""),
        access_token=os.environ.get("MATRIX_ROUTER_TOKEN", ""),
    )
    coordinator = CoordinatorClient()
    return matrix, coordinator


def cmd_status(_args: argparse.Namespace) -> int:
    matrix, coordinator = build_clients()
    print(f"homeserver:  {matrix.homeserver or '(unset MATRIX_HOMESERVER_URL)'}")
    print(f"matrix token: {'set' if matrix.access_token else '(unset MATRIX_ROUTER_TOKEN)'}")
    print(f"coordinator: {coordinator.base_url or '(unset RS_COORDINATOR_URL)'}")
    if coordinator.missing():
        print("coordinator missing: " + ", ".join(coordinator.missing()))
    if not matrix.configured:
        return 1
    try:
        print(f"whoami:      {matrix.whoami()}")
    except MatrixError as e:
        print(f"whoami failed: {e}", file=sys.stderr)
        return 1
    return 0


def cmd_poll(args: argparse.Namespace) -> int:
    matrix, coordinator = build_clients()
    router = Router(matrix, coordinator, state_path=os.environ.get("RS_ROUTER_STATE", DEFAULT_STATE_PATH))
    try:
        if args.dry_run:
            router.dry_run()
        else:
            router.refresh_room_map()
            result = router.poll_once()
            print(f"reported {result['threads']} thread(s), delivered {result['delivered']} reply(ies)")
    except (MatrixError, CoordinatorError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    matrix, coordinator = build_clients()
    router = Router(matrix, coordinator, state_path=os.environ.get("RS_ROUTER_STATE", DEFAULT_STATE_PATH))
    return run_loop(router, args.interval)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rs-router", description="mautrix-meta ↔ coordinator bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    p_status = sub.add_parser("status", help="Print config and homeserver identity")
    p_status.set_defaults(func=cmd_status)

    p_poll = sub.add_parser("poll", help="One sync: report new messages, deliver replies")
    p_poll.add_argument("--dry-run", action="store_true", help="Print what would be reported; send nothing")
    p_poll.set_defaults(func=cmd_poll)

    p_run = sub.add_parser("run", help="Poll on a loop until stopped")
    p_run.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("RS_ROUTER_INTERVAL", DEFAULT_INTERVAL)),
        help="Seconds to sleep between syncs (the sync itself long-polls)",
    )
    p_run.set_defaults(func=cmd_run)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    logging.basicConfig(
        level=os.environ.get("RS_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
