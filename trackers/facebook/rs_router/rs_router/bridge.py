"""Pure translation between Matrix events and coordinator thread snapshots.

Everything here is a function of its arguments — no network, no clock — so the
seam that actually matters (do we pull the right FB thread id out of a portal,
do we classify buyer vs. our-own messages correctly, do we build exactly the
payload /v1/messages/sync expects) is unit-tested without a homeserver.

The live loop in cli.py supplies the sync response; this module decides what,
if anything, to report.
"""

from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

# The state events a mautrix bridge writes into each portal room to record which
# remote conversation it is. `m.bridge` is the stable one; the older
# `uk.half-shot.bridge` is accepted as a fallback for bridges that still emit it.
BRIDGE_STATE_TYPES = ("m.bridge", "uk.half-shot.bridge")


def iso_from_ts(ms: Optional[int]) -> Optional[str]:
    """A Matrix origin_server_ts (ms since epoch) as the coordinator's ISO form."""
    if not isinstance(ms, (int, float)):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="seconds")


def thread_id_from_bridge_state(state_events: List[Dict[str, Any]]) -> Optional[str]:
    """The FB Marketplace thread id a portal room maps to, from its bridge state.

    mautrix records the remote conversation under `content.channel.id`. Returns
    None for a room that carries no bridge state (an ordinary room, or a portal
    the bridge has not finished provisioning).
    """
    for event in state_events:
        if event.get("type") not in BRIDGE_STATE_TYPES:
            continue
        channel = (event.get("content") or {}).get("channel") or {}
        channel_id = channel.get("id")
        if channel_id:
            return str(channel_id)
    return None


def is_buyer_message(event: Dict[str, Any], own_user_id: str) -> bool:
    """True when `event` is a text message from the buyer, not one of ours.

    Our own account is double-puppeted, so replies we (or staff via the router)
    send come back through sync as `sender == own_user_id`; those are 'out' and
    must not be re-alerted. Everything else with a text body is the buyer.
    """
    if event.get("type") != "m.room.message":
        return False
    content = event.get("content") or {}
    if content.get("msgtype") not in ("m.text", "m.notice"):
        return False
    if not content.get("body"):
        return False
    return event.get("sender") != own_user_id


def message_from_event(event: Dict[str, Any], own_user_id: str) -> Dict[str, Any]:
    """One timeline event as a /v1/messages/sync message dict."""
    content = event.get("content") or {}
    direction = "out" if event.get("sender") == own_user_id else "in"
    return {
        "direction": direction,
        "sender": event.get("sender"),
        "text": content.get("body"),
        "sent_at": iso_from_ts(event.get("origin_server_ts")),
    }


def messages_from_timeline(
    events: List[Dict[str, Any]], own_user_id: str
) -> List[Dict[str, Any]]:
    """Every text message in a room's timeline, in order, both directions.

    Both directions are reported: the coordinator dedupes by fingerprint and
    only alerts inbound, and seeing our own 'out' messages is what keeps
    auto-reply out of a conversation a human already answered.
    """
    out = []
    for event in events:
        content = event.get("content") or {}
        if event.get("type") != "m.room.message":
            continue
        if content.get("msgtype") not in ("m.text", "m.notice"):
            continue
        if not content.get("body"):
            continue
        out.append(message_from_event(event, own_user_id))
    return out


def build_snapshot(
    thread_id: str,
    matrix_room_id: str,
    counterpart: Optional[str],
    listing_title: Optional[str],
    messages: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """A thread payload in exactly the shape POST /v1/messages/sync expects.

    Carries `matrix_room_id` so the coordinator can tie the conversation to its
    portal, and `last_message_at` derived from the newest message so the war
    room orders conversations sensibly.
    """
    last_at = None
    for message in messages:
        if message.get("sent_at"):
            last_at = message["sent_at"]
    return {
        "thread_id": thread_id,
        "counterpart": counterpart,
        "listing_title": listing_title,
        "last_message_at": last_at,
        "matrix_room_id": matrix_room_id,
        "messages": messages,
    }


# A resolver maps (room_id, state_events, summary) -> (thread_id, counterpart,
# listing_title). It is injected so snapshots_from_sync stays pure and testable:
# the live version (cli.py) reaches the homeserver for a portal's full state,
# the test version returns canned metadata.
MetaResolver = Callable[
    [str, List[Dict[str, Any]], Dict[str, Any]],
    Tuple[Optional[str], Optional[str], Optional[str]],
]


def snapshots_from_sync(
    sync: Dict[str, Any], own_user_id: str, resolve_meta: "MetaResolver"
) -> List[Dict[str, Any]]:
    """Every joined portal with new messages, as /v1/messages/sync snapshots.

    Rooms that resolve to no FB thread (not portals, or not yet provisioned) and
    rooms with no new text messages are skipped, so an idle sync reports
    nothing.
    """
    join = ((sync.get("rooms") or {}).get("join")) or {}
    snapshots: List[Dict[str, Any]] = []
    for room_id, room in join.items():
        timeline = ((room.get("timeline") or {}).get("events")) or []
        state_events = ((room.get("state") or {}).get("events")) or []
        summary = room.get("summary") or {}
        thread_id, counterpart, listing_title = resolve_meta(room_id, state_events, summary)
        if not thread_id:
            continue
        messages = messages_from_timeline(timeline, own_user_id)
        if not messages:
            continue
        snapshots.append(
            build_snapshot(thread_id, room_id, counterpart, listing_title, messages)
        )
    return snapshots


def listing_from_state(state_events: List[Dict[str, Any]]) -> Optional[str]:
    """The listing a portal is about: mautrix puts it in the room topic."""
    for event in state_events:
        if event.get("type") == "m.room.topic":
            topic = (event.get("content") or {}).get("topic")
            if topic:
                return str(topic)
    return None


def counterpart_from_room(room_summary: Dict[str, Any], state_events: List[Dict[str, Any]]) -> Optional[str]:
    """A human name for the buyer: the room name mautrix set, if any.

    mautrix names a portal after the remote conversation (the buyer's name), so
    the room's `m.room.name` state is the counterpart. Falls back to the sync
    summary's heroes when the portal has no explicit name yet.
    """
    for event in state_events:
        if event.get("type") == "m.room.name":
            name = (event.get("content") or {}).get("name")
            if name:
                return str(name)
    heroes = room_summary.get("m.heroes") if room_summary else None
    if heroes:
        return str(heroes[0])
    return None
