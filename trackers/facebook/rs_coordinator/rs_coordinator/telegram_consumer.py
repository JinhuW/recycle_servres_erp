"""The Telegram reply consumer: staff answers in a topic → an outbound reply.

The other half of the router. `TelegramNotifier` only ever *sends*; this thread
*reads*, long-polling getUpdates so a message a staffer types into a buyer's
forum topic becomes a queued reply the mautrix-meta router will deliver over
Messenger.

Only long-poll, no webhook: the coordinator lives behind the homelab's NAT with
no public HTTPS endpoint, and getUpdates needs only an outbound connection. The
cursor (`telegram_offset`) is committed after each update is handled, so a
restart resumes where it left off instead of replaying or dropping the backlog.

What it deliberately ignores: anything outside the war-room chat, messages with
no forum topic (General chatter), the bot's own posts and other bots, service
messages (a topic being created), and topics that map to no known thread. Each
of those would otherwise turn stray group chatter into a message to a seller.
"""

import json
import logging
import threading
from typing import Any, Callable, Optional
from urllib import error, parse, request

from .db import AnyDatabase

logger = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org"

# getUpdates long-poll: the server holds the request open this long waiting for
# an update, so the loop is not a busy tote of empty polls.
LONG_POLL_SECONDS = 25
# Socket timeout: a little past the long poll, so a healthy empty poll returns
# on the server's schedule rather than tripping the client timeout.
SOCKET_TIMEOUT = LONG_POLL_SECONDS + 10
# How long to wait before retrying after a failed poll.
ERROR_BACKOFF = 5.0


def handle_update(db: AnyDatabase, chat_id: str, update: dict) -> Optional[int]:
    """Turn one getUpdates entry into a queued reply, if it is one.

    Returns the outbound id when a reply was queued, else None. Pure apart from
    the DB writes, so tests drive it with crafted update dicts and a fake db.
    """
    message = update.get("message") or update.get("edited_message")
    if not isinstance(message, dict):
        return None

    chat = message.get("chat") or {}
    if str(chat.get("id")) != str(chat_id):
        return None

    sender = message.get("from") or {}
    if sender.get("is_bot"):
        # The bot's own topic posts (the buyer's messages we mirrored in) come
        # back through getUpdates; answering them would loop.
        return None

    topic_id = message.get("message_thread_id")
    if not topic_id or not message.get("is_topic_message"):
        # General chatter, not a reply to any one buyer.
        return None

    text = (message.get("text") or "").strip()
    if not text:
        # Stickers, photos, a topic-created service message: nothing to send.
        return None

    thread = db.get_thread_by_topic(int(topic_id))
    if not thread:
        logger.info("Telegram reply in unknown topic %s; ignoring", topic_id)
        return None

    # worker_id is left NULL so any matrix worker can claim it — the transport
    # partition ('matrix') is what routes it to the router, not the worker id.
    outbound_id = db.enqueue_outbound(
        thread["thread_id"], None, text, "operator", transport="matrix"
    )
    # A staffer who answered now holds the conversation; auto-reply is fenced
    # out of it exactly as an operator reply through the console would be.
    db.set_thread_fields(thread["thread_id"], {"human_claimed": 1})
    logger.info(
        "Queued matrix reply %s to thread %s from topic %s",
        outbound_id,
        thread["thread_id"],
        topic_id,
    )
    return outbound_id


def _get_updates(token: str, offset: int) -> Optional[list]:
    """One getUpdates call; the list of updates, or None on any failure."""
    params = parse.urlencode(
        {
            "offset": offset,
            "timeout": LONG_POLL_SECONDS,
            # message updates are all the router acts on; skip the rest so a
            # busy group's edits/reactions do not churn the cursor.
            "allowed_updates": json.dumps(["message"]),
        }
    ).encode()
    url = f"{API_BASE}/bot{token}/getUpdates"
    try:
        with request.urlopen(url, data=params, timeout=SOCKET_TIMEOUT) as response:
            body = json.load(response)
    except error.HTTPError as e:
        logger.error("getUpdates failed: HTTP %s", e.code)
        return None
    except Exception as e:  # noqa: BLE001 - a failed poll is a retry, never a crash
        logger.error("getUpdates failed: %s", e)
        return None
    if not body.get("ok"):
        logger.error("getUpdates rejected: %s", body.get("description", body))
        return None
    return body.get("result", [])


class TelegramUpdateConsumer(threading.Thread):
    """Long-poll the war-room chat and queue staff replies until stopped.

    Mirrors `Background`: a db_getter rather than a database (lazy open), a
    stop event, and all state in the database so a restart resumes cleanly.
    Started only when a token and war-room chat are configured.
    """

    def __init__(
        self: "TelegramUpdateConsumer",
        db_getter: Callable[[], AnyDatabase],
        token: str,
        chat_id: str,
    ) -> None:
        super().__init__(name="rs-telegram-consumer", daemon=True)
        self._db = db_getter
        self._token = token
        self._chat_id = chat_id
        self._stop = threading.Event()

    def stop(self: "TelegramUpdateConsumer") -> None:
        self._stop.set()

    def run(self: "TelegramUpdateConsumer") -> None:
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception:  # noqa: BLE001 - the loop must outlive any one failure
                logger.exception("Telegram consumer poll failed; will retry")
                self._stop.wait(ERROR_BACKOFF)

    def poll_once(self: "TelegramUpdateConsumer") -> None:
        db = self._db()
        offset = db.get_telegram_offset()
        updates = _get_updates(self._token, offset)
        if updates is None:
            self._stop.wait(ERROR_BACKOFF)
            return
        for update in updates:
            try:
                handle_update(db, self._chat_id, update)
            except Exception:  # noqa: BLE001 - one bad update must not wedge the cursor
                logger.exception("Could not handle update %s; skipping", update.get("update_id"))
            # Advance past this update whether or not it was actionable, so a
            # message we ignore is not re-fetched forever.
            update_id = update.get("update_id")
            if isinstance(update_id, int):
                db.set_telegram_offset(update_id + 1)
