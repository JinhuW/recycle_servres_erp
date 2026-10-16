"""Code and credential release: the endpoints that hand out account secrets.

These are the highest-risk routes in the control plane, so what is pinned here
is mostly about who may ask for what: a worker token speaks only for its own
account, a password only leaves when the account opted into it, and every
release lands in the audit log.
"""

import importlib
import time

import pyotp
import pytest
from fastapi.testclient import TestClient

from rs_coordinator.tokens import mint_worker_token
from rs_coordinator.vault import generate_key

WORKER_SECRET = "test-worker-hmac-secret"
# The canonical pyotp example secret: 6 digits, 30-second step, SHA-1.
TOTP_SECRET = "JBSWY3DPEHPK3PXP"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "auth.db"))
    monkeypatch.setenv("RS_VAULT_KEY", generate_key())
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", WORKER_SECRET)
    monkeypatch.setenv("RS_ADMIN_TOKEN", "admin-token")
    monkeypatch.delenv("RS_COORDINATOR_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    # The process singletons (db path, vault key, tokens) are read at import
    # time, so deps has to be reloaded before app re-imports them.
    importlib.reload(deps_module)
    importlib.reload(app_module)

    store = deps_module.get_account_store()
    # denver: has a TOTP secret, password login refused.
    store.put_account(
        "denver",
        {"password": "hunter2", "totp_secret": TOTP_SECRET},
        worker_id="denver-1",
        fb_username="denver@example.com",
        allow_password_login=False,
    )
    # tx: password login allowed, and deliberately no TOTP secret.
    store.put_account(
        "tx",
        {"password": "correct-horse"},
        worker_id="tx-1",
        fb_username="tx@example.com",
        allow_password_login=True,
    )

    test_client = TestClient(app_module.app)
    test_client.db = app_module.db
    yield test_client


def auth(worker_id: str) -> dict:
    return {"Authorization": f"Bearer {mint_worker_token(worker_id, WORKER_SECRET)}"}


def reference_codes() -> set:
    """Every code a correct implementation could return right now.

    The service rolls forward to the next window when the current one is nearly
    over, so both are acceptable — asserting on one of them makes the test fail
    a few times an hour.
    """
    totp = pyotp.TOTP(TOTP_SECRET)
    now = int(time.time())
    return {totp.at(now), totp.at(now + 30)}


# -- totp codes -------------------------------------------------------------


def test_totp_code_matches_a_standard_authenticator(client):
    response = client.post("/v1/auth/code", json={"reason": "2fa prompt"}, headers=auth("denver-1"))
    assert response.status_code == 200

    body = response.json()
    assert body["kind"] == "totp"
    assert len(body["code"]) == 6 and body["code"].isdigit()
    assert body["code"] in reference_codes()
    # Never hand out a code that expires while the worker is typing it.
    assert 3 < body["expires_in"] <= 30


def test_both_route_prefixes_work(client):
    assert client.post("/api/v1/auth/code", json={}, headers=auth("denver-1")).status_code == 200


def test_every_release_is_audited(client):
    client.post("/v1/auth/code", json={"reason": "login challenge"}, headers=auth("denver-1"))

    audit = client.db.list_code_audit()
    assert len(audit) == 1
    assert audit[0]["worker_id"] == "denver-1"
    assert audit[0]["account_id"] == "denver"
    assert audit[0]["kind"] == "totp"
    assert audit[0]["reason"] == "login challenge"
    assert audit[0]["released_at"]


def test_a_worker_token_pins_the_account_it_may_ask_for(client):
    """A worker naming someone else's account must still get its own."""
    response = client.post(
        "/v1/auth/code", json={"account_id": "tx", "worker_id": "tx-1"}, headers=auth("denver-1")
    )
    assert response.status_code == 200
    assert response.json()["code"] in reference_codes()
    assert client.db.list_code_audit()[0]["account_id"] == "denver"


def test_a_worker_with_no_account_is_a_404(client):
    response = client.post("/v1/auth/code", json={}, headers=auth("ghost-1"))
    assert response.status_code == 404
    assert "ghost-1" in response.json()["detail"]


def test_an_account_without_a_totp_secret_is_a_404(client):
    response = client.post("/v1/auth/code", json={}, headers=auth("tx-1"))
    assert response.status_code == 404
    # The error has to say how to fix it, not just that it failed.
    assert "rsc vault set-account" in response.json()["detail"]
    assert client.db.list_code_audit() == []


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer denver-1.deadbeef"}])
def test_codes_require_a_valid_token(client, headers):
    assert client.post("/v1/auth/code", json={}, headers=headers).status_code == 401


def test_a_code_about_to_expire_rolls_to_the_next_window(client):
    from rs_coordinator.totp_code import generate_for

    # One second before the step boundary: the current code is worthless.
    at = 1_700_000_000 - (1_700_000_000 % 30) + 29
    code, expires_in = generate_for("denver", at=at)
    assert expires_in == 30
    assert code == pyotp.TOTP(TOTP_SECRET).at(at + 1)


def test_an_otpauth_uri_carries_its_own_parameters(client):
    """The URI form is the only way to store non-default digits/period."""
    import rs_coordinator.deps as deps_module

    deps_module.get_account_store().put_account(
        "denver",
        {"totp_secret": f"otpauth://totp/RS:denver?secret={TOTP_SECRET}&digits=8&period=60"},
    )
    body = client.post("/v1/auth/code", json={}, headers=auth("denver-1")).json()

    assert len(body["code"]) == 8
    assert body["expires_in"] <= 60
    assert body["code"] in {
        pyotp.TOTP(TOTP_SECRET, digits=8, interval=60).at(int(time.time()) + offset)
        for offset in (0, 60)
    }


# -- credentials ------------------------------------------------------------


def test_credentials_are_refused_unless_the_account_opted_in(client):
    response = client.post("/v1/auth/credentials", json={}, headers=auth("denver-1"))
    assert response.status_code == 403
    assert "hunter2" not in response.text
    assert client.db.list_code_audit() == []


def test_credentials_are_released_and_audited_when_allowed(client):
    response = client.post(
        "/v1/auth/credentials", json={"reason": "session expired"}, headers=auth("tx-1")
    )
    assert response.status_code == 200
    assert response.json() == {"username": "tx@example.com", "password": "correct-horse"}

    audit = client.db.list_code_audit()
    assert len(audit) == 1
    assert (audit[0]["account_id"], audit[0]["kind"]) == ("tx", "password")
    assert audit[0]["reason"] == "session expired"


def test_credentials_require_a_valid_token(client):
    assert client.post("/v1/auth/credentials", json={}).status_code == 401


# -- the legacy fleet-wide token --------------------------------------------


@pytest.fixture()
def legacy_client(tmp_path, monkeypatch):
    """A control plane that still accepts the shared fleet token."""
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "legacy.db"))
    monkeypatch.setenv("RS_VAULT_KEY", generate_key())
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", WORKER_SECRET)
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "fleet-wide-token")
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)

    store = deps_module.get_account_store()
    store.put_account(
        "denver",
        {"password": "hunter2", "totp_secret": TOTP_SECRET},
        worker_id="denver-1",
        fb_username="denver@example.com",
        allow_password_login=True,
    )

    test_client = TestClient(app_module.app)
    test_client.db = app_module.db
    yield test_client


LEGACY = {"Authorization": "Bearer fleet-wide-token"}


@pytest.mark.parametrize("route", ["/v1/auth/code", "/v1/auth/credentials"])
def test_the_fleet_token_cannot_name_an_account(legacy_client, route):
    """The whole point: one compromised VM must not reach another's secrets.

    Every worker container is handed RS_COORDINATOR_TOKEN for the listing
    channel, so if that token could name an `account_id` it would also be a
    fleet-wide key to the vault.
    """
    response = legacy_client.post(
        route, json={"worker_id": "anything", "account_id": "denver"}, headers=LEGACY
    )
    assert response.status_code == 403
    assert "per-worker token" in response.json()["detail"]
    # Nothing leaked, and nothing was minted to leak.
    assert "hunter2" not in response.text
    assert legacy_client.db.list_code_audit() == []


def test_the_fleet_token_cannot_impersonate_a_worker_either(legacy_client):
    """Refusing only `account_id` would leave the same hole one hop away."""
    response = legacy_client.post(
        "/v1/auth/code", json={"worker_id": "denver-1"}, headers=LEGACY
    )
    assert response.status_code == 403
    assert legacy_client.db.list_code_audit() == []


def test_a_per_worker_token_still_works_on_that_deployment(legacy_client):
    """Refusing the fleet token must not take real workers down with it."""
    response = legacy_client.post("/v1/auth/code", json={}, headers=auth("denver-1"))
    assert response.status_code == 200
    assert response.json()["code"] in reference_codes()
