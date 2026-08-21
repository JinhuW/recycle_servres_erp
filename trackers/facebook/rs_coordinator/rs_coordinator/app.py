"""Coordinator HTTP API — the fleet's control plane.

Two jobs. The original one: workers report matched listings here and the
coordinator dedupes across the fleet and owns the single Telegram alert stream.
The second: it holds every account secret, answers verification-code requests,
tracks worker health, and routes anything needing a human to one console.

Bind this to a private network (Tailscale/VPN). The bearer tokens are a guard
against stray requests, not a substitute for network isolation.

Routing lives in `routers/`, one module per concern; this file only wires them.
"""

import logging
import os

from fastapi import FastAPI

from .deps import DB_PATH, db, notifier, ops_notifier
from .routers import auth, escalation, health, listings, session

logging.basicConfig(level=os.environ.get("RS_LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

app = FastAPI(title="Recycle Servers Marketplace Coordinator", version="2.0.0")

app.include_router(listings.router, tags=["listings"])
app.include_router(health.router, tags=["health"])
app.include_router(auth.router, tags=["auth"])
app.include_router(escalation.router, tags=["escalation"])
app.include_router(session.router, tags=["session"])

# Re-exported so tooling and tests can reach the process singletons through the
# app module, which is the conventional entry point.
__all__ = ["app", "db", "notifier", "ops_notifier", "DB_PATH"]
