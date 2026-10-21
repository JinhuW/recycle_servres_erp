"""One alert per listing, fleet-wide.

Every worker sends its own listing alerts to Telegram and remembers what it
sent in its own cache. That was enough for one worker. With ten whose cities
overlap (some search the same city, and neighbouring cities return the same
listings), each worker that saw a listing alerted it: from 10-12 to 10-20,
50 of 122 alerts repeated a listing already sent.

So before sending, a worker claims the listing here, and only a granted claim
sends. The rules:

  * The first claim on a listing wins.
  * The winner holds the claim until it reports the alert delivered. Until
    then it may claim again (a failed send, retried next sweep). Anyone else
    is told `pending`, unless the holder has been silent for `CLAIM_LEASE`,
    in which case the claim passes to whoever asks next, so a worker that
    died mid-send cannot swallow the alert.
  * A delivered listing is a `duplicate` to every later claim, with one
    exception: a price below the one it was alerted at, which alerts once
    more. An edit that leaves the price alone does not; the workers' own
    "listing changed" check also fires when a second search finds the same
    listing, which is what alerted one listing eight times on 10-19.

A worker that gets no answer sends anyway. Losing a lead costs more than a
duplicate during a coordinator outage.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from .dedupe import parse_price

# Long enough for a send and its retries; short enough that an alert whose
# sender died is not held for a whole sweep (45-75 min).
CLAIM_LEASE = timedelta(minutes=15)

NEW = "new"
DISCOUNTED = "discounted"
PENDING = "pending"
DUPLICATE = "duplicate"


def _stamp(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def claim(
    db: Any,
    marketplace: str,
    listing_id: str,
    worker_id: str,
    price: str | None,
    now: datetime | None = None,
) -> Dict[str, Any]:
    """Whether `worker_id` may alert this listing now, and why."""
    now = now or datetime.now(timezone.utc)
    params = {
        "marketplace": marketplace,
        "listing_id": listing_id,
        "worker_id": worker_id,
        "price": price,
        "price_value": parse_price(price),
        "claimed_at": _stamp(now),
        "stale_before": _stamp(now - CLAIM_LEASE),
    }
    if db.write_alert_claim("insert", params) or db.write_alert_claim("retake", params):
        return {"send": True, "verdict": NEW}
    if params["price_value"] is not None and db.write_alert_claim("drop", params):
        return {"send": True, "verdict": DISCOUNTED}

    held = db.get_alert_claim(marketplace, listing_id)
    if held["delivered_at"] is None:
        return {"send": False, "verdict": PENDING, "worker_id": held["worker_id"]}
    if params["price_value"] is not None:
        db.write_alert_claim("baseline", params)
    return {
        "send": False,
        "verdict": DUPLICATE,
        "worker_id": held["worker_id"],
        "delivered_at": held["delivered_at"],
    }


def delivered(
    db: Any,
    marketplace: str,
    listing_id: str,
    worker_id: str,
    now: datetime | None = None,
) -> bool:
    """Close `worker_id`'s claim: the alert is in the chat. False if not its claim."""
    return db.write_alert_claim(
        "delivered",
        {
            "marketplace": marketplace,
            "listing_id": listing_id,
            "worker_id": worker_id,
            "delivered_at": _stamp(now or datetime.now(timezone.utc)),
        },
    )
