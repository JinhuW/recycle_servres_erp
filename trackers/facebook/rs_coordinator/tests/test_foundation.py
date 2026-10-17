"""Foundation: the vault, worker tokens, and the new control-plane tables.

Every other stream builds on these, so this file pins the contracts they rely
on — secrets encrypted at rest, tokens scoped to one worker, and the schema
migrating cleanly onto a database created before the control plane existed.
"""

import sqlite3

import pytest

from rs_coordinator.code_service import CodeUnavailable, get_code
from rs_coordinator.db import SCHEMA, Database
from rs_coordinator.tokens import (
    TokenError,
    generate_secret,
    mint_worker_token,
    verify_worker_token,
)
from rs_coordinator.vault import AccountStore, Vault, VaultError, generate_key

SECRET = "test-hmac-secret"


@pytest.fixture()
def vault():
    return Vault(generate_key())


@pytest.fixture()
def store(vault):
    return AccountStore(Database(":memory:"), vault)


# -- vault -----------------------------------------------------------------


def test_secrets_round_trip(vault):
    payload = {"password": "hunter2", "totp_secret": "JBSWY3DPEHPK3PXP"}
    blob = vault.encrypt(payload)
    assert blob != str(payload).encode()  # not plaintext
    assert vault.decrypt(blob) == payload


def test_a_different_key_cannot_read_the_secret(vault):
    blob = vault.encrypt({"password": "hunter2"})
    with pytest.raises(VaultError, match="does not match"):
        Vault(generate_key()).decrypt(blob)


def test_missing_key_is_an_actionable_error(monkeypatch):
    monkeypatch.delenv("RS_VAULT_KEY", raising=False)
    with pytest.raises(VaultError, match="RS_VAULT_KEY"):
        Vault()


def test_account_round_trip_and_listing_hides_secrets(store):
    store.put_account(
        "denver",
        {"password": "pw", "totp_secret": "JBSWY3DPEHPK3PXP"},
        worker_id="denver-1",
        fb_username="a@example.com",
        region="rs_mountain",
        allow_password_login=True,
    )

    account = store.get_account("denver")
    assert account["fb_username"] == "a@example.com"
    assert account["allow_password_login"] is True
    assert "secret_blob" not in account

    assert store.get_secret("denver")["totp_secret"] == "JBSWY3DPEHPK3PXP"
    assert store.account_for_worker("denver-1") == "denver"

    listed = store.list_accounts()
    assert len(listed) == 1
    assert "secret_blob" not in listed[0]


def test_updating_one_field_keeps_the_other_secrets(store):
    store.put_account("denver", {"password": "pw", "totp_secret": "SEED"})
    # A later call that only sets a proxy must not wipe the stored secrets.
    store.put_account("denver", proxy="http://p:8080")

    secret = store.get_secret("denver")
    assert secret["password"] == "pw"
    assert secret["totp_secret"] == "SEED"
    assert store.get_account("denver")["proxy"] == "http://p:8080"


def test_a_secret_can_be_explicitly_cleared(store):
    store.put_account("denver", {"password": "pw", "totp_secret": "SEED"})
    store.put_account("denver", {"totp_secret": None})
    assert "totp_secret" not in store.get_secret("denver")
    assert store.get_secret("denver")["password"] == "pw"


def test_unknown_secret_field_is_rejected(store):
    with pytest.raises(VaultError, match="Unknown secret field"):
        store.put_account("denver", {"api_key": "nope"})


def test_secrets_are_encrypted_in_the_database_file(store):
    store.put_account("denver", {"password": "super-secret-value"})
    raw = store.db.get_account_row("denver")["secret_blob"]
    assert b"super-secret-value" not in bytes(raw)


def test_missing_account_reports_clearly(store):
    assert store.get_account("nope") is None
    with pytest.raises(VaultError, match="No account"):
        store.get_secret("nope")


# -- tokens ----------------------------------------------------------------


def test_token_round_trip():
    token = mint_worker_token("denver-1", SECRET)
    assert verify_worker_token(token, SECRET) == "denver-1"


def test_token_is_scoped_to_one_worker():
    token = mint_worker_token("denver-1", SECRET)
    # Swapping the worker id invalidates the signature — a stolen token cannot
    # be used to impersonate another worker.
    forged = "tx-1." + token.split(".", 1)[1]
    assert verify_worker_token(forged, SECRET) is None


@pytest.mark.parametrize("bad", [None, "", "no-dot", "denver-1.deadbeef"])
def test_bad_tokens_are_rejected(bad):
    assert verify_worker_token(bad, SECRET) is None


def test_rotating_the_secret_revokes_every_token():
    token = mint_worker_token("denver-1", SECRET)
    assert verify_worker_token(token, generate_secret()) is None


def test_worker_id_with_a_dot_is_refused():
    with pytest.raises(TokenError):
        mint_worker_token("bad.id", SECRET)


# -- schema / migration ----------------------------------------------------


def test_control_plane_tables_exist():
    db = Database(":memory:")
    with db.cursor() as cur:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {row["name"] for row in cur.fetchall()}
    assert {"accounts", "challenges", "session_snapshots", "code_audit"} <= tables


def test_migration_adds_health_columns_to_an_old_database(tmp_path):
    """A database created before the control plane must upgrade in place."""
    path = tmp_path / "old.db"
    legacy = sqlite3.connect(path)
    legacy.executescript(
        """
        CREATE TABLE workers (
            worker_id TEXT PRIMARY KEY, region TEXT, status TEXT,
            detail_json TEXT, last_heartbeat_at TEXT, last_listing_at TEXT
        );
        """
    )
    legacy.execute("INSERT INTO workers (worker_id, region) VALUES ('denver-1', 'rs_mountain')")
    legacy.commit()
    legacy.close()

    db = Database(path)
    columns = {row["name"] for row in db._conn.execute("PRAGMA table_info(workers)")}
    assert {"state", "account_id", "session_expiry", "error_count", "vnc_url"} <= columns
    # The pre-existing row survives the migration.
    assert db.get_worker("denver-1")["region"] == "rs_mountain"


def test_migration_is_idempotent(tmp_path):
    path = tmp_path / "twice.db"
    Database(path).close()
    Database(path).close()  # second open must not raise "duplicate column"


def test_update_worker_health_is_partial():
    db = Database(":memory:")
    db.update_worker_health("denver-1", {"state": "HEALTHY", "error_count": 0})
    db.update_worker_health("denver-1", {"error_count": 3})
    row = db.get_worker("denver-1")
    assert row["state"] == "HEALTHY"  # untouched by the second call
    assert row["error_count"] == 3


def test_challenge_lifecycle():
    db = Database(":memory:")
    cid = db.insert_challenge({"worker_id": "denver-1", "kind": "captcha"})
    assert db.get_challenge(cid)["status"] == "open"
    assert [c["id"] for c in db.list_challenges("open")] == [cid]

    assert db.resolve_challenge(cid, "jinhu") is True
    assert db.get_challenge(cid)["status"] == "resolved"
    assert db.list_challenges("open") == []
    # Already resolved — a second resolve is a no-op, not an error.
    assert db.resolve_challenge(cid, "jinhu") is False


def test_snapshot_and_audit_round_trip():
    db = Database(":memory:")
    db.upsert_snapshot("denver-1", {"account_id": "denver", "state_blob": b"sealed"})
    assert db.get_snapshot("denver-1")["state_blob"] == b"sealed"

    db.insert_code_audit("denver-1", "denver", "totp", "2fa prompt")
    audit = db.list_code_audit()
    assert len(audit) == 1 and audit[0]["kind"] == "totp"


# -- code service dispatcher -----------------------------------------------


def test_unknown_code_kind_is_rejected():
    with pytest.raises(ValueError):
        get_code("denver", "smoke-signal")


def test_missing_backend_degrades_to_code_unavailable(monkeypatch):
    """Until Stream D lands, asking for an email code must fail cleanly."""
    import builtins

    real_import = builtins.__import__

    def fail_email(name, *args, **kwargs):
        if "email_codes" in name:
            raise ImportError("not implemented yet")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fail_email)
    with pytest.raises(CodeUnavailable):
        get_code("denver", "email")
