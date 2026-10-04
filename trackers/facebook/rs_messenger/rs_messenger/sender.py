"""Type a queued reply into a Marketplace conversation.

Sending is the highest-risk action this package performs — an account that
replies too fast, too often, or into a checkpoint is an account that gets
restricted. Every send is paced (a floor between sends, jittered typing),
bounded, and verified against the page before it is reported as sent.
"""

import logging
import os
import random
import time
from typing import Optional, Tuple

from playwright.sync_api import Page
from rs_poster.session import NAV_TIMEOUT_MS, human_pause, raise_if_restricted

from . import selectors as sel
from .inbox import looks_like_message  # noqa: F401 - re-exported for callers

logger = logging.getLogger(__name__)


def min_send_interval() -> float:
    """Seconds between outbound messages. 60 s default, never below 10.

    Read per call rather than at import so tests and operators can adjust it
    without re-importing; the floor exists because an env typo of "0" must not
    turn the bridge into a rapid-fire bot.
    """
    try:
        configured = float(os.environ.get("RS_MESSENGER_MIN_SEND_INTERVAL", "60"))
    except ValueError:
        configured = 60.0
    return max(10.0, configured)


def seconds_until_next_send(last_send_at: float, now: float) -> float:
    """Pure pacing math, pinned by tests: how long to wait before sending."""
    return max(0.0, last_send_at + min_send_interval() - now)


class SendError(RuntimeError):
    """The reply could not be confirmed as sent."""


# Module state rather than a ledger file: replies are queued and acked on the
# coordinator, which is the durable record — this only paces one process.
_last_send_at = 0.0


def send_message(
    page: Page, thread_id: str, text: str, dry_run: bool = False
) -> Tuple[bool, Optional[str]]:
    """Send `text` into the thread. Returns (sent, error).

    "Sent" means the text was typed, submitted, and then *seen in the pane* —
    a composer that swallowed the keystrokes without posting reports False, so
    the coordinator can re-queue rather than believing a phantom reply.
    """
    global _last_send_at

    wait = seconds_until_next_send(_last_send_at, time.time())
    if wait > 0:
        logger.info("Pacing: waiting %.0fs before the next send.", wait)
        time.sleep(wait)

    page.goto(sel.THREAD_URL.format(thread_id=thread_id), timeout=NAV_TIMEOUT_MS)
    page.wait_for_load_state("domcontentloaded")
    raise_if_restricted(page, f"replying in thread {thread_id}")
    human_pause()

    composer = page.get_by_role("textbox", name=sel.COMPOSER_RE).first
    try:
        if not composer.count():
            composer = page.locator(sel.COMPOSER_FALLBACK).first
        composer.wait_for(timeout=15_000)
    except Exception:
        return False, "composer not found (selectors.py may need updating)"

    if dry_run:
        logger.info("[dry-run] Would send to thread %s: %r", thread_id, text)
        return True, None

    composer.click()
    human_pause(0.5, 1.5)
    composer.type(text, delay=random.randint(60, 140))
    human_pause(0.5, 1.2)
    page.keyboard.press("Enter")
    _last_send_at = time.time()

    # Confirm the message actually landed in the conversation. Best-effort but
    # bounded: the first ~60 chars are enough to find our own bubble.
    probe = text.strip()[:60]
    try:
        page.get_by_text(probe, exact=False).last.wait_for(timeout=15_000)
    except Exception:
        logger.warning("Reply to thread %s not visible after send.", thread_id)
        return False, "sent text did not appear in the conversation"

    logger.info("Replied in thread %s (%d chars).", thread_id, len(text))
    return True, None
