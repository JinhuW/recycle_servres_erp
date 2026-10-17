"""Read the Marketplace inbox into plain snapshots.

Everything Playwright-shaped stays in `read_threads`; the parsing decisions —
what counts as a message, which link is a thread, how a snapshot serializes —
are standalone functions so the tests can pin them without a browser. The
browser half is covered by `rs-messenger poll --dry-run` against a real
session, same as the poster's form-filling.

The extraction is deliberately conservative and lossy-tolerant: the inbox DOM
is unstable, and the coordinator dedupes whatever arrives by fingerprint, so
re-reporting the same messages next poll is free while inventing structure the
page does not reliably carry is how bridges silently rot.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from playwright.sync_api import Page
from rs_poster.session import NAV_TIMEOUT_MS, human_pause, raise_if_restricted

from . import selectors as sel

logger = logging.getLogger(__name__)

# How many messages of a thread are reported per poll. Old history never
# changes and the coordinator already has it; the tail is what matters.
MAX_MESSAGES_PER_THREAD = 25

# Inbox chrome that shows up in dir="auto" nodes but is not a message. Matched
# case-insensitively against the whole row text.
_CHROME_TEXTS = {
    "active now",
    "sent",
    "delivered",
    "seen",
    "you sent",
    "enter",
    "·",
    "marketplace",
    "view listing",
    "see all",
}

# A bare timestamp or day separator ("10:42 AM", "Mon 9:15 PM", "Aug 14, 2026").
_TIMESTAMP_WORDS = (
    "am",
    "pm",
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
    "sun",
    "today",
    "yesterday",
)


@dataclass
class MessageSnapshot:
    """One message as read off the page. `sent_at` is usually None — Messenger
    shows relative times, and guessing an absolute stamp would be worse than
    admitting we do not know."""

    direction: str  # "in" (from the counterpart) or "out" (ours)
    sender: Optional[str] = None
    text: str = ""
    sent_at: Optional[str] = None

    def to_payload(self: "MessageSnapshot") -> Dict[str, Any]:
        return {
            "direction": self.direction,
            "sender": self.sender,
            "text": self.text,
            "sent_at": self.sent_at,
        }


@dataclass
class ThreadSnapshot:
    """One conversation, as much of it as the page reliably gives up."""

    thread_id: str
    counterpart: Optional[str] = None
    listing_title: Optional[str] = None
    last_message_at: Optional[str] = None
    messages: List[MessageSnapshot] = field(default_factory=list)

    def to_payload(self: "ThreadSnapshot") -> Dict[str, Any]:
        """Exactly the shape POST /v1/messages/sync expects — nothing extra."""
        return {
            "thread_id": self.thread_id,
            "counterpart": self.counterpart,
            "listing_title": self.listing_title,
            "last_message_at": self.last_message_at,
            "messages": [message.to_payload() for message in self.messages],
        }


# -- pure parsing helpers ----------------------------------------------------


def thread_id_from_href(href: str | None) -> Optional[str]:
    """The id out of any /marketplace/t/<id>/ link, or None.

    Handles absolute and relative hrefs, query strings, and trailing slashes —
    all of which the inbox actually produces.
    """
    if not href:
        return None
    path = urlsplit(href).path
    marker = "/marketplace/t/"
    if marker not in path:
        return None
    tail = path.split(marker, 1)[1]
    thread_id = tail.split("/", 1)[0].strip()
    return thread_id or None


def dedupe_ordered(values: List[str]) -> List[str]:
    """First occurrence wins, order preserved — inbox rows repeat their links."""
    seen = set()
    result = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def looks_like_message(text: str) -> bool:
    """Whether a dir="auto" row is plausibly a message rather than chrome.

    Errs toward keeping: a stray "Seen"-like row reaching the coordinator is
    deduped noise, while an over-eager filter silently drops real replies.
    """
    stripped = text.strip()
    if not stripped:
        return False
    if stripped.lower() in _CHROME_TEXTS:
        return False
    # A row that is only time-and-day words and digits is a timestamp.
    words = stripped.replace(",", " ").replace(":", " ").split()
    if words and all(
        word.lower().rstrip(".") in _TIMESTAMP_WORDS or word.replace("/", "").isdigit()
        for word in words
    ):
        return False
    return True


def rows_to_messages(rows: List[Dict[str, str]], counterpart: str | None) -> List[MessageSnapshot]:
    """Page-order extraction rows -> the reported tail of the conversation."""
    messages = [
        MessageSnapshot(
            direction="out" if row.get("direction") == "out" else "in",
            sender=None if row.get("direction") == "out" else counterpart,
            text=row.get("text", "").strip(),
        )
        for row in rows
        if looks_like_message(row.get("text", ""))
    ]
    return messages[-MAX_MESSAGES_PER_THREAD:]


# -- the browser half --------------------------------------------------------


def read_threads(page: Page, depth: int = 10) -> List[ThreadSnapshot]:
    """The `depth` most recent conversations, newest first as the inbox lists them."""
    page.goto(sel.INBOX_URL, timeout=NAV_TIMEOUT_MS)
    page.wait_for_load_state("domcontentloaded")
    raise_if_restricted(page, "reading the Marketplace inbox")
    human_pause()

    hrefs = []
    for link in page.locator(sel.THREAD_LINK).all():
        try:
            hrefs.append(link.get_attribute("href") or "")
        except Exception:
            continue  # the list re-rendered under us; the next poll catches up
    thread_ids = dedupe_ordered(
        [tid for tid in (thread_id_from_href(href) for href in hrefs) if tid]
    )[:depth]
    logger.info("Inbox lists %d thread(s); reading %d.", len(hrefs), len(thread_ids))

    snapshots = []
    for thread_id in thread_ids:
        try:
            snapshots.append(_read_thread(page, thread_id))
        except Exception as e:
            # One unreadable thread must not cost the rest of the poll; the
            # typed restriction errors are the exception, they mean stop now.
            from rs_poster.session import AccountRestrictedError

            if isinstance(e, AccountRestrictedError):
                raise
            logger.warning("Could not read thread %s: %s", thread_id, e)
        human_pause()
    return snapshots


def _read_thread(page: Page, thread_id: str) -> ThreadSnapshot:
    page.goto(sel.THREAD_URL.format(thread_id=thread_id), timeout=NAV_TIMEOUT_MS)
    page.wait_for_load_state("domcontentloaded")
    raise_if_restricted(page, f"reading thread {thread_id}")
    human_pause()

    counterpart = None
    listing_title = None
    try:
        listing = page.locator(sel.LISTING_LINK).first
        if listing.count():
            text = (listing.inner_text() or "").strip()
            listing_title = text.splitlines()[0][:200] if text else None
    except Exception:
        pass
    try:
        heading = page.locator(f"{sel.CONVERSATION_PANE} h1, {sel.CONVERSATION_PANE} h2").first
        if heading.count():
            counterpart = (heading.inner_text() or "").strip().splitlines()[0][:120] or None
    except Exception:
        pass

    rows = page.evaluate(sel.EXTRACT_MESSAGES_JS)
    messages = rows_to_messages(rows if isinstance(rows, list) else [], counterpart)
    logger.info(
        "Thread %s: %d row(s) -> %d message(s).", thread_id, len(rows or []), len(messages)
    )
    return ThreadSnapshot(
        thread_id=thread_id,
        counterpart=counterpart,
        listing_title=listing_title,
        messages=messages,
    )
