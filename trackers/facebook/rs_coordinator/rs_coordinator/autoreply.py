"""The auto-reply policy: when a Messenger thread earns an automatic answer.

Pure decision logic, deliberately separated from the router (like `health` and
`dedupe`) so every rule is testable against an injected clock and a plain dict.

The stance is conservative because every automated send spends account trust:

* **Off unless switched on.** `RS_AUTOREPLY_ENABLED=1` is an operator decision,
  not a default.
* **One reply per thread, ever.** The reply's only job is to keep a seller warm
  until a human reads the Telegram alert; a second automated message in the
  same conversation is where "assistant" turns into "bot".
* **Humans win.** A thread an operator claimed, or one that already carries
  any outgoing message (a human typed in the Facebook UI, or a previous reply
  landed), is never touched.
* **Capped and clocked.** A fleet-wide daily budget, and quiet hours so the
  account does not answer at 4 a.m. with suspicious machine punctuality.
"""

import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

# Friendly, honest, and asks for exactly what the human will need to quote a
# price. No pretending to be a person mid-negotiation — it answers, then hands
# over.
DEFAULT_TEMPLATE = (
    "Thanks for reaching out! Yes — we're buying used server hardware "
    "(RAM and SSDs, bulk lots preferred). Could you share what you have — "
    "part numbers, quantities, and a photo or two? We'll get back to you "
    "with an offer shortly."
)

DEFAULT_MAX_PER_DAY = 20

# UTC hours during which an auto-reply may be queued. 14–04 UTC is roughly
# 8 a.m.–10 p.m. in Denver; overnight silence reads as a human schedule.
DEFAULT_HOURS = (14, 4)


@dataclass
class AutoReplyPolicy:
    enabled: bool = False
    template: str = DEFAULT_TEMPLATE
    max_per_day: int = DEFAULT_MAX_PER_DAY
    # Inclusive start hour, exclusive end hour, UTC. start > end wraps midnight.
    hours: tuple = field(default=DEFAULT_HOURS)

    def within_hours(self: "AutoReplyPolicy", now: datetime) -> bool:
        start, end = self.hours
        if start == end:
            return True
        hour = now.astimezone(timezone.utc).hour
        if start < end:
            return start <= hour < end
        return hour >= start or hour < end

    def decide(
        self: "AutoReplyPolicy",
        thread: Dict[str, Any],
        messages: List[Dict[str, Any]],
        sent_today: int,
        now: datetime | None = None,
    ) -> Optional[str]:
        """The reply text to queue for this thread, or None to stay silent."""
        if not self.enabled:
            return None
        moment = now or datetime.now(timezone.utc)
        if not self.within_hours(moment):
            return None
        if sent_today >= self.max_per_day:
            return None
        if thread.get("human_claimed"):
            return None
        if thread.get("autoreplied_at"):
            return None
        if not messages:
            return None
        # Any outgoing message means the conversation is already being handled
        # — by a person in the Facebook UI, or by a reply already queued and
        # sent. Either way this policy's moment has passed.
        if any(m.get("direction") == "out" for m in messages):
            return None
        return self.template


def policy_from_env(env: Optional[Dict[str, str]] = None) -> AutoReplyPolicy:
    source = os.environ if env is None else env
    hours = DEFAULT_HOURS
    raw = source.get("RS_AUTOREPLY_HOURS", "")
    if raw:
        try:
            start_text, end_text = raw.split("-", 1)
            hours = (int(start_text) % 24, int(end_text) % 24)
        except ValueError:
            # A malformed setting must fail toward the default window, not
            # toward "no window" (which would mean replying around the clock).
            hours = DEFAULT_HOURS
    try:
        max_per_day = int(source.get("RS_AUTOREPLY_MAX_PER_DAY", DEFAULT_MAX_PER_DAY))
    except ValueError:
        max_per_day = DEFAULT_MAX_PER_DAY
    return AutoReplyPolicy(
        enabled=source.get("RS_AUTOREPLY_ENABLED", "").strip().lower() in ("1", "true", "yes"),
        template=source.get("RS_AUTOREPLY_TEMPLATE") or DEFAULT_TEMPLATE,
        max_per_day=max_per_day,
        hours=hours,
    )


def day_window_start(now: datetime | None = None) -> str:
    """The ISO stamp 24 hours ago — the daily cap is a rolling day, so a
    midnight boundary cannot double the budget."""
    moment = now or datetime.now(timezone.utc)
    return (moment - timedelta(days=1)).isoformat(timespec="seconds")
