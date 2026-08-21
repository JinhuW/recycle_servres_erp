"""Cross-worker deduplication.

Two workers whose regions touch will both see a listing posted near the border,
and a single worker re-scans the same listing every cycle. The Facebook item id
is globally unique and stable, so it is the dedupe key; the listing hash and
price detect edits and price drops that are worth a second alert.
"""

import hashlib
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


def dedupe_key(marketplace: str, listing_id: str) -> str:
    return hashlib.sha1(f"{marketplace}:{listing_id}".encode()).hexdigest()


def parse_price(price: str | None) -> Optional[float]:
    """Pull a number out of a price string like '$1,200' or '1200 USD'."""
    if not price:
        return None
    digits = "".join(ch for ch in price if ch.isdigit() or ch == ".")
    # A stray trailing dot or several dots ('1.200.00') is not worth guessing at.
    try:
        return float(digits)
    except ValueError:
        return None


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
