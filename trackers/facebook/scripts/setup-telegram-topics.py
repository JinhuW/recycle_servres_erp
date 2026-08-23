#!/usr/bin/env python
"""Create the three priority forum topics and print their thread ids.

Listing alerts are grouped by the AI's counted units into Telegram forum
topics — 🔥 High priority (50+ units), ⚡ Medium priority (10-49), 🐢 Low
priority (5-9) — which Telegram shows as a sidebar of the group, one line per
topic, exactly like any other topics-enabled group.

Topics cannot be configured by name: the Bot API addresses them by numeric
message_thread_id, which only exists once the topic does. This script does the
one-time half — create the topics through the same bot that sends the alerts,
and print the ids in secrets.env form:

    set -a; source configs/secrets.env; set +a
    python scripts/setup-telegram-topics.py

Requirements, both checked here with readable errors instead of Telegram's
generic 400s: the chat behind TELEGRAM_CHAT_ID must be a group with Topics
switched on (group Settings -> Topics), and the bot behind TELEGRAM_TOKEN must
be an admin of it with the "Manage topics" right.

Running it twice creates duplicate topics — Telegram allows same-name topics
and offers no listing API to detect them. If the ids were lost, delete the
old topics in the app first, or copy the ids out of any message's context
("Copy Message Link" ends in .../<thread_id>/<message_id>).
"""

from __future__ import annotations

import json
import os
import sys
from urllib import error, parse, request

API_BASE = "https://api.telegram.org"

# Keep in sync with PRIORITY_EMOJI in ai_marketplace_monitor/notification.py.
TOPICS = [
    ("TELEGRAM_TOPIC_HIGH", "🔥 High priority", "50+ units"),
    ("TELEGRAM_TOPIC_MEDIUM", "⚡ Medium priority", "10-49 units"),
    ("TELEGRAM_TOPIC_LOW", "🐢 Low priority", "5-9 units"),
]


def call(token: str, method: str, **params: str) -> dict:
    payload = parse.urlencode(params).encode()
    url = f"{API_BASE}/bot{token}/{method}"
    try:
        with request.urlopen(url, data=payload, timeout=30) as response:
            body = json.load(response)
    except error.HTTPError as e:
        body = json.load(e)
    if not body.get("ok"):
        raise SystemExit(f"{method} failed: {body.get('description', body)}")
    return body["result"]


def main() -> None:
    token = os.environ.get("TELEGRAM_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        raise SystemExit(
            "TELEGRAM_TOKEN and TELEGRAM_CHAT_ID must be set — "
            "run: set -a; source configs/secrets.env; set +a"
        )

    chat = call(token, "getChat", chat_id=chat_id)
    if not chat.get("is_forum"):
        raise SystemExit(
            f"Chat {chat_id} ({chat.get('title', 'untitled')}) does not have Topics "
            "enabled. Turn them on in the group's Settings -> Topics, then rerun."
        )

    print("# Add to configs/secrets.env:")
    for env_name, topic_name, meaning in TOPICS:
        topic = call(token, "createForumTopic", chat_id=chat_id, name=topic_name)
        print(f"{env_name}={topic['message_thread_id']}  # {topic_name} ({meaning})")

    print(
        "\nDone. Restart the monitor after sourcing the new values "
        "(scripts/deploy.sh re-reads secrets.env).",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
