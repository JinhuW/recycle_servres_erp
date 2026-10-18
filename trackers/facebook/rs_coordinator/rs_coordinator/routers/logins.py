"""Which device each Facebook login was made on.

A worker opens a ledger row when it starts a login and closes it with the
outcome. The row names the account, its device profile and a fingerprint of the
`datr` the browser presented, so "what did Facebook see?" has an answer after
the fact. va-1 was locked on 2026-10-18 after four logins in 37 minutes, each
from a browser with a new `datr`; nothing recorded that, and nothing objected.

Two things act on the ledger as it is written:

* A login that starts on a `datr` other than the one the account's device
  profile holds is a new device to Facebook. That pages ops before it goes any
  further, because it is the pattern that locks accounts.
* A login that ends on Facebook's lock page marks the account locked, which
  stops the credentials route handing out its password until an operator has
  unlocked it on Facebook and run `rsc vault unlock`.
"""

import hashlib
import json
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException

from .. import deps
from ..deps import require_admin, require_worker
from ..device_profiles import identity_key_for
from ..schemas import LoginEvent
from ..telegram_notify import escape_markdown
from ..vault import VaultError
from .session import require_own_worker

logger = logging.getLogger(__name__)

router = APIRouter()


def datr_fingerprint(value: str) -> str:
    """The ledger's stand-in for a `datr`: enough to compare, useless to replay."""
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def _profile_datr_fp(identity_key: Optional[str]) -> Optional[str]:
    """The fingerprint of the `datr` the account's device profile holds, if any."""
    if not identity_key:
        return None
    profile = deps.db.get_device_profile(identity_key)
    blob = (profile or {}).get("device_cookies_blob")
    if blob is None:
        return None
    try:
        cookies = deps.get_vault().decrypt(blob).get("cookies") or []
    except VaultError:
        return None
    for cookie in cookies:
        if cookie.get("name") == "datr" and cookie.get("value"):
            return datr_fingerprint(str(cookie["value"]))
    return None


def _page_ops(text: str) -> None:
    try:
        deps.ops_notifier.send(text)
    except Exception:  # noqa: BLE001 - alerting is best effort by design
        logger.exception("Ops alert failed: %s", text)


@router.post("/v1/workers/{worker_id}/logins")
def login_event(
    worker_id: str, payload: LoginEvent, worker: Optional[str] = Depends(require_worker)
) -> Dict[str, Any]:
    require_own_worker(worker, worker_id, "record its logins")
    account = deps.db.account_row_for_worker(worker_id)
    account_id = account["account_id"] if account else None

    if payload.phase == "start":
        identity_key = identity_key_for(account)
        expected = _profile_datr_fp(identity_key)
        drift = bool(expected and payload.datr_fp and payload.datr_fp != expected)
        attempt_id = deps.db.insert_login_attempt(
            {
                "worker_id": worker_id,
                "account_id": account_id,
                "identity_key": identity_key,
                "device_id": payload.device_id,
                "datr_fp": payload.datr_fp,
                "device_drift": int(drift),
                "trigger": payload.trigger,
            }
        )
        if drift:
            logger.warning(
                "Worker %s is starting a login for %s on a datr its device does not hold",
                worker_id,
                account_id,
            )
            _page_ops(
                f"*New device:* `{escape_markdown(worker_id)}` is logging in to "
                f"`{escape_markdown(account_id or '?')}` with a `datr` its device profile "
                "does not hold. Facebook sees a new machine; repeated, this locks the account."
            )
        return {"attempt_id": attempt_id, "device_drift": drift}

    if payload.attempt_id is None or payload.outcome is None:
        raise HTTPException(status_code=400, detail="A finish needs attempt_id and outcome.")
    detail_json = json.dumps(payload.detail) if payload.detail else None
    if not deps.db.finish_login_attempt(
        payload.attempt_id, worker_id, payload.outcome, detail_json
    ):
        raise HTTPException(
            status_code=404,
            detail=f"No open login attempt {payload.attempt_id} for worker '{worker_id}'.",
        )
    if payload.outcome == "locked" and account_id:
        reason = str((payload.detail or {}).get("url") or "Facebook lock page")[:200]
        if deps.db.lock_account(account_id, reason):
            logger.warning("Account %s is locked by Facebook (worker %s)", account_id, worker_id)
            _page_ops(
                f"*Locked:* Facebook locked `{escape_markdown(account_id)}` "
                f"(`{escape_markdown(worker_id)}`). No worker gets its password until it is "
                "unlocked on Facebook and `rsc vault unlock` is run."
            )
    return {"attempt_id": payload.attempt_id, "outcome": payload.outcome}


@router.get("/v1/logins", dependencies=[Depends(require_admin)])
def list_logins(worker_id: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
    return {"logins": deps.db.list_login_attempts(worker_id, max(1, min(limit, 500)))}
