"""Inbox parsing rules: what is a thread, what is a message, what goes on the wire.

The browser-driving half (`read_threads`, `send_message`) is covered by
`rs-messenger poll --dry-run` against a real session, not here; these tests pin
the pure decisions that turn a messy page into a payload.
"""

from rs_messenger.inbox import (
    MAX_MESSAGES_PER_THREAD,
    MessageSnapshot,
    ThreadSnapshot,
    dedupe_ordered,
    looks_like_message,
    rows_to_messages,
    thread_id_from_href,
)


# -- thread ids --------------------------------------------------------------


def test_thread_id_from_plain_and_absolute_hrefs():
    assert thread_id_from_href("/marketplace/t/123456789/") == "123456789"
    assert (
        thread_id_from_href("https://www.facebook.com/marketplace/t/98765") == "98765"
    )


def test_thread_id_survives_query_strings_and_deep_paths():
    assert thread_id_from_href("/marketplace/t/42?ref=inbox&x=1") == "42"
    assert thread_id_from_href("/marketplace/t/42/something/else") == "42"


def test_non_thread_hrefs_are_rejected():
    assert thread_id_from_href("/marketplace/item/555/") is None
    assert thread_id_from_href("/marketplace/t/") is None
    assert thread_id_from_href("") is None
    assert thread_id_from_href(None) is None


def test_dedupe_ordered_keeps_first_occurrence():
    assert dedupe_ordered(["a", "b", "a", "c", "b"]) == ["a", "b", "c"]
    assert dedupe_ordered([]) == []


# -- message filtering -------------------------------------------------------


def test_real_messages_pass_the_filter():
    assert looks_like_message("Is the RAM still available?")
    assert looks_like_message("Yes — 8 sticks, $200 for the lot")
    # Errs toward keeping: unknown chrome should arrive, not vanish.
    assert looks_like_message("Some new Facebook widget text")


def test_chrome_and_timestamps_are_filtered():
    assert not looks_like_message("")
    assert not looks_like_message("Active now")
    assert not looks_like_message("Sent")
    assert not looks_like_message("Seen")
    assert not looks_like_message("You sent")
    assert not looks_like_message("10:42 AM")
    assert not looks_like_message("Mon 9:15 PM")
    assert not looks_like_message("Today")


def test_rows_to_messages_directions_and_cap():
    rows = [
        {"text": "Is this available?", "direction": "in"},
        {"text": "10:42 AM", "direction": "in"},  # dropped: timestamp
        {"text": "Yes, it is.", "direction": "out"},
    ]
    messages = rows_to_messages(rows, counterpart="Alex Buyer")
    assert [m.direction for m in messages] == ["in", "out"]
    # Incoming rows carry the counterpart as sender; ours carry none.
    assert messages[0].sender == "Alex Buyer"
    assert messages[1].sender is None

    many = [{"text": f"msg {i}", "direction": "in"} for i in range(60)]
    capped = rows_to_messages(many, counterpart=None)
    assert len(capped) == MAX_MESSAGES_PER_THREAD
    # The tail is kept, not the head — the newest messages matter.
    assert capped[-1].text == "msg 59"


def test_unknown_direction_defaults_to_incoming():
    # A false "in" costs a redundant alert; a false "out" suppresses one.
    (message,) = rows_to_messages([{"text": "hello there"}], counterpart=None)
    assert message.direction == "in"


# -- wire shape --------------------------------------------------------------


def test_snapshot_payload_matches_the_sync_contract():
    thread = ThreadSnapshot(
        thread_id="42",
        counterpart="Alex Buyer",
        listing_title="We Buy Used Servers",
        messages=[MessageSnapshot(direction="in", sender="Alex Buyer", text="hi")],
    )
    payload = thread.to_payload()
    assert set(payload) == {
        "thread_id",
        "counterpart",
        "listing_title",
        "last_message_at",
        "messages",
    }
    assert set(payload["messages"][0]) == {"direction", "sender", "text", "sent_at"}
    assert payload["last_message_at"] is None
    assert payload["messages"][0]["sent_at"] is None
