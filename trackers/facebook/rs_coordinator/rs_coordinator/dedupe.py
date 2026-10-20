"""Cross-worker deduplication.

Two workers whose regions touch will both see a listing posted near the border,
and a single worker re-scans the same listing every cycle. The Facebook item id
is globally unique and stable, so it is the dedupe key; the listing hash and
price detect edits and price drops that are worth a second alert.
"""

import hashlib
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional


class Verdict(Enum):
    NEW = "new"
    CHANGED = "changed"
    DISCOUNTED = "discounted"
    DUPLICATE = "duplicate"

    @property
    def should_notify(self: "Verdict") -> bool:
        return self is not Verdict.DUPLICATE


@dataclass
class DedupeResult:
    verdict: Verdict
    dedupe_key: str
    previous_price: str | None = None


def message_fingerprint(
    thread_id: str,
    direction: str,
    sender: str | None,
    text: str | None,
    sent_at: str | None,
) -> str:
    """Identity of one Messenger message, for idempotent re-reporting.

    Scraped timestamps are unreliable ("5m ago"), so the fingerprint leans on
    content. The known cost: the same party sending the identical text twice
    with an identical (or absent) timestamp collapses into one message. That
    loses a duplicate "hello?", never a distinct offer, and errs toward fewer
    alerts — the survivable direction.
    """
    raw = "\x1f".join(
        (thread_id, direction, sender or "", text or "", sent_at or "")
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()  # noqa: S324 - identity, not security


def dedupe_key(marketplace: str, listing_id: str) -> str:
    return hashlib.sha1(f"{marketplace}:{listing_id}".encode()).hexdigest()


_PRICE = re.compile(r"\d[\d,]*(?:\.\d+)?")


def parse_price(price: str | None) -> Optional[float]:
    """The first number in a price string like '$1,200' or '1200 USD'.

    The first, not all of them: a discounted listing's price reads
    '$20 | $25' (now, then), and joining every digit made that 2025.
    """
    if not price:
        return None
    match = _PRICE.search(price)
    return float(match.group().replace(",", "")) if match else None


def classify(incoming: Dict[str, Any], existing: Optional[Dict[str, Any]]) -> Verdict:
    if existing is None:
        return Verdict.NEW

    old_price = parse_price(existing.get("price"))
    new_price = parse_price(incoming.get("price"))
    if old_price is not None and new_price is not None and new_price < old_price:
        return Verdict.DISCOUNTED

    incoming_hash = incoming.get("listing_hash")
    if incoming_hash and existing.get("listing_hash") and incoming_hash != existing["listing_hash"]:
        return Verdict.CHANGED

    return Verdict.DUPLICATE
