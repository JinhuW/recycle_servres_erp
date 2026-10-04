"""The console's view of the vault: identity and presence flags, never a value."""

import importlib

import pytest
from fastapi.testclient import TestClient

from rs_coordinator.vault import generate_key

ADMIN_TOKEN = "test-admin-token"
LEGACY_TOKEN = "test-token"
TOTP_SECRET = "JBSWY3DPEHPK3PXP"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "accounts.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", LEGACY_TOKEN)
    monkeypatch.setenv("RS_ADMIN_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", "test-hmac-secret")
    monkeypatch.setenv("RS_VAULT_KEY", generate_key())
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)

    store = deps_module.get_account_store()
    store.put_account(
        "personal",
        {"password": "hunter2", "totp_secret": TOTP_SECRET},
        worker_id="homelab-1",
        fb_username="someone@example.com",
        proxy="http://user:pass@proxy.example:10001",
        allow_password_login=False,
    )
    store.put_account("spare", {}, worker_id=None)
    yield TestClient(app_module.app)


ADMIN_AUTH = {"Authorization": f"Bearer {ADMIN_TOKEN}"}


def test_accounts_require_the_admin_token(env):
    assert env.get("/v1/accounts").status_code == 401
    assert env.get("/v1/accounts", headers={"Authorization": f"Bearer {LEGACY_TOKEN}"}).status_code in (401, 403)


def test_accounts_list_identity_and_presence_only(env):
    response = env.get("/v1/accounts", headers=ADMIN_AUTH)
    assert response.status_code == 200
    accounts = {a["account_id"]: a for a in response.json()["accounts"]}
    assert set(accounts) == {"personal", "spare"}

    personal = accounts["personal"]
    assert personal["worker_id"] == "homelab-1"
    assert personal["fb_username"] == "someone@example.com"
    assert personal["allow_password_login"] is False
    assert personal["proxy_configured"] is True
    assert personal["secrets"] == {
        "password": True,
        "email": False,
        "email_password": False,
        "totp_secret": True,
        "imap_host": False,
        "imap_port": False,
    }
    assert accounts["spare"]["secrets"]["totp_secret"] is False
    assert accounts["spare"]["proxy_configured"] is False

    raw = response.text
    for secret in ("hunter2", TOTP_SECRET, "proxy.example", "secret_blob", "user:pass"):
        assert secret not in raw
