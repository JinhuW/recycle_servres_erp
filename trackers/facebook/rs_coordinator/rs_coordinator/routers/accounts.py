"""The vault's accounts, as the console may see and change them.

`rsc vault list` already prints this view on the VM: who the account is,
which worker it belongs to, and *which* secrets are stored for it. The
dashboards want the same answer per worker, so it is served here on the admin
token — identity and presence flags only. No secret value, and no proxy URL
(those carry credentials), ever leaves this route; `AccountOut` is built field
by field rather than from the row so a column added later cannot quietly start
being served.

The writes (POST to create, PATCH to change) let the ERP's Account Pool page
keep the pool by hand instead of `rsc vault set-account` on the VM. Secrets are
write-only through them: a value goes in, and only its presence comes back.
The console token that reaches them is the one fleet credential living off the
VM, so they deliberately cannot:

- delete an account (`rsc vault rm` only);
- turn password release on. `allow_password_login` is CLI-only, and moving an
  account to another worker turns it off, so a re-assignment never hands a
  stored password to a different machine;
- set the proxy or the VNC link (the link is pasted into Telegram alerts);
- point the mailbox somewhere new without re-sending its password. The code
  service combines what is stored, so a changed host plus the *stored* password
  would ship that password to whoever runs the host.

A re-assignment still lets the new worker mint the account's codes, so every
one raises an ops alert naming who made it.
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from .. import deps
from ..deps import require_admin
from ..schemas import AccountCreate, AccountList, AccountOut, AccountWrite
from ..telegram_notify import escape_markdown
from ..vault import SECRET_FIELDS, AccountStore, VaultError

logger = logging.getLogger(__name__)

router = APIRouter()

# The same shape worker ids take everywhere else, plus `@` for accounts named
# after their login e-mail.
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$")

# The plain fields a console write may set or clear.
_PLAIN_FIELDS = ("fb_username", "worker_id", "region")

# Changing any of these points the code service at a mailbox, so the password
# for that mailbox has to come with the change (see the module docstring).
_MAILBOX_FIELDS = ("email", "imap_host", "imap_port")


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


def _saved(store: AccountStore, account_id: str) -> AccountOut:
    row = store.get_account(account_id)
    assert row is not None, "an account just written must be readable"
    return _account_out(store, row)


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _check_id(value: str, what: str) -> None:
    if not _ID.match(value):
        raise _unprocessable(
            f"{what} '{value}' is not valid: use letters, digits, '.', '_', '-' or '@', "
            "starting with a letter or digit."
        )


def _plain_changes(body: AccountWrite) -> Tuple[Dict[str, str], List[str]]:
    """(values to set, fields to clear) for the plain fields the body names.

    Blank counts as clear, so an emptied form field means what it looks like.
    """
    values: Dict[str, str] = {}
    clears: List[str] = []
    for name in _PLAIN_FIELDS:
        if name not in body.model_fields_set:
            continue
        value = (getattr(body, name) or "").strip()
        if value:
            values[name] = value
        else:
            clears.append(name)
    if "worker_id" in values:
        _check_id(values["worker_id"], "Worker")
    return values, clears


def _normalized_totp(raw: str) -> str:
    # Imported here, as code_service does, so pyotp stays off the import path
    # of every route that never mints a code.
    from ..code_service import CodeUnavailable
    from ..totp_code import normalize_totp_secret

    try:
        return normalize_totp_secret(raw)
    except CodeUnavailable:
        raise _unprocessable(
            "That TOTP key cannot produce codes. Paste the key Facebook shows (letters "
            "A-Z and digits 2-7; spaces are fine) or the whole otpauth:// URI."
        ) from None


def _secret_changes(body: AccountWrite) -> Dict[str, Optional[str]]:
    """The validated secret changes: a value to store, or None to remove one."""
    changes: Dict[str, Optional[str]] = {}
    for field, value in body.secrets.items():
        if field not in SECRET_FIELDS:
            raise _unprocessable(
                f"Unknown secret field '{field}'. Known: {', '.join(SECRET_FIELDS)}."
            )
        if value is None:
            changes[field] = None
            continue
        value = value.strip()
        if not value:
            raise _unprocessable(f"'{field}' is empty; send null to remove a stored secret.")
        changes[field] = value

    # Only a new value can point somewhere new: a cleared host falls back to
    # the well-known one for the stored address, a cleared port to the default,
    # and a cleared address switches mailbox codes off.
    if any(changes.get(field) for field in _MAILBOX_FIELDS) and not changes.get("email_password"):
        raise _unprocessable(
            "Changing the mailbox address, IMAP host or IMAP port needs the mailbox "
            "password in the same save, so a stored password is never sent to a "
            "different server."
        )
    if changes.get("totp_secret"):
        changes["totp_secret"] = _normalized_totp(changes["totp_secret"])
    port = changes.get("imap_port")
    if port and not (port.isdigit() and 1 <= int(port) <= 65535):
        raise _unprocessable(f"IMAP port '{port}' is not a port number (1-65535).")
    return changes


def _check_worker_free(store: AccountStore, worker_id: str, account_id: str) -> None:
    # Nothing in the table stops two accounts naming one worker, and the code
    # service would then pick whichever row comes first.
    holder = store.account_for_worker(worker_id)
    if holder is not None and holder != account_id:
        raise HTTPException(
            status_code=409,
            detail=f"Worker '{worker_id}' already has account '{holder}'. Un-assign that one first.",
        )


def _log_write(
    action: str,
    account_id: str,
    actor: str,
    values: Dict[str, str],
    clears: List[str],
    secrets: Dict[str, Optional[str]],
) -> None:
    # Field names only: the values include secrets.
    changed = sorted(values) + [f"-{name}" for name in clears] + [
        f"secret:{name}" if value is not None else f"-secret:{name}"
        for name, value in sorted(secrets.items())
    ]
    logger.info(
        "Account %s %s by %r: %s", account_id, action, actor, ", ".join(changed) or "no fields"
    )


def _alert_reassignment(
    account_id: str,
    old_worker: Optional[str],
    new_worker: Optional[str],
    actor: str,
    password_login_dropped: bool,
) -> None:
    lines = [
        f"Account {account_id} moved: {old_worker or 'pool'} -> {new_worker or 'pool'}",
        f"by {actor}, from the console.",
    ]
    if password_login_dropped:
        lines.append(
            "Its password login was turned off; re-enable it on the VM "
            "(rsc vault set-account --allow-password-login) if the move was intended."
        )
    try:
        deps.ops_notifier.send(escape_markdown("\n".join(lines)))
    except Exception:  # noqa: BLE001 - a broken Telegram must not undo a saved change
        logger.exception("Ops alert failed for the re-assignment of account %s", account_id)


@router.post(
    "/v1/accounts",
    response_model=AccountOut,
    status_code=201,
    dependencies=[Depends(require_admin)],
)
def create_account(body: AccountCreate, background: BackgroundTasks) -> AccountOut:
    store = deps.get_account_store()
    account_id = body.account_id.strip()
    _check_id(account_id, "Account")
    if store.get_account(account_id) is not None:
        raise HTTPException(
            status_code=409, detail=f"Account '{account_id}' already exists; edit it instead."
        )
    values, _ = _plain_changes(body)
    # A new account has nothing stored yet, so a null here removes nothing.
    secrets = {k: v for k, v in _secret_changes(body).items() if v is not None}
    worker = values.get("worker_id")
    if worker:
        _check_worker_free(store, worker, account_id)

    try:
        store.put_account(account_id, secrets or None, allow_password_login=False, **values)
    except VaultError as e:
        raise HTTPException(status_code=409, detail=str(e)) from None

    _log_write("created", account_id, body.changed_by, values, [], secrets)
    if worker:
        background.add_task(_alert_reassignment, account_id, None, worker, body.changed_by, False)
    return _saved(store, account_id)


@router.patch(
    "/v1/accounts/{account_id}",
    response_model=AccountOut,
    dependencies=[Depends(require_admin)],
)
def update_account(account_id: str, body: AccountWrite, background: BackgroundTasks) -> AccountOut:
    store = deps.get_account_store()
    existing = store.get_account(account_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"No account '{account_id}' in the vault.")
    values, clears = _plain_changes(body)
    secrets = _secret_changes(body)

    old_worker = existing.get("worker_id")
    new_worker = values.get("worker_id", None if "worker_id" in clears else old_worker)
    moved = new_worker != old_worker
    if moved and new_worker:
        _check_worker_free(store, new_worker, account_id)
    had_password_login = bool(existing["allow_password_login"])

    try:
        store.put_account(
            account_id,
            secrets or None,
            allow_password_login=had_password_login and not moved,
            clear_fields=clears,
            **values,
        )
    except VaultError as e:
        raise HTTPException(status_code=409, detail=str(e)) from None

    _log_write("updated", account_id, body.changed_by, values, clears, secrets)
    if moved:
        background.add_task(
            _alert_reassignment,
            account_id,
            old_worker,
            new_worker,
            body.changed_by,
            had_password_login,
        )
    return _saved(store, account_id)
