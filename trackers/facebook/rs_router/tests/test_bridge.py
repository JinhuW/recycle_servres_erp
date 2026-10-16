"""The one seam that must be right: Matrix events → coordinator snapshots.

If the FB thread id is pulled from the wrong place, two conversations merge; if
direction is misread, our own replies get re-alerted or auto-reply talks over a
human. These are pure functions, so both are pinned here without a homeserver.
"""

from rs_router import bridge

OWN = "@rs_seller:rs.local"
GHOST = "@meta_9988:rs.local"


def bridge_state(thread_id):
    return {
        "type": "m.bridge",
        "state_key": "meta://thread",
        "content": {"protocol": {"id": "meta"}, "channel": {"id": thread_id}},
    }


def text_event(sender, body, ts=1_724_500_000_000):
    return {
        "type": "m.room.message",
        "sender": sender,
        "origin_server_ts": ts,
        "content": {"msgtype": "m.text", "body": body},
    }


# -- bridge state ------------------------------------------------------------


def test_thread_id_comes_from_the_bridge_channel_id():
    state = [bridge_state("1122334455"), {"type": "m.room.name", "content": {"name": "Jamie"}}]
    assert bridge.thread_id_from_bridge_state(state) == "1122334455"


def test_thread_id_accepts_the_legacy_bridge_event():
    state = [{"type": "uk.half-shot.bridge", "content": {"channel": {"id": "77"}}}]
    assert bridge.thread_id_from_bridge_state(state) == "77"


def test_no_bridge_state_means_not_a_portal():
    assert bridge.thread_id_from_bridge_state([{"type": "m.room.name", "content": {}}]) is None
    assert bridge.thread_id_from_bridge_state([]) is None


# -- direction ---------------------------------------------------------------


def test_direction_is_out_only_for_our_own_account():
    buyer = text_event(GHOST, "still available?")
    ours = text_event(OWN, "yes, $200")
    assert bridge.is_buyer_message(buyer, OWN) is True
    assert bridge.is_buyer_message(ours, OWN) is False
    assert bridge.message_from_event(buyer, OWN)["direction"] == "in"
    assert bridge.message_from_event(ours, OWN)["direction"] == "out"


def test_timeline_keeps_both_directions_but_drops_non_text():
    events = [
        text_event(GHOST, "hi"),
        {"type": "m.room.member", "sender": GHOST, "content": {"membership": "join"}},
        text_event(OWN, "hello back"),
        {"type": "m.room.message", "sender": GHOST, "content": {"msgtype": "m.image", "body": "x"}},
    ]
    messages = bridge.messages_from_timeline(events, OWN)
    assert [m["direction"] for m in messages] == ["in", "out"]
    assert [m["text"] for m in messages] == ["hi", "hello back"]
    assert messages[0]["sent_at"].startswith("2024-")  # ts converted to ISO


# -- whole-sync assembly -----------------------------------------------------


def test_snapshots_from_sync_reports_only_portals_with_new_messages():
    sync = {
        "rooms": {
            "join": {
                "!portal:rs.local": {
                    "timeline": {"events": [text_event(GHOST, "32 sticks of DDR4")]},
                    "state": {"events": [bridge_state("42"), {"type": "m.room.name", "content": {"name": "Jamie"}}]},
                    "summary": {},
                },
                "!empty:rs.local": {  # a portal with no new messages this sync
                    "timeline": {"events": []},
                    "state": {"events": [bridge_state("99")]},
                    "summary": {},
                },
                "!notaportal:rs.local": {  # an ordinary room, no bridge state
                    "timeline": {"events": [text_event(GHOST, "noise")]},
                    "state": {"events": []},
                    "summary": {},
                },
            }
        }
    }

    def resolve(room_id, state_events, summary):
        thread_id = bridge.thread_id_from_bridge_state(state_events)
        return (thread_id, bridge.counterpart_from_room(summary, state_events), None)

    snaps = bridge.snapshots_from_sync(sync, OWN, resolve)
    assert len(snaps) == 1
    (snap,) = snaps
    assert snap["thread_id"] == "42"
    assert snap["matrix_room_id"] == "!portal:rs.local"
    assert snap["counterpart"] == "Jamie"
    assert snap["last_message_at"] is not None
    assert [m["text"] for m in snap["messages"]] == ["32 sticks of DDR4"]


def test_listing_comes_from_the_room_topic():
    state = [bridge_state("42"), {"type": "m.room.topic", "content": {"topic": "WTB server RAM"}}]
    assert bridge.listing_from_state(state) == "WTB server RAM"
    assert bridge.listing_from_state([bridge_state("42")]) is None


def test_iso_from_ts_handles_missing():
    assert bridge.iso_from_ts(None) is None
    assert bridge.iso_from_ts(1_724_500_000_000).startswith("2024-")
