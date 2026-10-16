"""The vault's accounts, as the console may see and set them.

`rsc vault list` already prints this view on the VM: who the account is,
which worker it belongs to, and *which* secrets are stored for it. The
dashboards want the same answer per worker, so it is served here on the admin
token — identity and presence flags only. No secret value, and no proxy URL
(those carry credentials), ever leaves this route; `AccountOut` is built field
by field rather than from the row so a column added later cannot quietly start
being served.

The write half (`PUT`) is what lets an operator set a worker's Facebook login,
password and 2FA secret from the ERP instead of `rsc vault set-account` on the
VM — the credentials the worker then uses when "Re-login" is pressed. It is
deliberately blind: a value goes in, a presence flag comes out, and the audit
log names the fields that changed, never what they changed to.
"""

import logging
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException

from .. import deps
from ..deps import require_admin
from ..schemas import ACCOUNT_ID_PATTERN, AccountList, AccountOut, AccountUpsert
from ..totp import normalize_totp_secret
from ..vault import SECRET_FIELDS, AccountStore, VaultError

logger = logging.getLogger(__name__)

router = APIRouter()

_ACCOUNT_ID = re.compile(ACCOUNT_ID_PATTERN)


def _account_out(store: AccountStore, row: Dict[str, Any]) -> AccountOut:
    account_id = str(row["account_id"])
    try:
        stored = store.get_secret(account_id)
    except VaultError:
        # A rotated or missing vault key: the account still exists and its
        # identity is still worth showing; only the presence flags are lost.
        stored = {}
    return AccountOut(
        account_id=account_id,
        worker_id=row.get("worker_id"),
        fb_username=row.get("fb_username"),
        region=row.get("region"),
        vnc_url=row.get("vnc_url"),
        allow_password_login=bool(row.get("allow_password_login")),
        proxy_configured=bool(row.get("proxy")),
        secrets={field: bool(stored.get(field)) for field in SECRET_FIELDS},
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )


@router.get("/v1/accounts", response_model=AccountList, dependencies=[Depends(require_admin)])
def list_accounts() -> AccountList:
    store = deps.get_account_store()
    return AccountList(accounts=[_account_out(store, row) for row in store.list_accounts()])


def _secret_changes(payload: AccountUpsert) -> Dict[str, Optional[str]]:
    """The secret fields this request actually changes.

    Unknown field names are refused rather than dropped: a typo in the ERP
    that silently stored nothing would read as "the password is set" to a
    person who just typed it in.
    """
    changes: Dict[str, Optional[str]] = {}
    for field, value in payload.secrets.items():
        if field not in SECRET_FIELDS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown secret field '{field}'. Known: {', '.join(SECRET_FIELDS)}",
            )
        if value is None:
            changes[field] = None
            continue
        if value == "":
            # A form's blank password box: keep what is stored.
            continue
        if len(value) > 2048:
            raise HTTPException(status_code=400, detail=f"'{field}' is too long to be a secret.")
        if field == "totp_secret":
            try:
                value = normalize_totp_secret(value)
            except VaultError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
        changes[field] = value
    return changes


@router.put(
    "/v1/accounts/{account_id}",
    response_model=AccountOut,
    dependencies=[Depends(require_admin)],
)
def put_account(account_id: str, payload: AccountUpsert) -> AccountOut:
    """Create or update a vault account from the console.

    The one rule beyond "merge what was sent": a worker belongs to one account.
    Registering a worker that another account already owns is refused (409)
    rather than silently stolen — the worker's 2FA codes and credentials would
    start coming from a different Facebook account than the one it logged in
    as, which is the kind of mix-up that gets an account checkpointed.
    """
    if not _ACCOUNT_ID.match(account_id):
        raise HTTPException(
            status_code=400,
            detail="account_id may use letters, digits and . _ @ - only (up to 64 characters).",
        )
    secrets = _secret_changes(payload)
    store = deps.get_account_store()

    if payload.worker_id:
        owner = store.db.account_row_for_worker(payload.worker_id)
        if owner and str(owner["account_id"]) != account_id:
            raise HTTPException(
                status_code=409,
                detail=f"Worker '{payload.worker_id}' already belongs to account "
                f"'{owner['account_id']}'. Edit that account instead, or detach the worker "
                "from it with `rsc vault set-account` first.",
            )

    try:
        existing = store.get_account(account_id)
        allow_password_login = (
            bool(existing["allow_password_login"]) if existing else False
        )
        if payload.allow_password_login is not None:
            allow_password_login = payload.allow_password_login
        store.put_account(
            account_id,
            secrets or None,
            worker_id=payload.worker_id or None,
            fb_username=payload.fb_username or None,
            region=payload.region or None,
            allow_password_login=allow_password_login,
            merge_secrets=True,
        )
        row = store.db.get_account_row(account_id)
    except VaultError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    if row is None:  # pragma: no cover - the upsert just wrote it
        raise HTTPException(status_code=500, detail="The account was not stored.")

    # Field names only: this line is the audit trail of who changed what, and a
    # value in it would put the secret in every log shipper downstream.
    changed: List[str] = [
        name
        for name, value in (
            ("worker_id", payload.worker_id),
            ("fb_username", payload.fb_username),
            ("region", payload.region),
            ("allow_password_login", payload.allow_password_login),
        )
        if value is not None and value != ""
    ]
    logger.warning(
        "Console %s account %s: fields=%s secrets_set=%s secrets_cleared=%s",
        "updated" if existing else "created",
        account_id,
        ",".join(changed) or "-",
        ",".join(f for f, v in secrets.items() if v is not None) or "-",
        ",".join(f for f, v in secrets.items() if v is None) or "-",
    )
    return _account_out(store, dict(row))
