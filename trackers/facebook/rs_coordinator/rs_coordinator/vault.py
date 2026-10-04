"""Encrypted secret storage for the fleet's Facebook accounts.

Every account's password, email login, and TOTP secret lives here — encrypted
at rest with a Fernet key that is only ever held in the control plane's memory
(read from RS_VAULT_KEY). Workers hold none of it; they ask for a code or, when
policy allows, transient credentials at the moment they need them.

Consolidating the secrets is the point of the control plane and also its main
risk, so the rules are: encrypted on disk, key from the environment, and the
non-secret account fields kept separate from the sealed blob so listing
accounts never touches plaintext.
"""

import json
import os
from typing import Any, Dict, List, Optional

from .db import Database

ENV_KEY = "RS_VAULT_KEY"

# Secret fields sealed into the encrypted blob. Anything not in here is stored
# as a plain column and is safe to show in a listing.
SECRET_FIELDS = (
    "password",
    "email",
    "email_password",
    "totp_secret",
    "imap_host",
    "imap_port",
)


class VaultError(RuntimeError):
    pass


def generate_key() -> str:
    """A fresh Fernet key, for `rsc vault init`."""
    from cryptography.fernet import Fernet

    return Fernet.generate_key().decode()


class Vault:
    """Symmetric encryption for secrets at rest."""

    def __init__(self: "Vault", key: str | bytes | None = None) -> None:
        raw = key or os.environ.get(ENV_KEY)
        if not raw:
            raise VaultError(
                f"{ENV_KEY} is not set. Generate one with `rsc vault init` and put it in "
                "the control plane's environment — without it no secret can be read."
            )
        from cryptography.fernet import Fernet

        try:
            self._fernet = Fernet(raw if isinstance(raw, bytes) else raw.encode())
        except (ValueError, TypeError) as e:
            raise VaultError(f"{ENV_KEY} is not a valid Fernet key: {e}") from e

    def seal_str(self: "Vault", text: str) -> bytes:
        return self._fernet.encrypt(text.encode())

    def open_str(self: "Vault", blob: bytes) -> str:
        from cryptography.fernet import InvalidToken

        try:
            return self._fernet.decrypt(bytes(blob)).decode()
        except InvalidToken as e:
            raise VaultError(
                "Could not decrypt — the vault key does not match the one used to store "
                "this secret."
            ) from e

    def encrypt(self: "Vault", payload: Dict[str, Any]) -> bytes:
        return self.seal_str(json.dumps(payload))

    def decrypt(self: "Vault", blob: bytes) -> Dict[str, Any]:
        return json.loads(self.open_str(blob))


class AccountStore:
    """Accounts and their secrets, with the sealed blob handled transparently."""

    def __init__(self: "AccountStore", db: Database, vault: Vault) -> None:
        self.db = db
        self.vault = vault

    def put_account(
        self: "AccountStore",
        account_id: str,
        secrets: Dict[str, Any] | None = None,
        *,
        worker_id: str | None = None,
        fb_username: str | None = None,
        region: str | None = None,
        proxy: str | None = None,
        vnc_url: str | None = None,
        allow_password_login: bool = False,
        merge_secrets: bool = True,
    ) -> None:
        """Create or update an account.

        `merge_secrets` keeps any previously stored secret that this call does
        not mention, so updating just a proxy never silently drops the TOTP
        secret.
        """
        payload: Dict[str, Any] = {}
        if merge_secrets:
            existing = self.db.get_account_row(account_id)
            if existing and existing.get("secret_blob"):
                payload.update(self.vault.decrypt(existing["secret_blob"]))
        for field, value in (secrets or {}).items():
            if field not in SECRET_FIELDS:
                raise VaultError(
                    f"Unknown secret field '{field}'. Known: {', '.join(SECRET_FIELDS)}"
                )
            if value is None:
                payload.pop(field, None)
            else:
                payload[field] = value

        fields: Dict[str, Any] = {
            "allow_password_login": 1 if allow_password_login else 0,
            "secret_blob": self.vault.encrypt(payload),
        }
        for name, value in (
            ("worker_id", worker_id),
            ("fb_username", fb_username),
            ("region", region),
            ("proxy", proxy),
            ("vnc_url", vnc_url),
        ):
            if value is not None:
                fields[name] = value
        self.db.put_account(account_id, fields)

    def get_account(self: "AccountStore", account_id: str) -> Optional[Dict[str, Any]]:
        """Non-secret account fields. Never returns the sealed blob."""
        row = self.db.get_account_row(account_id)
        if row is None:
            return None
        row = dict(row)
        row.pop("secret_blob", None)
        row["allow_password_login"] = bool(row.get("allow_password_login"))
        return row

    def get_secret(self: "AccountStore", account_id: str) -> Dict[str, Any]:
        row = self.db.get_account_row(account_id)
        if row is None:
            raise VaultError(f"No account '{account_id}' in the vault.")
        blob = row.get("secret_blob")
        return self.vault.decrypt(blob) if blob else {}

    def account_for_worker(self: "AccountStore", worker_id: str) -> Optional[str]:
        row = self.db.account_row_for_worker(worker_id)
        return row["account_id"] if row else None

    def list_accounts(self: "AccountStore") -> List[Dict[str, Any]]:
        return self.db.list_accounts()

    def delete_account(self: "AccountStore", account_id: str) -> bool:
        return self.db.delete_account(account_id)
