"""Forum-topic management for the Messenger router.

Every buyer conversation gets its own Telegram forum topic in the war-room
supergroup, so staff can follow one seller without the others' messages
interleaving. A topic cannot be addressed by name — the Bot API knows only its
numeric `message_thread_id`, which exists only once the topic is created — so
the coordinator creates one the first time a thread needs it and remembers the
id on the thread row (`threads.telegram_topic_id`).

Creation happens on the background delivery thread, not in a request handler:
it is a network round-trip to Telegram, and the whole point of the outbox is
that Telegram being slow or down never blocks a worker. A creation that fails
just leaves the thread without a topic; the message is delivered to General
instead and the next one retries — the same "owed until paid" stance the outbox
takes with sends.
"""

import json
import logging
from typing import Any, Optional
from urllib import error, parse, request

logger = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org"

# Telegram rejects forum-topic names longer than 128 characters.
MAX_TOPIC_NAME = 128


def _call(token: str, method: str, **params: Any) -> Optional[dict]:
    """Call one Bot API method; return its `result`, or None on any failure.

    Never raises: a topic that cannot be created is a degraded-but-working
    state (messages fall back to General), not a reason to wedge the delivery
    loop.
    """
    payload = parse.urlencode(params).encode()
    url = f"{API_BASE}/bot{token}/{method}"
    try:
        with request.urlopen(url, data=payload, timeout=30) as response:
            body = json.load(response)
    except error.HTTPError as e:
        try:
            body = json.load(e)
        except Exception:  # noqa: BLE001 - a non-JSON error body is still a failure
            logger.error("Telegram %s failed: HTTP %s", method, e.code)
            return None
    except Exception as e:  # noqa: BLE001 - same contract as TelegramNotifier.send
        logger.error("Telegram %s failed: %s", method, e)
        return None
    if not body.get("ok"):
        logger.error("Telegram %s rejected: %s", method, body.get("description", body))
        return None
    return body.get("result")


def topic_name(thread: dict) -> str:
    """A short, human name for a buyer's topic: who, then what listing."""
    who = str(thread.get("counterpart") or thread.get("thread_id") or "Unknown")
    listing = thread.get("listing_title")
    name = f"{who} · {listing}" if listing else who
    return name[:MAX_TOPIC_NAME]


def create_forum_topic(token: str, chat_id: str, name: str) -> Optional[int]:
    """Create a forum topic; return its message_thread_id, or None on failure."""
    result = _call(token, "createForumTopic", chat_id=chat_id, name=name)
    if not result:
        return None
    topic_id = result.get("message_thread_id")
    return int(topic_id) if topic_id is not None else None


def close_forum_topic(token: str, chat_id: str, topic_id: int) -> bool:
    return _call(token, "closeForumTopic", chat_id=chat_id, message_thread_id=topic_id) is not None


def reopen_forum_topic(token: str, chat_id: str, topic_id: int) -> bool:
    return _call(token, "reopenForumTopic", chat_id=chat_id, message_thread_id=topic_id) is not None


def ensure_topic(db: Any, notifier: Any, thread: dict) -> Optional[int]:
    """The topic id for `thread`, creating and remembering one if needed.

    Returns None when there is no thread to key on, the notifier is not
    configured, or Telegram refused to create the topic — the caller then falls
    back to General. Safe to call repeatedly: an existing id is returned without
    a network call.

    Called only from the single background delivery thread, so the read-then-
    create is not racy — no two callers create a topic for the same thread.
    """
    if not thread or not thread.get("thread_id"):
        return None

    existing = thread.get("telegram_topic_id")
    if existing:
        return int(existing)

    token = getattr(notifier, "token", None)
    chat_id = getattr(notifier, "chat_id", None)
    if not (token and chat_id):
        return None

    topic_id = create_forum_topic(token, chat_id, topic_name(thread))
    if topic_id is None:
        return None

    db.set_thread_fields(thread["thread_id"], {"telegram_topic_id": topic_id})
    return topic_id
