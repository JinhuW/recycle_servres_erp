"""Telegram alerting for the coordinator.

Workers report to the coordinator and the coordinator is the only thing that
messages Telegram, so alerts arrive once per listing no matter how many
workers saw it.
"""

import logging
import threading
import time
from typing import Any, Dict
from urllib import parse, request

logger = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org"
MAX_MESSAGE_LENGTH = 4096

_MARKDOWN_V2_SPECIALS = r"_*[]()~`>#+-=|{}.!"


def escape_markdown(text: str) -> str:
    return "".join(f"\\{ch}" if ch in _MARKDOWN_V2_SPECIALS else ch for ch in text)


class TelegramNotifier:
    """Minimal Telegram bot client with a 1 msg/sec floor."""

    def __init__(
        self: "TelegramNotifier",
        token: str | None,
        chat_id: str | None,
        min_interval: float = 1.1,
    ) -> None:
        self.token = token
        self.chat_id = chat_id
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._last_send = 0.0

    @property
    def enabled(self: "TelegramNotifier") -> bool:
        return bool(self.token and self.chat_id)

    def send(self: "TelegramNotifier", text: str) -> bool:
        if not self.enabled:
            logger.warning("Telegram not configured; dropping message")
            return False

        with self._lock:
            elapsed = time.time() - self._last_send
            if elapsed < self.min_interval:
                time.sleep(self.min_interval - elapsed)

            payload = parse.urlencode(
                {
                    "chat_id": self.chat_id,
                    "text": text[:MAX_MESSAGE_LENGTH],
                    "parse_mode": "MarkdownV2",
                    "disable_web_page_preview": "false",
                }
            ).encode()
            url = f"{API_BASE}/bot{self.token}/sendMessage"
            try:
                with request.urlopen(url, data=payload, timeout=30) as response:
                    ok = 200 <= response.status < 300
            except Exception as e:  # noqa: BLE001 - the contract is False, never a raise
                # Not just URLError/OSError: http.client raises its own family
                # (BadStatusLine and friends) for a half-broken server, and an
                # exception escaping here used to take the caller's whole
                # request down with it.
                logger.error("Telegram send failed: %s", e)
                ok = False
            self._last_send = time.time()
            return ok

    def send_listing(
        self: "TelegramNotifier", record: Dict[str, Any], verdict: str, worker_id: str
    ) -> bool:
        return self.send(format_listing(record, verdict, worker_id))


def format_message(thread: Dict[str, Any], message: Dict[str, Any]) -> str:
    """A Messenger message as a Telegram alert, with enough context to answer.

    The thread id is included verbatim so an operator can reply from the
    console (`rsc msg reply <thread-id> "..."`) without opening Facebook.
    """
    counterpart = escape_markdown(str(thread.get("counterpart") or "Unknown"))
    lines = [f"*Messenger — {counterpart}*"]
    listing = thread.get("listing_title")
    if listing:
        lines.append(f"Re: {escape_markdown(str(listing))}")
    lines.append("")
    lines.append(escape_markdown(str(message.get("text") or "(no text)")))
    lines.append("")
    worker = thread.get("worker_id")
    tail = f"Thread {escape_markdown(str(thread.get('thread_id') or '?'))}"
    if worker:
        tail += f" · worker {escape_markdown(str(worker))}"
    lines.append(tail)
    return "\n".join(lines)


def format_listing(record: Dict[str, Any], verdict: str, worker_id: str) -> str:
    headline = {
        "new": "New match",
        "changed": "Listing updated",
        "discounted": "Price drop",
    }.get(verdict, "Match")

    title = escape_markdown(str(record.get("title") or "Untitled"))
    price = escape_markdown(str(record.get("price") or "?"))
    location = escape_markdown(str(record.get("location") or "?"))
    condition = escape_markdown(str(record.get("condition") or "?"))
    item_name = escape_markdown(str(record.get("item_name") or "?"))
    score = record.get("ai_score")
    comment = escape_markdown(str(record.get("ai_comment") or ""))
    url = str(record.get("post_url") or "")

    lines = [
        f"*{escape_markdown(headline)}: {title}*",
        "",
        f"Price: *{price}*",
        f"Location: {location}",
        f"Condition: {condition}",
        f"Search: {item_name}",
        f"Worker: {escape_markdown(worker_id)}",
    ]
    if score is not None:
        lines.append(f"AI rating: *{escape_markdown(str(score))}/5*")
    if comment:
        lines.append(f"\n{comment}")
    if url:
        lines.append(f"\n{escape_markdown(url)}")
    return "\n".join(lines)
