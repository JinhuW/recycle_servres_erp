"""The mautrix-meta router seam: forum topics, transport routing, staff replies.

Three properties, each mirroring something the listings/outbox channels already
guarantee:

* a per-buyer Messenger alert opens (once) and routes into that buyer's forum
  topic, and a topic Telegram refuses to open still delivers — to General —
  rather than wedging the outbox;
* the reply queue is partitioned by `transport`, so the Playwright scraper and
  the Matrix router never both send one reply;
* a staff message typed into a topic becomes exactly one queued 'matrix' reply
  and claims the thread, the same way an operator console reply does — and
  everything that is not such a message is ignored.
"""

from rs_coordinator.background import Background
from rs_coordinator.db import Database
from rs_coordinator.telegram_consumer import handle_update

WARROOM_CHAT = "-1002000000001"


class RecordingNotifier:
    """A notifier that records (text, topic) and looks 'configured' to ensure_topic."""

    def __init__(self, configured=True):
        self.token = "bot-token" if configured else None
        self.chat_id = WARROOM_CHAT if configured else None
        self.sent = []

    def send(self, text, message_thread_id=None):
        self.sent.append((text, message_thread_id))
        return True


def make_pump(db, warroom):
    return Background(lambda: db, RecordingNotifier(), RecordingNotifier(), warroom)


def seed_thread(db, thread_id="t1", **fields):
    base = {"counterpart": "Jamie Seller", "listing_title": "WTB RAM", "last_message_at": None}
    base.update(fields)
    db.upsert_thread(thread_id, base)


# -- forum-topic routing -----------------------------------------------------


def test_a_message_alert_opens_a_topic_once_and_routes_into_it(tmp_path, monkeypatch):
    db = Database(tmp_path / "router.db")
    seed_thread(db)
    db.enqueue_alert("message_in", "hello", dedupe_key="t1")

    created = []

    def fake_create(token, chat_id, name):
        created.append((chat_id, name))
        return 555

    monkeypatch.setattr("rs_coordinator.telegram_topics.create_forum_topic", fake_create)
    warroom = RecordingNotifier()
    pump = make_pump(db, warroom)

    pump.drain_outbox(db)

    assert warroom.sent == [("hello", 555)]
    assert db.get_thread("t1")["telegram_topic_id"] == 555
    assert created == [(WARROOM_CHAT, "Jamie Seller · WTB RAM")]
    assert db.outbox_backlog() == 0

    # A second message reuses the stored topic — no second createForumTopic.
    db.enqueue_alert("message_in", "again", dedupe_key="t1")
    monkeypatch.setattr(
        "rs_coordinator.telegram_topics.create_forum_topic",
        lambda *a: (_ for _ in ()).throw(AssertionError("must not create a topic twice")),
    )
    pump.drain_outbox(db)
    assert warroom.sent[-1] == ("again", 555)


def test_a_topic_that_cannot_be_opened_still_delivers_to_general(tmp_path, monkeypatch):
    db = Database(tmp_path / "router.db")
    seed_thread(db)
    db.enqueue_alert("message_in", "hello", dedupe_key="t1")

    monkeypatch.setattr(
        "rs_coordinator.telegram_topics.create_forum_topic", lambda *a: None
    )
    warroom = RecordingNotifier()
    make_pump(db, warroom).drain_outbox(db)

    # Delivered to General (no topic) and not wedged; the id stays unset so the
    # next message retries the creation.
    assert warroom.sent == [("hello", None)]
    assert db.get_thread("t1")["telegram_topic_id"] is None
    assert db.outbox_backlog() == 0


def test_a_message_alert_for_an_unknown_thread_delivers_to_general(tmp_path, monkeypatch):
    db = Database(tmp_path / "router.db")
    db.enqueue_alert("message_in", "orphan", dedupe_key="ghost")
    monkeypatch.setattr(
        "rs_coordinator.telegram_topics.create_forum_topic",
        lambda *a: (_ for _ in ()).throw(AssertionError("no thread, no topic")),
    )
    warroom = RecordingNotifier()
    make_pump(db, warroom).drain_outbox(db)
    assert warroom.sent == [("orphan", None)]


def test_without_a_war_room_buyer_alerts_stay_in_general(tmp_path, monkeypatch):
    """The feature ships dark: no TELEGRAM_WARROOM_CHAT_ID (warroom notifier is
    None) means the pre-router path — buyer alerts go to the listings notifier's
    General, and no forum topic is ever opened."""
    db = Database(tmp_path / "router.db")
    seed_thread(db)
    db.enqueue_alert("message_in", "hello", dedupe_key="t1")
    monkeypatch.setattr(
        "rs_coordinator.telegram_topics.create_forum_topic",
        lambda *a: (_ for _ in ()).throw(AssertionError("no war room, no topic")),
    )
    listings = RecordingNotifier()
    # warroom_notifier is None, as in every deploy that has not set the war room.
    Background(lambda: db, listings, RecordingNotifier(), None).drain_outbox(db)

    assert listings.sent == [("hello", None)]
    assert db.get_thread("t1")["telegram_topic_id"] is None
    assert db.outbox_backlog() == 0


def test_listing_and_ops_alerts_still_bypass_the_war_room(tmp_path):
    db = Database(tmp_path / "router.db")
    db.enqueue_alert("listing_new", "a find")
    db.enqueue_alert("ops_liveness", "worker down")
    listings, ops, warroom = RecordingNotifier(), RecordingNotifier(), RecordingNotifier()

    Background(lambda: db, listings, ops, warroom).drain_outbox(db)

    assert listings.sent == [("a find", None)]
    assert ops.sent == [("worker down", None)]
    assert warroom.sent == []


# -- transport partition -----------------------------------------------------


def test_transport_partitions_the_reply_queue(tmp_path):
    db = Database(tmp_path / "router.db")
    seed_thread(db)
    db.enqueue_outbound("t1", None, "via matrix", "operator", transport="matrix")
    db.enqueue_outbound("t1", "denver-1", "via playwright", "operator", transport="playwright")

    matrix = db.pending_outbound(transport="matrix")
    playwright = db.pending_outbound(transport="playwright")

    assert [r["text"] for r in matrix] == ["via matrix"]
    assert [r["text"] for r in playwright] == ["via playwright"]
    # The legacy default is playwright, so an un-tagged enqueue is never a
    # matrix reply the scraper would try to type.
    default_id = db.enqueue_outbound("t1", "denver-1", "legacy", "autoreply")
    assert db.get_outbound(default_id)["transport"] == "playwright"


# -- staff replies from Telegram ---------------------------------------------


def topic_message(update_id, topic_id, text, chat_id=WARROOM_CHAT, is_bot=False):
    return {
        "update_id": update_id,
        "message": {
            "chat": {"id": int(chat_id)},
            "from": {"is_bot": is_bot},
            "message_thread_id": topic_id,
            "is_topic_message": True,
            "text": text,
        },
    }


def test_a_staff_reply_in_a_topic_queues_a_matrix_reply_and_claims(tmp_path):
    db = Database(tmp_path / "router.db")
    seed_thread(db)
    db.set_thread_fields("t1", {"telegram_topic_id": 42})

    outbound_id = handle_update(
        db, WARROOM_CHAT, None, topic_message(10, 42, "still available?")
    )

    assert outbound_id is not None
    (reply,) = db.pending_outbound(transport="matrix")
    assert reply["text"] == "still available?"
    assert reply["origin"] == "operator"
    assert reply["worker_id"] is None  # any router claims it
    assert db.get_thread("t1")["human_claimed"] == 1


def test_the_consumer_ignores_what_is_not_a_buyer_reply(tmp_path):
    db = Database(tmp_path / "router.db")
    seed_thread(db)
    db.set_thread_fields("t1", {"telegram_topic_id": 42})

    ignored = [
        topic_message(1, 42, "beep", is_bot=True),          # the bot's own post
        topic_message(2, 42, "   "),                        # empty text
        topic_message(3, 99, "wrong topic"),                # unknown topic
        topic_message(4, 42, "elsewhere", chat_id="-1009"),  # other chat
        {"update_id": 5, "message": {"chat": {"id": int(WARROOM_CHAT)},
                                     "from": {"is_bot": False}, "text": "no topic"}},
    ]
    for update in ignored:
        assert handle_update(db, WARROOM_CHAT, None, update) is None

    assert db.pending_outbound(transport="matrix") == []
    assert db.get_thread("t1")["human_claimed"] == 0


def test_without_a_war_room_the_message_branch_stays_inert(tmp_path):
    """Reactions turning the consumer on must not activate staff replies: with
    no war room configured, a perfectly-formed topic message is ignored."""
    db = Database(tmp_path / "router.db")
    seed_thread(db)
    db.set_thread_fields("t1", {"telegram_topic_id": 42})

    assert handle_update(db, None, "-1004", topic_message(10, 42, "hello?")) is None

    assert db.pending_outbound(transport="matrix") == []
    assert db.get_thread("t1")["human_claimed"] == 0


# -- new DAO surface ---------------------------------------------------------


def test_thread_reverse_lookups(tmp_path):
    db = Database(tmp_path / "router.db")
    db.upsert_thread("t1", {"matrix_room_id": "!room:rs.local"})
    db.set_thread_fields("t1", {"telegram_topic_id": 7})

    assert db.get_thread_by_room("!room:rs.local")["thread_id"] == "t1"
    assert db.get_thread_by_topic(7)["thread_id"] == "t1"
    assert db.get_thread_by_room("!missing:rs.local") is None
    assert db.get_thread_by_topic(999) is None


def test_telegram_offset_round_trips_and_defaults_to_zero(tmp_path):
    db = Database(tmp_path / "router.db")
    assert db.get_telegram_offset() == 0
    db.set_telegram_offset(120)
    assert db.get_telegram_offset() == 120
    db.set_telegram_offset(121)
    assert db.get_telegram_offset() == 121
