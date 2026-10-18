"""Encrypted session snapshots, so a rebuilt worker has something to restore.

A worker's Facebook session lives in a Playwright `storage_state` file on its
own disk. A container rebuild, a wiped volume, or a bad deploy takes that file
with it, and the only way back is a fresh password login — a new login from an
already-suspect IP is exactly what trips a checkpoint. So each worker keeps an
encrypted copy of its own storage_state here.

Read this before using it anywhere else: **the snapshot is a recovery aid for
the same worker on the same machine and IP, nothing more.** Facebook binds a
session to the IP and browser fingerprint it was created on, so restoring one
worker's cookies onto a different host (or through a different proxy) does not
move the session — it hands Facebook a hijacked-session signal and gets the
account checkpointed. Restore only where the session was born.

The storage_state is sealed with the vault key before it ever reaches SQLite:
cookies are bearer credentials for a live account, and this table is the one
place in the fleet where every worker's cookies sit side by side. Nothing here
is ever written or returned unencrypted except the non-secret metadata
(user agent, expiry, account label) the console needs to spot a stale session.
"""

import json
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from .. import deps
from ..deps import require_admin, require_worker
from ..schemas import SessionBackupRequest, SessionMeta, StatusResponse
from ..vault import VaultError

logger = logging.getLogger(__name__)

router = APIRouter()

# A real storage_state is tens of kilobytes. Anything past this is a bug or an
# attempt to use the control plane as a blob store, and it is rejected before we
# spend the memory encrypting it — the shared SQLite connection would stall the
# whole fleet's heartbeats while it wrote.
MAX_STATE_BYTES = 5 * 1024 * 1024


def fb_user_id_of(storage_state: Dict[str, Any] | None) -> Optional[str]:
    """The Facebook numeric user id in a storage_state, from its `c_user` cookie.

    This is the one thing read out of the session document, and it is chosen
    because it is not a secret: `c_user` is the public profile id that appears
    in every profile URL. The login tokens (`xs`, `datr`, localStorage) are
    never touched.
    """
    for cookie in (storage_state or {}).get("cookies") or []:
        if isinstance(cookie, dict) and cookie.get("name") == "c_user":
            value = str(cookie.get("value") or "").strip()
            return value or None
    return None


def _account_for(worker_id: str, claimed: Optional[str]) -> Optional[str]:
    """The account label to file this snapshot under.

    The fleet's own worker→account mapping wins, so a worker cannot mislabel
    its snapshot as another account's. Falls back to what the body claims and
    then to nothing: the label is metadata for the console, and a worker with no
    account registered yet still deserves a backup rather than a 404.
    """
    row = deps.db.account_row_for_worker(worker_id)
    if row:
        return row["account_id"]
    return claimed


@router.post("/v1/session/backup", response_model=StatusResponse)
def backup_session(
    payload: SessionBackupRequest, worker: Optional[str] = Depends(require_worker)
) -> StatusResponse:
    """Store a worker's storage_state, encrypted, replacing its last snapshot."""
    # A per-worker token identifies the reporter authoritatively; the legacy
    # fleet token identifies nobody, so it has to name itself in the body.
    worker_id = worker or payload.worker_id
    if not worker_id:
        raise HTTPException(
            status_code=400,
            detail="worker_id is required when authenticating with the fleet-wide token.",
        )

    size = len(json.dumps(payload.storage_state).encode())
    if size > MAX_STATE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"storage_state is {size} bytes; the limit is {MAX_STATE_BYTES}. A session "
            "snapshot this large is not a session — check what the worker is sending.",
        )

    # A logged-out jar is not a session. Stored, it replaced the last good
    # snapshot, the one copy a worker that lost its file could restore from;
    # workers predating the save guard still send one after a failed login.
    if not any(
        isinstance(cookie, dict) and cookie.get("name") == "xs"
        for cookie in payload.storage_state.get("cookies") or []
    ):
        raise HTTPException(
            status_code=422,
            detail="storage_state holds no Facebook session (no xs cookie); the last "
            "snapshot is kept.",
        )

    try:
        # The whole document is sealed as one blob: cookies, localStorage, and
        # origins alike. Splitting out "just the cookies" would leave the login
        # tokens Facebook also stashes in localStorage sitting in plaintext.
        state_blob = deps.get_vault().encrypt(payload.storage_state)
    except VaultError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    account_id = _account_for(worker_id, payload.account_id)
    deps.db.upsert_snapshot(
        worker_id,
        {
            "account_id": account_id,
            "state_blob": state_blob,
            "user_agent": payload.user_agent,
            "session_expiry": payload.session_expiry,
            "fb_user_id": fb_user_id_of(payload.storage_state),
        },
    )
    # Size and identity only — never the state itself, since logs are the one
    # place secrets leak out of an otherwise encrypted system.
    logger.info(
        "Sealed a %d-byte session snapshot for worker %s (account %s)",
        size,
        worker_id,
        account_id or "unregistered",
    )
    return StatusResponse()


@router.get(
    "/v1/session/{worker_id}/meta",
    response_model=SessionMeta,
    dependencies=[Depends(require_admin)],
)
def session_meta(worker_id: str) -> SessionMeta:
    """What the console needs to judge a snapshot, and nothing more.

    Deliberately not the state: the console answers "is there a backup and how
    old is it", which needs no cookies. The fields are built one by one rather
    than splatting the row, so a column added to session_snapshots later cannot
    quietly start being served.
    """
    snapshot = deps.db.get_snapshot(worker_id)
    if snapshot is None:
        raise HTTPException(
            status_code=404,
            detail=f"No session snapshot for worker '{worker_id}'. It has never backed one up.",
        )
    # Snapshots sealed before the column existed carry the id only inside the
    # blob; read it out rather than wait for the worker's next backup. It is
    # not persisted here — the next backup fills the column — so the admin
    # read path never writes.
    fb_user_id = snapshot.get("fb_user_id")
    if not fb_user_id and snapshot.get("state_blob") is not None:
        try:
            fb_user_id = fb_user_id_of(deps.get_vault().decrypt(snapshot["state_blob"]))
        except VaultError:
            fb_user_id = None
    return SessionMeta(
        worker_id=worker_id,
        account_id=snapshot.get("account_id"),
        fb_user_id=fb_user_id,
        user_agent=snapshot.get("user_agent"),
        session_expiry=snapshot.get("session_expiry"),
        backed_up_at=snapshot.get("backed_up_at"),
    )


@router.get("/v1/session/{worker_id}/restore")
def restore_session(
    worker_id: str, worker: Optional[str] = Depends(require_worker)
) -> Dict[str, Any]:
    """Hand a worker back its own decrypted storage_state.

    This is the one endpoint that emits live session cookies, so it is the most
    dangerous in the control plane and is fenced accordingly:

      * Only a per-worker token gets in. The legacy fleet-wide token is shared
        by every worker and proves nothing about who is calling — with it, one
        compromised VM could drain every session in the fleet. It is refused
        here even though it is still accepted elsewhere.
      * The token's worker id must equal the path's. A worker restores itself
        and nothing else.

    Even for the right worker this is only safe on the same host and IP the
    session was created on; see the module docstring.
    """
    if worker is None:
        raise HTTPException(
            status_code=403,
            detail="Restoring a session requires a per-worker token. The fleet-wide token "
            "cannot prove which worker is calling, so it may not read session state.",
        )
    if worker != worker_id:
        raise HTTPException(
            status_code=403,
            detail=f"Worker '{worker}' may not restore the session of '{worker_id}'. "
            "A worker can only restore its own.",
        )

    snapshot = deps.db.get_snapshot(worker_id)
    if snapshot is None or snapshot.get("state_blob") is None:
        raise HTTPException(
            status_code=404,
            detail=f"No session snapshot for worker '{worker_id}'. It has never backed one up.",
        )

    try:
        storage_state = deps.get_vault().decrypt(snapshot["state_blob"])
    except VaultError as e:
        # Key missing, or rotated since the snapshot was sealed. Either way the
        # control plane is misconfigured, not the worker.
        raise HTTPException(status_code=503, detail=str(e)) from e

    logger.warning(
        "Released the session snapshot for worker %s (backed up %s)",
        worker_id,
        snapshot.get("backed_up_at"),
    )
    return {
        "worker_id": worker_id,
        "storage_state": storage_state,
        "user_agent": snapshot.get("user_agent"),
        "session_expiry": snapshot.get("session_expiry"),
        "backed_up_at": snapshot.get("backed_up_at"),
    }
