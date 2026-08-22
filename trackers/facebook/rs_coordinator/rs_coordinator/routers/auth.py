"""Verification codes and credentials for workers.

Workers hold no account secrets. When Facebook prompts one for a second factor
it asks here, uses the code, and forgets it — the secret that mints codes stays
in the control plane's vault. The same goes for the password fallback, which is
off unless an account opts into it.

Every release is written to the code audit log. That log is the only way to
notice a worker asking for codes it should not need (a compromised VM looks
exactly like a busy one otherwise), so it is written on every release.

Both routes here require a *per-worker* token. The legacy fleet-wide token is
refused, for the same reason `session.restore` refuses it: it is shared by every
container in the fleet, so it proves nothing about who is calling, and anything
that trusted its `account_id` would let one compromised VM mint second factors
for every account in the vault. Workers already carry a per-worker token for
these calls (`ControlPlaneClient`); the fleet token only feeds the listing
notification channel.
"""

import logging
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException

from .. import code_service, deps
from ..deps import require_worker
from ..schemas import (
    CodeRequest,
    CodeResponse,
    CredentialsRequest,
    CredentialsResponse,
)
from ..vault import VaultError

logger = logging.getLogger(__name__)

router = APIRouter()

# The audit `kind` for a credentials release. Not a CodeKind: it is not a code,
# but it belongs in the same log because it is the same class of disclosure.
PASSWORD_KIND = "password"


def _resolve(worker: Optional[str], claimed_worker: Optional[str]) -> Tuple[str, str]:
    """The (worker_id, account_id) this request may speak for.

    The token is the only thing consulted. A per-worker token pins the account
    no matter what the body claims, so a worker can never ask for another
    account's secrets, and the fleet-wide token — which identifies nobody — is
    refused outright rather than being allowed to name a worker or an account.

    A body that names a different worker is logged and then ignored, not
    refused: the token is already authoritative, and failing the request would
    turn a stale `worker_id` in a config file into a login that cannot complete
    its second factor — at the exact moment a human is not watching.
    """
    if worker is None:
        raise HTTPException(
            status_code=403,
            detail="Releasing codes or credentials requires a per-worker token. The "
            "fleet-wide token is shared by every worker, so it cannot prove which "
            "worker is calling. Mint one with `rsc mint-token --worker <worker-id>`.",
        )
    if claimed_worker and claimed_worker != worker:
        logger.warning(
            "Worker %s asked for secrets as %s; serving %s (its token pins it).",
            worker,
            claimed_worker,
            worker,
        )
    return worker, deps.resolve_account(worker)


@router.post("/api/v1/auth/code", response_model=CodeResponse)
@router.post("/v1/auth/code", response_model=CodeResponse)
def issue_code(
    payload: CodeRequest, worker: Optional[str] = Depends(require_worker)
) -> CodeResponse:
    worker_id, account_id = _resolve(worker, payload.worker_id)

    try:
        code, expires_in = code_service.get_code(account_id, payload.kind, payload.since)
    except code_service.CodeUnavailable as e:
        # Expected: no secret stored yet, or an inbox with nothing in it. The
        # worker's move is to retry or escalate, not to treat this as an outage.
        raise HTTPException(status_code=404, detail=str(e)) from e
    except VaultError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    deps.db.insert_code_audit(worker_id, account_id, payload.kind.value, payload.reason)
    logger.info(
        "Released a %s code for account %s to worker %s (%s)",
        payload.kind.value,
        account_id,
        worker_id,
        payload.reason or "no reason given",
    )
    return CodeResponse(code=code, expires_in=expires_in, kind=payload.kind)


@router.post("/api/v1/auth/credentials", response_model=CredentialsResponse)
@router.post("/v1/auth/credentials", response_model=CredentialsResponse)
def issue_credentials(
    payload: CredentialsRequest, worker: Optional[str] = Depends(require_worker)
) -> CredentialsResponse:
    """Hand a worker the account's login, if that account allows it at all.

    Session cookies are the intended path; a password login is a fresh login
    from a new IP, which is exactly what trips a checkpoint. So it is opt-in per
    account and audited like a code release.
    """
    worker_id, account_id = _resolve(worker, payload.worker_id)

    store = deps.get_account_store()
    try:
        account = store.get_account(account_id)
        if account is None:
            raise HTTPException(status_code=404, detail=f"No account '{account_id}' in the vault.")
        if not account.get("allow_password_login"):
            raise HTTPException(
                status_code=403,
                detail=f"Password login is disabled for account '{account_id}'. Restore its "
                "session instead, or enable it deliberately with "
                "`rsc vault set-account <account> --allow-password-login`.",
            )
        secrets = store.get_secret(account_id)
    except VaultError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    # The Facebook login is the account's own username; the vault's `email` is
    # the recovery inbox and is not interchangeable with it.
    username = account.get("fb_username")
    password = secrets.get("password")
    if not username or not password:
        raise HTTPException(
            status_code=404,
            detail=f"Account '{account_id}' allows password login but has no username or "
            "password stored. Set them with `rsc vault set-account`.",
        )

    deps.db.insert_code_audit(worker_id, account_id, PASSWORD_KIND, payload.reason)
    # Log that it happened and for whom — never the credential itself.
    logger.warning(
        "Released credentials for account %s to worker %s (%s)",
        account_id,
        worker_id,
        payload.reason or "no reason given",
    )
    return CredentialsResponse(username=str(username), password=str(password))
