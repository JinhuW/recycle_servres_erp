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


# -- writes from the console ---------------------------------------------------
#
# The ERP's "Edit credentials" form lands here. What must stay true: the admin
# token is required, a secret goes in and only a presence flag comes out,
# blank keeps and null clears, a bad TOTP key is refused at the door, and a
# worker cannot be quietly moved between accounts.


def test_put_requires_the_admin_token(env):
    body = {"fb_username": "x@example.com"}
    assert env.put("/v1/accounts/personal", json=body).status_code == 401
    legacy = {"Authorization": f"Bearer {LEGACY_TOKEN}"}
    assert env.put("/v1/accounts/personal", json=body, headers=legacy).status_code in (401, 403)


def test_put_creates_an_account_and_answers_with_presence_flags_only(env):
    import rs_coordinator.deps as deps_module

    response = env.put(
        "/v1/accounts/ne-1",
        json={
            "worker_id": "ne-1",
            "fb_username": "lisa@example.com",
            "allow_password_login": True,
            "secrets": {"password": "s3cret-pw", "totp_secret": "jbsw y3dp ehpk 3pxp"},
        },
        headers=ADMIN_AUTH,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["account_id"] == "ne-1"
    assert body["worker_id"] == "ne-1"
    assert body["fb_username"] == "lisa@example.com"
    assert body["allow_password_login"] is True
    assert body["secrets"]["password"] is True
    assert body["secrets"]["totp_secret"] is True
    assert body["secrets"]["email"] is False
    for secret in ("s3cret-pw", "JBSWY3DP", "jbsw", "secret_blob"):
        assert secret not in response.text

    # Stored for real, with the TOTP key normalised the way the CLI does it.
    stored = deps_module.get_account_store().get_secret("ne-1")
    assert stored == {"password": "s3cret-pw", "totp_secret": TOTP_SECRET}


def test_put_merges_blank_keeps_and_null_clears(env):
    import rs_coordinator.deps as deps_module

    store = deps_module.get_account_store()

    # Change the login only: a blank password box must not touch the password.
    response = env.put(
        "/v1/accounts/personal",
        json={"fb_username": "renamed@example.com", "secrets": {"password": ""}},
        headers=ADMIN_AUTH,
    )
    assert response.status_code == 200
    assert response.json()["fb_username"] == "renamed@example.com"
    assert response.json()["secrets"]["password"] is True
    assert store.get_secret("personal")["password"] == "hunter2"
    # Untouched fields survive too.
    assert response.json()["worker_id"] == "homelab-1"
    assert response.json()["proxy_configured"] is True

    # An explicit null clears exactly that field.
    response = env.put(
        "/v1/accounts/personal", json={"secrets": {"password": None}}, headers=ADMIN_AUTH
    )
    assert response.status_code == 200
    assert response.json()["secrets"] == {
        "password": False,
        "email": False,
        "email_password": False,
        "totp_secret": True,
        "imap_host": False,
        "imap_port": False,
    }
    assert "password" not in store.get_secret("personal")


def test_put_keeps_the_password_login_flag_when_it_is_not_sent(env):
    assert env.put(
        "/v1/accounts/personal", json={"allow_password_login": True}, headers=ADMIN_AUTH
    ).json()["allow_password_login"] is True
    assert env.put(
        "/v1/accounts/personal", json={"region": "rs_southeast"}, headers=ADMIN_AUTH
    ).json()["allow_password_login"] is True
    assert env.put(
        "/v1/accounts/personal", json={"allow_password_login": False}, headers=ADMIN_AUTH
    ).json()["allow_password_login"] is False


def test_put_refuses_a_bad_totp_secret_and_an_unknown_field(env):
    response = env.put(
        "/v1/accounts/personal", json={"secrets": {"totp_secret": "not base32 !!"}}, headers=ADMIN_AUTH
    )
    assert response.status_code == 400
    assert "base32" in response.json()["detail"]

    response = env.put(
        "/v1/accounts/personal", json={"secrets": {"passwd": "x"}}, headers=ADMIN_AUTH
    )
    assert response.status_code == 400
    assert "Unknown secret field 'passwd'" in response.json()["detail"]

    assert env.put("/v1/accounts/bad id", json={}, headers=ADMIN_AUTH).status_code == 400
    assert env.put(
        "/v1/accounts/x", json={"worker_id": "no spaces"}, headers=ADMIN_AUTH
    ).status_code == 422


def test_put_will_not_move_a_worker_between_accounts(env):
    response = env.put(
        "/v1/accounts/spare", json={"worker_id": "homelab-1"}, headers=ADMIN_AUTH
    )
    assert response.status_code == 409
    assert "already belongs to account 'personal'" in response.json()["detail"]
    # Re-stating the owner's own mapping is fine.
    assert env.put(
        "/v1/accounts/personal", json={"worker_id": "homelab-1"}, headers=ADMIN_AUTH
    ).status_code == 200


def test_credentials_set_from_the_console_are_what_the_worker_gets(env):
    """The point of the route: after a PUT, Re-login can finish by itself."""
    from rs_coordinator.tokens import mint_worker_token

    worker = {"Authorization": f"Bearer {mint_worker_token('ne-1', 'test-hmac-secret')}"}
    # Nothing registered for ne-1 yet: the worker is told so.
    assert env.post("/v1/auth/credentials", json={}, headers=worker).status_code == 404

    assert env.put(
        "/v1/accounts/ne-1",
        json={
            "worker_id": "ne-1",
            "fb_username": "lisa@example.com",
            "allow_password_login": True,
            "secrets": {"password": "s3cret-pw"},
        },
        headers=ADMIN_AUTH,
    ).status_code == 200

    response = env.post("/v1/auth/credentials", json={"reason": "forced re-login"}, headers=worker)
    assert response.status_code == 200, response.text
    assert response.json() == {"username": "lisa@example.com", "password": "s3cret-pw"}

    # Turning password login off from the console turns the release off too.
    env.put("/v1/accounts/ne-1", json={"allow_password_login": False}, headers=ADMIN_AUTH)
    assert env.post("/v1/auth/credentials", json={}, headers=worker).status_code == 403


def test_the_erp_sends_the_uid_with_the_login_and_a_bare_login_forgets_it(env):
    """The uid picks the worker's device; a stale one would lend the old login's."""
    put = lambda body: env.put("/v1/accounts/va-1", json=body, headers=ADMIN_AUTH)  # noqa: E731

    assert put({"worker_id": "va-1", "fb_username": "a@x.test", "fb_uid": "1000"}).json()["fb_uid"] == "1000"
    assert put({"region": "rs_west"}).json()["fb_uid"] == "1000"
    assert put({"fb_username": "b@x.test"}).json()["fb_uid"] is None
    assert put({"fb_uid": "not-a-uid"}).status_code == 422
