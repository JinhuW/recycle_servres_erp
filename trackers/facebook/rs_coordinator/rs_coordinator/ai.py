"""AI helpers for the coordinator, via OpenRouter.

The rest of the fleet already talks to OpenRouter (the monitor's listing
evaluation), so the coordinator uses the same backend and the same
`OPENROUTER_API_KEY` from `configs/secrets.env`. Everything here is
best-effort: no key, a timeout, or a garbled response all mean None, never
an exception — an AI outage must not cost anyone a Telegram alert.
"""

import json
import logging
import os
from typing import Dict, Optional
from urllib import request

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-2.5-flash"

_COUNT_PROMPT = (
    "A seller sent this Facebook Marketplace message to a used-server-hardware "
    "buyer. How many items are they offering to sell? Answer with only a short "
    "quantity phrase taken from the message, e.g. '32 sticks' or '2 servers'. "
    "Capacities ('16GB'), prices, and model numbers are not quantities. "
    "If the message states no quantity, answer exactly: none"
)


def item_count_from_ai(
    text: str | None,
    env: Optional[Dict[str, str]] = None,
    timeout: float = 15,
) -> Optional[str]:
    """The quantity of items a message offers, per the AI, or None."""
    settings = env if env is not None else os.environ
    api_key = settings.get("OPENROUTER_API_KEY")
    if not api_key or not text or not text.strip():
        return None

    body = json.dumps(
        {
            "model": settings.get("RS_AI_MODEL", DEFAULT_MODEL),
            "messages": [
                {"role": "system", "content": _COUNT_PROMPT},
                {"role": "user", "content": text[:2000]},
            ],
            "max_tokens": 20,
            "temperature": 0,
        }
    ).encode()
    req = request.Request(
        OPENROUTER_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with request.urlopen(req, timeout=timeout) as response:
            payload = json.load(response)
        answer = str(payload["choices"][0]["message"]["content"]).strip()
    except Exception as e:  # noqa: BLE001 - best-effort by contract
        logger.warning("AI item-count extraction failed: %s", e)
        return None

    if not answer or answer.strip(".!'\"").lower() in ("none", "unknown", "n/a"):
        return None
    # One short phrase; a model that answers in paragraphs forfeits the field.
    answer = " ".join(answer.split())
    if len(answer) > 60:
        return None
    return answer
