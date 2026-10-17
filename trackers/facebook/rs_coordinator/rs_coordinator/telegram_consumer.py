"""The Telegram update consumer: staff replies and partner reactions.

`TelegramNotifier` only ever *sends*; this thread *reads*, long-polling
getUpdates — the bot's one global cursor, so everything the coordinator learns
from Telegram comes through here. Two independent things ride the same poll:

* War-room messages: a staffer's answer typed into a buyer's forum topic
  becomes a queued reply the mautrix-meta router delivers over Messenger.
  Active only when TELEGRAM_WARROOM_CHAT_ID is configured.
* Alert reactions: a partner marking a listing alert with an emoji in the
  listings chat (TELEGRAM_CHAT_ID) is recorded raw — the source data behind
  the alert hit rate. Reactions reach a bot only if it is an admin of the
  chat (ours is: it created the priority topics) and only for updates issued
  after "message_reaction" entered allowed_updates; there is no history API,
  so anything reacted while the consumer was down is gone.

Because getUpdates is exclusive per bot token, nothing else may poll while the
coordinator runs — `rsc telegram-chatid` (the only other getUpdates caller in
this repo) must only be used with rs-coordinator stopped.

Only long-poll, no webhook: the coordinator lives behind the homelab's NAT with
no public HTTPS endpoint, and getUpdates needs only an outbound connection. The
cursor (`telegram_offset`) is committed after each update is handled, so a
restart resumes where it left off instead of replaying or dropping the backlog.

What it deliberately ignores: chats it was not configured for, messages with
no forum topic (General chatter), the bot's own posts and other bots,
anonymous reactions (no user to attribute them to), service messages (a topic
being created), and topics that map to no known thread. Each of those would
otherwise turn stray group chatter into a message to a seller, or noise into
hit-rate data.
"""

import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Callable, List, Optional
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


def handle_update(
    db: AnyDatabase,
    warroom_chat_id: Optional[str],
    alerts_chat_id: Optional[str],
    update: dict,
) -> Optional[int]:
    """Dispatch one getUpdates entry: a staff reply or a partner reaction.

    Returns the outbound id when a reply was queued, else None (a recorded
    reaction included). Pure apart from the DB writes, so tests drive it with
    crafted update dicts and a fake db.
    """
    reaction = update.get("message_reaction")
    if isinstance(reaction, dict):
        handle_reaction(db, alerts_chat_id, reaction)
        return None

    if not warroom_chat_id:
        # No war room configured: the message branch would misroute General
        # chatter, so it stays inert exactly as it was before this consumer
        # started running for reactions.
        return None

    message = update.get("message") or update.get("edited_message")
    if not isinstance(message, dict):
        return None

    chat = message.get("chat") or {}
    if str(chat.get("id")) != str(warroom_chat_id):
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


def _current_emoji(new_reaction: Any) -> List[str]:
    """The user's reaction as it stands now, as plain strings.

    Telegram's ReactionType is a tagged union: standard reactions carry
    `emoji`, paid/custom ones `custom_emoji_id`; `type` is the last-resort
    label so an unknown future shape still records *something*.
    """
    out: List[str] = []
    for entry in new_reaction or []:
        if not isinstance(entry, dict):
            continue
        value = entry.get("emoji") or entry.get("custom_emoji_id") or entry.get("type")
        if value:
            out.append(str(value))
    return out


def handle_reaction(
    db: AnyDatabase, alerts_chat_id: Optional[str], reaction: dict
) -> bool:
    """Record one message_reaction update; True when a row was written.

    Stores the raw old/new reaction JSON plus the extracted current state,
    keyed by (chat, message, user). Deliberately does NOT check that the
    message is a known alert: a reaction on an alert sent before the ledger
    existed is still signal, and the stats query surfaces it as unmatched.
    """
    if not alerts_chat_id:
        return False

    chat = reaction.get("chat") or {}
    if str(chat.get("id")) != str(alerts_chat_id):
        return False

    user = reaction.get("user")
    if not isinstance(user, dict) or user.get("is_bot") or user.get("id") is None:
        # Anonymous reactions (actor_chat) have nobody to attribute; bot
        # reactions are not partner signal.
        return False

    message_id = reaction.get("message_id")
    if not isinstance(message_id, int):
        return False

    reacted_at = None
    date = reaction.get("date")
    if isinstance(date, (int, float)):
        reacted_at = datetime.fromtimestamp(date, tz=timezone.utc).isoformat(
            timespec="seconds"
        )

    user_name = (
        " ".join(
            part
            for part in (user.get("first_name"), user.get("last_name"))
            if isinstance(part, str) and part
        )
        or user.get("username")
        or None
    )

    db.record_alert_reaction(
        chat_id=str(chat.get("id")),
        message_id=message_id,
        user_id=str(user.get("id")),
        user_name=user_name,
        # ensure_ascii=False so the stored JSON shows the actual emoji instead
        # of \\u escapes — this is long-term source data humans will read.
        old_reaction=json.dumps(reaction.get("old_reaction") or [], ensure_ascii=False),
        new_reaction=json.dumps(reaction.get("new_reaction") or [], ensure_ascii=False),
        emoji=json.dumps(_current_emoji(reaction.get("new_reaction")), ensure_ascii=False),
        reacted_at=reacted_at,
    )
    logger.info("Recorded reaction on message %s", message_id)
    return True


def _get_updates(token: str, offset: int, allowed: List[str]) -> Optional[list]:
    """One getUpdates call; the list of updates, or None on any failure."""
    params = parse.urlencode(
        {
            "offset": offset,
            "timeout": LONG_POLL_SECONDS,
            # Only what the consumer acts on — staff replies and alert
            # reactions; skip the rest so a busy group's edits do not churn
            # the cursor. Telegram drops unlisted update types server-side.
            "allowed_updates": json.dumps(allowed),
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
    """Long-poll Telegram and handle staff replies / partner reactions.

    Mirrors `Background`: a db_getter rather than a database (lazy open), a
    stop event, and all state in the database so a restart resumes cleanly.
    Started when a token and at least one of the two chats are configured;
    each chat id being None keeps its branch inert.
    """

    def __init__(
        self: "TelegramUpdateConsumer",
        db_getter: Callable[[], AnyDatabase],
        token: str,
        warroom_chat_id: Optional[str] = None,
        alerts_chat_id: Optional[str] = None,
    ) -> None:
        super().__init__(name="rs-telegram-consumer", daemon=True)
        self._db = db_getter
        self._token = token
        self._warroom_chat_id = warroom_chat_id
        self._alerts_chat_id = alerts_chat_id
        # Computed once: which update types this configuration can act on.
        self._allowed: List[str] = []
        if warroom_chat_id:
            self._allowed.append("message")
        if alerts_chat_id:
            self._allowed.append("message_reaction")
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
        updates = _get_updates(self._token, offset, self._allowed)
        if updates is None:
            self._stop.wait(ERROR_BACKOFF)
            return
        for update in updates:
            try:
                handle_update(db, self._warroom_chat_id, self._alerts_chat_id, update)
            except Exception:  # noqa: BLE001 - one bad update must not wedge the cursor
                logger.exception("Could not handle update %s; skipping", update.get("update_id"))
            # Advance past this update whether or not it was actionable, so a
            # message we ignore is not re-fetched forever.
            update_id = update.get("update_id")
            if isinstance(update_id, int):
                db.set_telegram_offset(update_id + 1)
