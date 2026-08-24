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
from .routers import auth, escalation, health, listings, messages, session, stats
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

    # The reply consumer runs only when a war room is configured
    # (TELEGRAM_WARROOM_CHAT_ID). Unset — every current deploy — it stays off and
    # the coordinator never reads Telegram, so shipping this code changes nothing
    # until the war room is turned on.
    consumer = None
    warroom = deps.get_warroom_notifier()
    if warroom is not None and warroom.token and warroom.chat_id:
        consumer = TelegramUpdateConsumer(deps.get_db, warroom.token, warroom.chat_id)
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
app.include_router(messages.router, tags=["messages"])
app.include_router(stats.router, tags=["stats"])


def __getattr__(name: str) -> Any:
    """Re-export the process singletons tooling and tests reach through here.

    Delegated rather than imported so that touching `app.db` opens the lazy
    database on demand instead of at import time.
    """
    if name in ("db", "notifier", "ops_notifier"):
        return getattr(deps, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["app", "db", "notifier", "ops_notifier"]
