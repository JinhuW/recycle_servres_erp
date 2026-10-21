"""Command line entry point: `rs-messenger`."""

import argparse
import logging
import os
import random
import sys
import time
from pathlib import Path
from typing import List

from rs_poster.cookies import read_session_meta
from rs_poster.session import (
    AccountRestrictedError,
    PosterSession,
    SessionExpiredError,
    SessionLockedError,
    _lock_holder_alive,
    account_lock,
)

from .client import CoordinatorClient, CoordinatorError
from .inbox import read_threads
from .sender import PERMANENT_ERRORS, send_message

logger = logging.getLogger("rs_messenger")


def make_session(args: argparse.Namespace) -> PosterSession:
    # The poster's session class, on purpose: same storage_state file, same
    # sidecar identity, same lock. One account, one browser at a time.
    return PosterSession(
        storage_state_path=args.storage_state,
        headless=args.headless,
        login_wait_time=args.login_wait_time,
    )


def cmd_poll(args: argparse.Namespace) -> int:
    client = CoordinatorClient()
    if not args.dry_run and not client.configured:
        print(
            "error: coordinator is not configured; set "
            + ", ".join(client.missing())
            + " (or use --dry-run to only read the inbox).",
            file=sys.stderr,
        )
        return 1

    with account_lock(args.lock_file, timeout=args.lock_timeout):
        with make_session(args) as session:
            assert session.page is not None
            threads = read_threads(session.page, depth=args.depth)

            if args.dry_run:
                # Print, touch nothing: no coordinator call, no sends. This is
                # the selector check the module docstrings point at.
                for thread in threads:
                    print(f"thread {thread.thread_id}  {thread.counterpart or '?'}")
                    if thread.listing_title:
                        print(f"  re: {thread.listing_title}")
                    for message in thread.messages[-5:]:
                        print(f"  [{message.direction}] {message.text[:80]}")
                print(f"\n{len(threads)} thread(s) read; nothing synced (dry run).")
                return 0

            result = client.sync_threads(threads)
            logger.info(
                "Synced %d thread(s): %s new message(s), %s reply(ies) queued.",
                len(threads),
                result.get("new_messages", "?"),
                result.get("queued_replies", "?"),
            )

            for item in client.fetch_outbound():
                sent, error = send_message(
                    session.page, str(item.get("thread_id")), str(item.get("text", ""))
                )
                ack = client.ack_outbound(
                    int(item["id"]),
                    "sent" if sent else "failed",
                    error,
                    permanent=error in PERMANENT_ERRORS,
                )
                logger.info(
                    "Outbound %s (%s): %s",
                    item.get("id"),
                    item.get("origin", "?"),
                    "sent" if sent else f"{ack.get('outcome', 'failed')}: {error}",
                )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    """`poll` on a jittered interval until stopped or the account is parked.

    Coordinator trouble is retried on the next tick; a checkpoint or an
    expired session stops the loop — retrying either against Facebook is how
    accounts die, and both need a human anyway.
    """
    while True:
        try:
            cmd_poll(args)
        except (AccountRestrictedError, SessionExpiredError, SessionLockedError):
            raise
        except CoordinatorError as e:
            logger.warning("Poll skipped: %s", e)
        except Exception:
            logger.exception("Poll failed; will retry next interval")
        delay = args.interval * random.uniform(0.8, 1.2)
        logger.info("Next poll in %.0fs.", delay)
        time.sleep(delay)


def cmd_status(args: argparse.Namespace) -> int:
    """Offline: what a poll would run with, without opening a browser."""
    client = CoordinatorClient()
    if client.configured:
        print(f"coordinator: {client.base_url} (worker {client.worker_id})")
    else:
        print(f"coordinator: NOT configured — missing {', '.join(client.missing())}")

    state = Path(os.path.expanduser(args.storage_state))
    if state.exists():
        meta = read_session_meta(str(state))
        captured = meta.get("captured_at") or "unknown capture time"
        print(f"session:     {state} ({captured})")
    else:
        print(f"session:     {state} MISSING — run `rs-session capture`")

    lock = Path(args.lock_file)
    if lock.exists():
        holder = _lock_holder_alive(lock)
        print(f"lock:        held by PID {holder}" if holder else "lock:        stale")
    else:
        print("lock:        free")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rs-messenger", description="Bridge the Marketplace inbox to the coordinator"
    )
    parser.add_argument(
        "--storage-state", default=os.environ.get("FB_STATE", "/data/fb_state.json")
    )
    parser.add_argument("--lock-file", default=os.environ.get("FB_LOCK", "/data/fb_account.lock"))
    parser.add_argument("--lock-timeout", type=int, default=0, help="Seconds to wait for the lock")
    parser.add_argument("--headless", action="store_true", help="Not recommended; easier to detect")
    parser.add_argument("--login-wait-time", type=int, default=120)
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    poll = sub.add_parser("poll", help="One pass: read inbox, sync, send queued replies")
    poll.add_argument("--depth", type=int, default=10, help="How many recent threads to read")
    poll.add_argument(
        "--dry-run", action="store_true", help="Print what was read; no sync, no sends"
    )
    poll.set_defaults(func=cmd_poll)

    run = sub.add_parser("run", help="Poll on a jittered interval")
    run.add_argument("--depth", type=int, default=10)
    run.add_argument("--interval", type=int, default=300, help="Base seconds between polls")
    run.set_defaults(func=cmd_run, dry_run=False)

    status = sub.add_parser("status", help="Show configuration without a browser")
    status.set_defaults(func=cmd_status)

    return parser


def main(argv: List[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        return int(args.func(args))
    except CoordinatorError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except SessionLockedError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except SessionExpiredError as e:
        # The message names the exact rs-session command to run; a traceback
        # would bury it.
        print(f"error: {e}", file=sys.stderr)
        return 3
    except AccountRestrictedError as e:
        print(f"error: {e}", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
