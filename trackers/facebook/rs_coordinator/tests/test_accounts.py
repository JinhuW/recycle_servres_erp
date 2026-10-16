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


# -- console writes (the ERP's Account Pool) -----------------------------------

ACTOR = "Alex Manager"


@pytest.fixture()
def alerts(env, monkeypatch):
    import rs_coordinator.deps as deps_module

    sent = []
    monkeypatch.setattr(deps_module.ops_notifier, "send", lambda text, **_: sent.append(text) or True)
    return sent


def _store():
    import rs_coordinator.deps as deps_module

    return deps_module.get_account_store()


def _accounts(client):
    response = client.get("/v1/accounts", headers=ADMIN_AUTH)
    return {a["account_id"]: a for a in response.json()["accounts"]}


def test_writes_require_the_admin_token(env):
    body = {"account_id": "new", "changed_by": ACTOR}
    assert env.post("/v1/accounts", json=body).status_code == 401
    assert env.patch("/v1/accounts/spare", json={"changed_by": ACTOR}).status_code == 401
    legacy = {"Authorization": f"Bearer {LEGACY_TOKEN}"}
    assert env.post("/v1/accounts", json=body, headers=legacy).status_code in (401, 403)


def test_there_is_no_delete_route(env):
    assert env.delete("/v1/accounts/spare", headers=ADMIN_AUTH).status_code == 405
    assert _store().get_account("spare") is not None


def test_create_stores_secrets_and_returns_presence_only(env, alerts):
    response = env.post(
        "/v1/accounts",
        headers=ADMIN_AUTH,
        json={
            "account_id": "ne-2",
            "fb_username": "buyer@example.com",
            "region": "ne",
            "secrets": {"password": "s3cret-pw", "totp_secret": "jbsw y3dp ehpk 3pxp"},
            "changed_by": ACTOR,
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["account_id"] == "ne-2"
    assert body["worker_id"] is None
    assert body["allow_password_login"] is False
    assert body["secrets"]["password"] is True
    assert body["secrets"]["totp_secret"] is True
    assert body["secrets"]["email"] is False
    assert "s3cret-pw" not in response.text and "JBSW" not in response.text.upper()

    # Spaced key normalised to bare base32, exactly as the CLI stores it.
    assert _store().get_secret("ne-2") == {"password": "s3cret-pw", "totp_secret": TOTP_SECRET}
    assert "ne-2" in _accounts(env)
    assert alerts == []  # no worker named, nothing moved


def test_create_refuses_an_existing_id(env):
    response = env.post(
        "/v1/accounts", headers=ADMIN_AUTH, json={"account_id": "personal", "changed_by": ACTOR}
    )
    assert response.status_code == 409
    assert "already exists" in response.json()["detail"]
    assert _store().get_secret("personal")["password"] == "hunter2"


@pytest.mark.parametrize("bad", ["", "-leading", "has space", "x" * 129, "a/b"])
def test_create_refuses_a_malformed_id(env, bad):
    response = env.post("/v1/accounts", headers=ADMIN_AUTH, json={"account_id": bad, "changed_by": ACTOR})
    assert response.status_code == 422


def test_create_with_a_worker_alerts_ops(env, alerts):
    response = env.post(
        "/v1/accounts",
        headers=ADMIN_AUTH,
        json={"account_id": "mw-1-acct", "worker_id": "mw-1", "changed_by": ACTOR},
    )
    assert response.status_code == 201
    assert response.json()["worker_id"] == "mw-1"
    assert len(alerts) == 1
    assert "mw\\-1\\-acct" in alerts[0] and "Alex Manager" in alerts[0]


def test_patch_keeps_what_it_does_not_mention(env):
    response = env.patch(
        "/v1/accounts/personal",
        headers=ADMIN_AUTH,
        json={"region": "west", "secrets": {"email_password": "mailpw", "email": "a@gmail.com"}, "changed_by": ACTOR},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["region"] == "west"
    assert body["worker_id"] == "homelab-1"
    assert body["fb_username"] == "someone@example.com"
    assert body["proxy_configured"] is True
    stored = _store().get_secret("personal")
    assert stored == {
        "password": "hunter2",
        "totp_secret": TOTP_SECRET,
        "email": "a@gmail.com",
        "email_password": "mailpw",
    }
    assert "mailpw" not in response.text and "hunter2" not in response.text


def test_patch_null_clears_a_secret_and_a_field(env):
    response = env.patch(
        "/v1/accounts/personal",
        headers=ADMIN_AUTH,
        json={"fb_username": None, "secrets": {"password": None}, "changed_by": ACTOR},
    )
    assert response.status_code == 200, response.text
    assert response.json()["fb_username"] is None
    assert response.json()["secrets"]["password"] is False
    assert _store().get_secret("personal") == {"totp_secret": TOTP_SECRET}


def test_patch_unknown_account_is_404(env):
    response = env.patch("/v1/accounts/ghost", headers=ADMIN_AUTH, json={"changed_by": ACTOR})
    assert response.status_code == 404
    assert _store().get_account("ghost") is None


def test_unassign_returns_the_account_to_the_pool(env, alerts):
    response = env.patch(
        "/v1/accounts/personal", headers=ADMIN_AUTH, json={"worker_id": None, "changed_by": ACTOR}
    )
    assert response.status_code == 200
    assert response.json()["worker_id"] is None
    assert _store().account_for_worker("homelab-1") is None
    assert len(alerts) == 1 and "pool" in alerts[0]


def test_moving_an_account_turns_password_login_off(env, alerts):
    store = _store()
    store.put_account("personal", None, allow_password_login=True)
    assert store.get_account("personal")["allow_password_login"] is True

    response = env.patch(
        "/v1/accounts/personal", headers=ADMIN_AUTH, json={"worker_id": "ne-1", "changed_by": ACTOR}
    )
    assert response.status_code == 200
    assert response.json()["worker_id"] == "ne-1"
    assert response.json()["allow_password_login"] is False
    assert store.get_account("personal")["allow_password_login"] is False
    assert len(alerts) == 1
    assert "homelab\\-1" in alerts[0] and "ne\\-1" in alerts[0]
    assert "password login was turned off" in alerts[0]


def test_an_edit_that_does_not_move_keeps_password_login(env, alerts):
    store = _store()
    store.put_account("personal", None, allow_password_login=True)
    response = env.patch(
        "/v1/accounts/personal",
        headers=ADMIN_AUTH,
        json={"worker_id": "homelab-1", "region": "ne", "changed_by": ACTOR},
    )
    assert response.status_code == 200
    assert response.json()["allow_password_login"] is True
    assert alerts == []


def test_a_worker_holds_one_account(env):
    response = env.patch(
        "/v1/accounts/spare", headers=ADMIN_AUTH, json={"worker_id": "homelab-1", "changed_by": ACTOR}
    )
    assert response.status_code == 409
    assert "personal" in response.json()["detail"]
    assert _store().get_account("spare")["worker_id"] is None


@pytest.mark.parametrize(
    "secrets",
    [
        {"imap_host": "imap.attacker.example"},
        {"email": "someone@gmail.com"},
        {"imap_port": "1993"},
        {"imap_host": "imap.attacker.example", "email_password": None},
        {"imap_host": "imap.attacker.example", "email": None},
    ],
)
def test_the_mailbox_cannot_move_without_its_password(env, secrets):
    store = _store()
    store.put_account(
        "personal",
        {"email": "someone@gmail.com", "email_password": "real-mail-pw"},
    )
    before = store.get_secret("personal")
    response = env.patch(
        "/v1/accounts/personal", headers=ADMIN_AUTH, json={"secrets": secrets, "changed_by": ACTOR}
    )
    assert response.status_code == 422
    assert "mailbox password" in response.json()["detail"]
    assert store.get_secret("personal") == before


def test_the_mailbox_moves_with_its_password(env):
    response = env.patch(
        "/v1/accounts/personal",
        headers=ADMIN_AUTH,
        json={
            "secrets": {"imap_host": "imap.example.org", "imap_port": "993", "email_password": "pw"},
            "changed_by": ACTOR,
        },
    )
    assert response.status_code == 200, response.text
    stored = _store().get_secret("personal")
    assert stored["imap_host"] == "imap.example.org"
    assert stored["imap_port"] == "993"


def test_the_mailbox_can_be_removed_without_its_password(env):
    # Clearing points nowhere new: a cleared host falls back to the well-known
    # one for the stored address, and a cleared address switches codes off.
    store = _store()
    store.put_account(
        "personal",
        {"email": "someone@gmail.com", "email_password": "pw", "imap_host": "imap.gmail.com", "imap_port": "993"},
    )
    response = env.patch(
        "/v1/accounts/personal",
        headers=ADMIN_AUTH,
        json={"secrets": {"imap_host": None, "imap_port": None}, "changed_by": ACTOR},
    )
    assert response.status_code == 200, response.text
    response = env.patch(
        "/v1/accounts/personal",
        headers=ADMIN_AUTH,
        json={"secrets": {"email": None, "email_password": None}, "changed_by": ACTOR},
    )
    assert response.status_code == 200, response.text
    assert store.get_secret("personal") == {"password": "hunter2", "totp_secret": TOTP_SECRET}


def test_a_bad_totp_key_stores_nothing(env):
    before = _store().get_secret("personal")
    response = env.patch(
        "/v1/accounts/personal",
        headers=ADMIN_AUTH,
        json={"secrets": {"totp_secret": "not base32 !!", "password": "new"}, "changed_by": ACTOR},
    )
    assert response.status_code == 422
    assert "TOTP" in response.json()["detail"]
    assert _store().get_secret("personal") == before


def test_a_non_default_otpauth_uri_is_kept_whole(env):
    uri = f"otpauth://totp/FB:me?secret={TOTP_SECRET}&digits=8"
    response = env.patch(
        "/v1/accounts/spare", headers=ADMIN_AUTH, json={"secrets": {"totp_secret": uri}, "changed_by": ACTOR}
    )
    assert response.status_code == 200
    assert _store().get_secret("spare")["totp_secret"] == uri


@pytest.mark.parametrize("port", ["0", "70000", "imap"])
def test_a_bad_imap_port_is_refused(env, port):
    response = env.patch(
        "/v1/accounts/spare",
        headers=ADMIN_AUTH,
        json={"secrets": {"imap_port": port, "email_password": "pw"}, "changed_by": ACTOR},
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "body",
    [
        {"secrets": {"api_key": "x"}, "changed_by": ACTOR},
        {"secrets": {"password": "   "}, "changed_by": ACTOR},
        {"allow_password_login": True, "changed_by": ACTOR},
        {"proxy": "http://evil:1", "changed_by": ACTOR},
        {"vnc_url": "https://phish.example", "changed_by": ACTOR},
        {"region": "ne"},
        {"worker_id": "bad worker", "changed_by": ACTOR},
    ],
)
def test_out_of_bounds_writes_are_refused(env, body):
    before = (_store().get_account("personal"), _store().get_secret("personal"))
    response = env.patch("/v1/accounts/personal", headers=ADMIN_AUTH, json=body)
    assert response.status_code == 422
    assert (_store().get_account("personal"), _store().get_secret("personal")) == before


def test_writes_log_field_names_never_values(env, caplog):
    caplog.set_level("INFO", logger="rs_coordinator.routers.accounts")
    env.post(
        "/v1/accounts",
        headers=ADMIN_AUTH,
        json={"account_id": "logged", "secrets": {"password": "pw-in-log?"}, "changed_by": ACTOR},
    )
    env.patch(
        "/v1/accounts/logged",
        headers=ADMIN_AUTH,
        json={"secrets": {"password": "second-pw", "totp_secret": TOTP_SECRET}, "changed_by": ACTOR},
    )
    text = caplog.text
    assert "logged created" in text and "logged updated" in text
    assert "secret:password" in text
    for secret in ("pw-in-log?", "second-pw", TOTP_SECRET):
        assert secret not in text
