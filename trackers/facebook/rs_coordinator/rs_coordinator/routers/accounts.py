"""The vault's accounts, as the console may see them.

`rsc vault list` already prints this view on the VM: who the account is,
which worker it belongs to, and *which* secrets are stored for it. The
dashboards want the same answer per worker, so it is served here on the admin
token — identity and presence flags only. No secret value, and no proxy URL
(those carry credentials), ever leaves this route; `AccountOut` is built field
by field rather than from the row so a column added later cannot quietly start
being served.
"""

from fastapi import APIRouter, Depends

from .. import deps
from ..deps import require_admin
from ..schemas import AccountList, AccountOut
from ..vault import SECRET_FIELDS, VaultError

router = APIRouter()


@router.get("/v1/accounts", response_model=AccountList, dependencies=[Depends(require_admin)])
def list_accounts() -> AccountList:
    store = deps.get_account_store()
    out = []
    for row in store.list_accounts():
        account_id = str(row["account_id"])
        try:
            stored = store.get_secret(account_id)
        except VaultError:
            # A rotated or missing vault key: the account still exists and its
            # identity is still worth showing; only the presence flags are lost.
            stored = {}
        out.append(
            AccountOut(
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
        )
    return AccountList(accounts=out)
