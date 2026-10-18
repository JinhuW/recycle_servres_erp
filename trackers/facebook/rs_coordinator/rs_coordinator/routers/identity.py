"""A worker asks which device it is before it opens a browser.

The answer is the device profile of the Facebook account its slot holds (see
`device_profiles`), the account's own `datr`/`sb` cookies, and whether the
slot's session snapshot may be restored onto it. A worker caches the answer in
its `/data`, so it boots the same browser when this service is down.
"""

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from .. import deps
from ..device_profiles import (
    device_cookies_of,
    generate_profile,
    identity_key_for,
    profile_out,
    seeded_profile,
)
from ..deps import require_worker
from ..schemas import DeviceCookiesReport, IdentityRequest
from ..vault import VaultError
from .session import fb_user_id_of, require_own_worker, snapshot_restorable

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/v1/workers/{worker_id}/identity")
def worker_identity(
    worker_id: str, payload: IdentityRequest, worker: Optional[str] = Depends(require_worker)
) -> Dict[str, Any]:
    """The device this worker's account presents, created on first ask.

    `device: null` means the slot's account has no uid, so no device: a worker
    drops a device it cached for an earlier login and keeps the browser it
    has. That is a 200, not a 404, because a worker must not mistake a
    coordinator without this route (an old one, a rollback) for "no device"
    and set its session aside. A profile is seeded from `observed` only when
    the slot's snapshot shows that same account logged in; anything else gets
    a new device, never the look of whichever login the browser held before.
    """
    require_own_worker(worker, worker_id, "read its device")
    account = deps.db.account_row_for_worker(worker_id)
    identity_key = identity_key_for(account)
    if account is None or identity_key is None:
        return {
            "worker_id": worker_id,
            "account_id": account["account_id"] if account else None,
            "identity_key": None,
            "device": None,
            "device_cookies": None,
            "session": None,
            "reason": "The slot's vault account has no Facebook uid. The ERP's Assign to "
            "fleet sets it, as does `rsc vault set-account --fb-uid`.",
        }
    fb_uid = identity_key.split(":", 1)[1]

    try:
        vault = deps.get_vault()
        snapshot = deps.db.get_snapshot(worker_id)
        profile = deps.db.get_device_profile(identity_key)
        if profile is None:
            state = (
                vault.decrypt(snapshot["state_blob"])
                if snapshot and snapshot.get("state_blob") is not None
                else None
            )
            own_session = fb_user_id_of(state) == fb_uid
            if payload.observed is not None and own_session:
                record = seeded_profile(fb_uid, payload.observed.model_dump())
            else:
                record = generate_profile(fb_uid, account.get("region"))
            cookies = device_cookies_of(state) if own_session else []
            if cookies:
                record["device_cookies_blob"] = vault.encrypt({"cookies": cookies})
            if deps.db.insert_device_profile(record):
                logger.info(
                    "Created %s device %s for %s on worker %s",
                    record["source"],
                    record["device_id"],
                    identity_key,
                    worker_id,
                )
            profile = deps.db.get_device_profile(identity_key)
        assert profile is not None
        blob = profile.get("device_cookies_blob")
        device_cookies = vault.decrypt(blob).get("cookies") if blob is not None else None
    except VaultError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    session = None
    if snapshot and snapshot.get("state_blob") is not None:
        session = {
            "identity_key": snapshot.get("identity_key"),
            "fb_user_id": snapshot.get("fb_user_id"),
            "backed_up_at": snapshot.get("backed_up_at"),
            "restorable": snapshot_restorable(snapshot, identity_key),
        }
    return {
        "worker_id": worker_id,
        "account_id": account["account_id"],
        "identity_key": identity_key,
        "device": profile_out(profile),
        "device_cookies": device_cookies or None,
        "session": session,
    }


@router.post("/v1/workers/{worker_id}/identity/device-cookies")
def report_device_cookies(
    worker_id: str, payload: DeviceCookiesReport, worker: Optional[str] = Depends(require_worker)
) -> Dict[str, Any]:
    """Record the device cookies of an account that has none yet; first writer wins.

    Before this, an account's `datr` was only learned from a logged-in backup,
    so an account that had not yet completed a login was handed a brand-new
    device on every attempt. Six of those in a row read as six machines
    trying one account, and Facebook locked it (va-1, 2026-10-18). Now the
    first page Facebook serves fixes the device, and every later attempt, on
    any worker, presents it. A logged-in backup still keeps it current.

    The answer is the stored cookies either way, so a worker that lost the race
    adopts the winner's for its next attempt. 409 when the worker's device is
    no longer its account's: the slot has been given another login since.
    """
    require_own_worker(worker, worker_id, "record its device")
    identity_key = identity_key_for(deps.db.account_row_for_worker(worker_id))
    profile = deps.db.get_device_profile(identity_key) if identity_key else None
    if profile is None or profile["device_id"] != payload.device_id:
        raise HTTPException(
            status_code=409,
            detail=f"Device {payload.device_id} is not the device of the account worker "
            f"'{worker_id}' holds now; ask for its identity again.",
        )
    cookies = [c.model_dump() for c in payload.cookies]
    try:
        vault = deps.get_vault()
        if not deps.db.claim_device_cookies(identity_key, vault.encrypt({"cookies": cookies})):
            stored = deps.db.get_device_profile(identity_key) or {}
            blob = stored.get("device_cookies_blob")
            return {
                "stored": False,
                "device_cookies": vault.decrypt(blob).get("cookies") if blob is not None else None,
            }
    except VaultError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    logger.info("Recorded the device cookies of %s from worker %s", identity_key, worker_id)
    return {"stored": True, "device_cookies": cookies}
