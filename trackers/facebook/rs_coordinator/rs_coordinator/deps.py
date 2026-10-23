"""Shared FastAPI dependencies and process-wide singletons.

Every router imports its database handle, notifiers, and auth guards from here,
so there is one place that decides how the control plane is wired.
"""

import os
import secrets as pysecrets
import threading
from functools import lru_cache
from typing import Any, Optional

from fastapi import Header, HTTPException

from .db import AnyDatabase, open_database
from .telegram_notify import TelegramNotifier
from .tokens import verify_host_token, verify_worker_token
from .vault import AccountStore, Vault, VaultError

# Legacy fleet-wide token. Still accepted so workers deployed before per-worker
# tokens keep reporting while they are migrated.
LEGACY_TOKEN = os.environ.get("RS_COORDINATOR_TOKEN")
ADMIN_TOKEN = os.environ.get("RS_ADMIN_TOKEN")

# The database is opened on first use, not at import. Opening it here meant a
# Postgres unreachable at boot failed the module import, uvicorn exited, and
# the container restart-looped with nothing answering /healthz to say why.
# Lazily, the process comes up, /healthz reports the database unreachable, and
# the first successful open sticks. Backend choice is unchanged: Postgres when
# RS_DATABASE_URL / DATABASE_URL is set, SQLite otherwise.
_db_lock = threading.Lock()
_db_instance: Optional[AnyDatabase] = None


def get_db() -> AnyDatabase:
    global _db_instance
    if _db_instance is None:
        with _db_lock:
            if _db_instance is None:
                _db_instance = open_database()
    return _db_instance


def __getattr__(name: str) -> Any:
    """Keep the historical `deps.db` spelling working against the lazy open.

    Module-level `__getattr__` is only consulted when normal lookup fails, so
    tests that assign `deps.db = ...` still shadow it the ordinary way.
    """
    if name == "db":
        return get_db()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


notifier = TelegramNotifier(
    token=os.environ.get("TELEGRAM_TOKEN"),
    chat_id=os.environ.get("TELEGRAM_CHAT_ID"),
)

# Operational alerts (worker down, session expiring, challenge raised) go to a
# separate chat from listing alerts, so ops noise never buries a find. Falls
# back to the listings chat when no ops chat is configured. TELEGRAM_TOPIC_OPS
# is a forum topic in whichever chat that is; in production, the ops group's
# "Facebook · Fleet ops".
_ops_topic = os.environ.get("TELEGRAM_TOPIC_OPS")
ops_notifier = TelegramNotifier(
    token=os.environ.get("TELEGRAM_TOKEN"),
    chat_id=os.environ.get("TELEGRAM_OPS_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID"),
    thread_id=int(_ops_topic) if _ops_topic else None,
)

# Per-buyer Messenger alerts go to the war-room supergroup, which must have
# Topics enabled: the router opens one forum topic per conversation there.
#
# Deliberately NO fallback to the listings chat. The whole router feature —
# per-buyer topic creation and the getUpdates reply consumer — activates only
# when this is set to a distinct war room. Unset (the default, and the state
# every existing deploy is in), it stays None and the coordinator behaves
# exactly as before: buyer alerts land in the listings chat's General and
# nothing reads Telegram. That is what lets the feature ship dark.
_warroom_chat_id = os.environ.get("TELEGRAM_WARROOM_CHAT_ID")
warroom_notifier: Optional[TelegramNotifier] = (
    TelegramNotifier(token=os.environ.get("TELEGRAM_TOKEN"), chat_id=_warroom_chat_id)
    if _warroom_chat_id
    else None
)


def get_notifier() -> TelegramNotifier:
    return notifier


def get_ops_notifier() -> TelegramNotifier:
    return ops_notifier


def get_warroom_notifier() -> Optional[TelegramNotifier]:
    return warroom_notifier


@lru_cache(maxsize=1)
def get_vault() -> Vault:
    """The process vault. Cached because constructing it validates the key."""
    return Vault()


def get_account_store() -> AccountStore:
    return AccountStore(get_db(), get_vault())


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization[len("Bearer ") :].strip()


def require_worker(authorization: Optional[str] = Header(default=None)) -> Optional[str]:
    """Authenticate a worker and return its id.

    Returns None for the legacy fleet-wide token, in which case the caller
    falls back to the worker_id in the request body. A per-worker token always
    wins over whatever the body claims.
    """
    token = _bearer(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    worker_id = verify_worker_token(token)
    if worker_id:
        return worker_id

    if LEGACY_TOKEN and pysecrets.compare_digest(token, LEGACY_TOKEN):
        return None

    raise HTTPException(status_code=401, detail="Invalid bearer token")


def require_host(authorization: Optional[str] = Header(default=None)) -> str:
    """Authenticate a host's fleet agent and return its host id."""
    host_id = verify_host_token(_bearer(authorization))
    if not host_id:
        raise HTTPException(status_code=401, detail="Invalid or missing host token")
    return host_id


def require_admin(authorization: Optional[str] = Header(default=None)) -> None:
    """Guard the console-facing endpoints."""
    if not ADMIN_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="RS_ADMIN_TOKEN is not configured; admin endpoints are disabled.",
        )
    token = _bearer(authorization)
    if not token or not pysecrets.compare_digest(token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid or missing admin token")


def resolve_account(worker_id: str) -> str:
    """The account a worker owns, or 404 if the fleet config has no mapping."""
    try:
        account_id = get_account_store().account_for_worker(worker_id)
    except VaultError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    if not account_id:
        raise HTTPException(
            status_code=404,
            detail=f"No account is registered for worker '{worker_id}'. "
            "Add one with `rsc vault set-account`.",
        )
    return account_id
