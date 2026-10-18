"""Coordinator HTTP API — the fleet's control plane.

Two jobs. The original one: workers report matched listings here and the
coordinator dedupes across the fleet and owns the single Telegram alert stream.
The second: it holds every account secret, answers verification-code requests,
tracks worker health, and routes anything needing a human to one console.

Bind this to a private network (Tailscale/VPN). The bearer tokens are a guard
against stray requests, not a substitute for network isolation.

Routing lives in `routers/`, one module per concern; this file only wires them
and runs the background loop (outbox delivery + liveness sweep) for the
process's lifetime.
"""

import logging
import os
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI

from . import deps
from .background import Background
from .routers import (
    accounts,
    alerts,
    auth,
    cities,
    escalation,
    fleet,
    health,
    identity,
    incidents,
    listings,
    messages,
    session,
    stats,
)
from .telegram_consumer import TelegramUpdateConsumer

logging.basicConfig(level=os.environ.get("RS_LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Run the background loop (and the Telegram reply consumer) while up.

    Started here rather than at import so that importing this module (tests,
    tooling, `rsc` subcommands) never spawns a thread; only a served app does.
    """
    loop = Background(
        deps.get_db,
        deps.get_notifier(),
        deps.get_ops_notifier(),
        deps.get_warroom_notifier(),
    )
    loop.start()

    # The update consumer runs when there is anything for it to read: staff
    # replies need a war room (TELEGRAM_WARROOM_CHAT_ID), partner reactions
    # need the listings chat (TELEGRAM_CHAT_ID). Either alone is enough; a
    # chat left unset keeps its branch inert. With neither set the coordinator
    # never reads Telegram at all.
    consumer = None
    warroom = deps.get_warroom_notifier()
    notifier = deps.get_notifier()
    warroom_chat = warroom.chat_id if warroom is not None else None
    alerts_chat = notifier.chat_id if notifier is not None else None
    token = (warroom.token if warroom is not None else None) or (
        notifier.token if notifier is not None else None
    )
    if token and (warroom_chat or alerts_chat):
        consumer = TelegramUpdateConsumer(
            deps.get_db,
            token,
            warroom_chat_id=warroom_chat,
            alerts_chat_id=alerts_chat,
        )
        consumer.start()

    try:
        yield
    finally:
        loop.stop()
        if consumer is not None:
            consumer.stop()


app = FastAPI(
    title="Recycle Servers Marketplace Coordinator", version="2.0.0", lifespan=lifespan
)

app.include_router(listings.router, tags=["listings"])
app.include_router(health.router, tags=["health"])
app.include_router(auth.router, tags=["auth"])
app.include_router(escalation.router, tags=["escalation"])
app.include_router(session.router, tags=["session"])
app.include_router(identity.router, tags=["identity"])
app.include_router(fleet.router, tags=["fleet"])
app.include_router(messages.router, tags=["messages"])
app.include_router(stats.router, tags=["stats"])
app.include_router(alerts.router, tags=["alerts"])
app.include_router(accounts.router, tags=["accounts"])
app.include_router(incidents.router, tags=["incidents"])
app.include_router(cities.router, tags=["cities"])


def __getattr__(name: str) -> Any:
    """Re-export the process singletons tooling and tests reach through here.

    Delegated rather than imported so that touching `app.db` opens the lazy
    database on demand instead of at import time.
    """
    if name in ("db", "notifier", "ops_notifier"):
        return getattr(deps, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["app", "db", "notifier", "ops_notifier"]
