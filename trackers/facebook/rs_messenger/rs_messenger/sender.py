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
from typing import Any, Dict, List, Optional, Tuple

from playwright.sync_api import Page
from rs_poster.session import NAV_TIMEOUT_MS, human_pause, raise_if_restricted

from . import selectors as sel
from .inbox import looks_like_message

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


# How long to watch the pane for our own bubble after Enter, and how often.
VERIFY_TIMEOUT_S = 15.0
VERIFY_POLL_S = 0.5
# Enough of the reply to recognise our bubble; Facebook may rewrap the rest.
PROBE_CHARS = 60

ERR_COMPOSER_MISSING = "composer not found (selectors.py may need updating)"
ERR_NOT_SUBMITTED = "reply not submitted; composer cleared"
ERR_NOT_SUBMITTED_UNCLEARED = "reply not submitted; composer could not be cleared"
ERR_NOT_VISIBLE = "sent text did not appear as an outgoing bubble"
# Failures another poll will not fix; the coordinator stops retrying these.
PERMANENT_ERRORS = frozenset({ERR_COMPOSER_MISSING})


# Module state rather than a ledger file: replies are queued and acked on the
# coordinator, which is the durable record — this only paces one process.
_last_send_at = 0.0


def _norm(text: Optional[str]) -> str:
    return " ".join((text or "").split()).casefold()


def make_probe(text: str) -> str:
    """The fragment of the reply we look for in the pane afterwards."""
    return " ".join(text.split())[:PROBE_CHARS]


def count_out_rows(rows: List[Dict[str, Any]], probe: str) -> int:
    """Outgoing rows ("You sent" ancestors) whose text carries the probe.

    The composer draft and the thread list's preview never carry that marker,
    so neither can pass for a sent bubble.
    """
    needle = _norm(probe)
    if not needle:
        return 0
    return sum(
        1
        for row in rows
        if row.get("direction") == "out" and needle in _norm(row.get("text"))
    )


def already_sent(rows: List[Dict[str, Any]], probe: str) -> bool:
    """Whether the pane's most recent message is ours and carries the probe.

    This is the retry of a reply whose ack never reached the coordinator: the
    bubble is on the page, so typing it again would send the seller a
    duplicate. Only the latest message counts, so a repeat the operator
    queues on purpose after the seller answered still goes out.
    """
    needle = _norm(probe)
    if not needle:
        return False
    for row in reversed(rows):
        text = row.get("text") or ""
        if not looks_like_message(text):
            continue
        return row.get("direction") == "out" and needle in _norm(text)
    return False


def reply_landed(
    before: List[Dict[str, Any]],
    after: List[Dict[str, Any]],
    probe: str,
    composer_text: str,
) -> bool:
    """One more outgoing bubble with the probe than before, and no draft left.

    Counting against the snapshot taken before typing is what rules out an
    older identical bubble; the composer check is what rules out an Enter
    that never submitted.
    """
    return count_out_rows(after, probe) > count_out_rows(before, probe) and (
        _norm(probe) not in _norm(composer_text)
    )


def _snapshot(page: Page) -> List[Dict[str, Any]]:
    try:
        rows = page.evaluate(sel.EXTRACT_MESSAGES_JS)
    except Exception:
        return []
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _composer_text(composer: Any) -> str:
    try:
        return composer.inner_text() or ""
    except Exception:
        return ""


def _clear_composer(page: Page, composer: Any) -> bool:
    """Empty a draft that did not submit, so a retry does not type it twice."""
    try:
        composer.click()
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
    except Exception:
        return False
    return not _composer_text(composer).strip()


def send_message(
    page: Page, thread_id: str, text: str, dry_run: bool = False
) -> Tuple[bool, Optional[str]]:
    """Send `text` into the thread. Returns (sent, error).

    "Sent" means the text was typed, submitted, and then *seen in the pane as
    our own bubble*. A composer that swallowed the keystrokes without posting
    reports False, so the coordinator re-queues rather than believing a
    phantom reply.
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
        return False, ERR_COMPOSER_MISSING

    if dry_run:
        logger.info("[dry-run] Would send to thread %s: %r", thread_id, text)
        return True, None

    probe = make_probe(text)
    before = _snapshot(page)
    if already_sent(before, probe):
        logger.info("Thread %s already shows this reply; not sending it twice.", thread_id)
        return True, None

    composer.click()
    human_pause(0.5, 1.5)
    composer.type(text, delay=random.randint(60, 140))
    human_pause(0.5, 1.2)
    page.keyboard.press("Enter")
    _last_send_at = time.time()

    deadline = time.monotonic() + VERIFY_TIMEOUT_S
    while True:
        if reply_landed(before, _snapshot(page), probe, _composer_text(composer)):
            logger.info("Replied in thread %s (%d chars).", thread_id, len(text))
            return True, None
        if time.monotonic() >= deadline:
            break
        time.sleep(VERIFY_POLL_S)

    if _norm(probe) in _norm(_composer_text(composer)):
        logger.warning("Reply to thread %s stayed in the composer; clearing it.", thread_id)
        if _clear_composer(page, composer):
            return False, ERR_NOT_SUBMITTED
        return False, ERR_NOT_SUBMITTED_UNCLEARED

    logger.warning("Reply to thread %s not visible as an outgoing bubble.", thread_id)
    return False, ERR_NOT_VISIBLE
