"""Encrypted session snapshots, so a rebuilt worker has something to restore.

A worker's Facebook session lives in a Playwright `storage_state` file on its
own disk. A container rebuild, a wiped volume, or a bad deploy takes that file
with it, and the only way back is a fresh password login — a new login from an
already-suspect IP is exactly what trips a checkpoint. So each worker keeps an
encrypted copy of its own storage_state here.

Read this before using it anywhere else: **a snapshot is restored only onto
the worker slot it came from, and only while that slot presents the same
device.** Facebook binds a session to the IP and browser fingerprint it was
created on. The IP Facebook sees is the slot's proxy, which goes wherever the
slot runs, and the fingerprint is the account's device profile, which the
worker applies on any host (see `device_profiles`). A slot moved to another
host keeps both, so its session can follow it. Restoring one slot's cookies
through another slot's proxy, or under another account's device, is a
hijacked-session signal and gets the account checkpointed — hence the
`identity_key` check on restore. A slot with no proxy egresses through its
host's own IP and must stay on that host.

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
from ..cookies import CookieError, storage_state_from_text
from ..deps import require_admin, require_worker
from ..device_profiles import device_cookies_of, identity_key_for
from ..schemas import (
    SessionBackupRequest,
    SessionMeta,
    SessionSeedRequest,
    StatusResponse,
)
from ..vault import Vault, VaultError

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


def require_own_worker(worker: Optional[str], worker_id: str, action: str) -> None:
    """403 unless a per-worker token for `worker_id` itself is calling.

    For the routes that hand out session or device state. The legacy
    fleet-wide token is shared by every worker and proves nothing about who
    is calling — with it, one compromised VM could drain every session in the
    fleet — so it is refused here even though it is accepted elsewhere.
    """
    if worker is None:
        raise HTTPException(
            status_code=403,
            detail=f"A worker needs a per-worker token to {action}. The fleet-wide token "
            "cannot prove which worker is calling.",
        )
    if worker != worker_id:
        raise HTTPException(
            status_code=403,
            detail=f"Worker '{worker}' may not {action} for '{worker_id}'. "
            "A worker can only act for itself.",
        )


def _session_identity(
    vault: Vault, device_id: Optional[str], storage_state: Dict[str, Any]
) -> Optional[str]:
    """The identity this session belongs to, recording its device cookies.

    Only when the worker names the device it ran the session under and the
    session's login is that device's account. A session the browser carried
    over from the slot's previous login, still being saved while a swap's
    re-login is on its way, fails the uid test, so it neither becomes
    restorable under the new account nor lends it its device cookies.
    """
    if not device_id:
        return None
    profile = deps.db.device_profile_by_device(device_id)
    if profile is None or fb_user_id_of(storage_state) != profile.get("fb_uid"):
        return None
    cookies = device_cookies_of(storage_state)
    if cookies:
        blob = profile.get("device_cookies_blob")
        stored = vault.decrypt(blob).get("cookies") if blob is not None else None
        if stored != cookies:
            deps.db.update_device_profile(
                profile["identity_key"], {"device_cookies_blob": vault.encrypt({"cookies": cookies})}
            )
    return profile["identity_key"]


def snapshot_restorable(snapshot: Dict[str, Any], identity_key: Optional[str]) -> bool:
    """Whether a slot's snapshot may go back to the slot as it is now.

    An account with no uid restores the slot's own snapshot, as before device
    profiles. One with a uid only gets a snapshot of that login: taken under
    its device, or, from before devices, logged in as that uid. What this
    keeps out is the previous login's session, which a swapped slot still has
    on file until the new login's first save.
    """
    if identity_key is None:
        return True
    if snapshot.get("identity_key"):
        return snapshot["identity_key"] == identity_key
    return snapshot.get("fb_user_id") == identity_key.split(":", 1)[1]


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
        vault = deps.get_vault()
        # The whole document is sealed as one blob: cookies, localStorage, and
        # origins alike. Splitting out "just the cookies" would leave the login
        # tokens Facebook also stashes in localStorage sitting in plaintext.
        state_blob = vault.encrypt(payload.storage_state)
        identity_key = _session_identity(vault, payload.device_id, payload.storage_state)
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
            "identity_key": identity_key,
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


@router.put(
    "/v1/workers/{worker_id}/session",
    response_model=StatusResponse,
    dependencies=[Depends(require_admin)],
)
def seed_session(worker_id: str, payload: SessionSeedRequest) -> StatusResponse:
    """Seal a pool account's cookie as this worker's restorable snapshot.

    The cookie-first assign (RS-308): rather than force a password login, the
    ERP hands the worker's account its own stored cookie here, and the worker
    restores it on a `restore` directive — logged in with no password and no
    2FA. This is the one route that accepts a live session from outside the
    fleet, so it is admin-only and audited like a credential release.

    The cookie must belong to the account the slot holds: its `c_user` has to
    equal the account's `fb_uid`, and the snapshot is filed under that
    account's `identity_key`, so a cookie can never be restored under another
    login (the same guard `restore_session` enforces on the way out).
    """
    account = deps.db.account_row_for_worker(worker_id)
    identity_key = identity_key_for(account)
    if account is None or identity_key is None:
        raise HTTPException(
            status_code=409,
            detail=f"Worker '{worker_id}' has no vault account with a Facebook uid; set one "
            "before seeding its session (the ERP's Assign to fleet does).",
        )
    fb_uid = identity_key.split(":", 1)[1]
    try:
        storage_state, c_user = storage_state_from_text(payload.cookie)
    except CookieError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if c_user != fb_uid:
        raise HTTPException(
            status_code=409,
            detail=f"The cookie is for Facebook user {c_user}, not the account's {fb_uid}; "
            "it belongs to a different login.",
        )

    try:
        state_blob = deps.get_vault().encrypt(storage_state)
    except VaultError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    deps.db.upsert_snapshot(
        worker_id,
        {
            "account_id": account["account_id"],
            "state_blob": state_blob,
            "user_agent": None,
            "session_expiry": None,
            "fb_user_id": c_user,
            "identity_key": identity_key,
        },
    )
    # The same disclosure class as a code or credential release, and for the
    # same reason: it is how a compromised console shows up in the audit log.
    deps.db.insert_code_audit(worker_id, account["account_id"], "session", payload.reason)
    logger.warning(
        "Seeded a session snapshot for worker %s (account %s) from a pool cookie (%s)",
        worker_id,
        account["account_id"],
        payload.reason or "no reason given",
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

      * Only a per-worker token for the path's worker gets in. A worker
        restores itself and nothing else (`require_own_worker`).
      * Once the slot's account has a uid, only a snapshot of that login
        (`snapshot_restorable`, 409 otherwise): never the session of the
        login the slot held before.

    See the module docstring for why that makes a restore safe on another host.
    """
    require_own_worker(worker, worker_id, "restore a session")

    snapshot = deps.db.get_snapshot(worker_id)
    if snapshot is None or snapshot.get("state_blob") is None:
        raise HTTPException(
            status_code=404,
            detail=f"No session snapshot for worker '{worker_id}'. It has never backed one up.",
        )
    identity_key = identity_key_for(deps.db.account_row_for_worker(worker_id))
    if not snapshot_restorable(snapshot, identity_key):
        raise HTTPException(
            status_code=409,
            detail=f"The session snapshot of worker '{worker_id}' is not the session of the "
            "account it holds now, so it is not restored.",
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
        "identity_key": identity_key,
        "fb_user_id": snapshot.get("fb_user_id"),
        "storage_state": storage_state,
        "user_agent": snapshot.get("user_agent"),
        "session_expiry": snapshot.get("session_expiry"),
        "backed_up_at": snapshot.get("backed_up_at"),
    }
