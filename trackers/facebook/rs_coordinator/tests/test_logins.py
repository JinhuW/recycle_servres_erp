"""Every login records its device, retries are capped, a lock stops them.

va-1, 2026-10-18: four automated password logins in 37 minutes, each from a
browser with a new `datr`, and Facebook locked the account as possibly hacked.
These fence the three things that would have stopped it: a ledger that says
which device each login used, a daily budget of automated password logins, and
a lock flag that ends them until a human has unlocked the account.
"""

import importlib

import pytest
from fastapi.testclient import TestClient

from rs_coordinator.routers.logins import datr_fingerprint
from rs_coordinator.tokens import mint_worker_token
from rs_coordinator.vault import Vault, generate_key

WORKER_SECRET = "test-hmac-secret"
ADMIN = {"Authorization": "Bearer test-admin-token"}
UID = "61574553140062"
LEGACY_DATR = "legacy-datr-of-the-seller"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    key = generate_key()
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "logins.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_ADMIN_TOKEN", "test-admin-token")
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", WORKER_SECRET)
    monkeypatch.setenv("RS_VAULT_KEY", key)
    monkeypatch.delenv("RS_PASSWORD_LOGINS_PER_DAY", raising=False)
    monkeypatch.delenv("RS_REQUIRE_FB_UID", raising=False)
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)

    client = TestClient(app_module.app)
    client.db = app_module.db
    client.vault = Vault(key)
    client.store = deps_module.get_account_store()
    client.pages = []
    monkeypatch.setattr(deps_module.ops_notifier, "send", client.pages.append)
    yield client


def auth(worker_id: str = "va-1") -> dict:
    return {"Authorization": f"Bearer {mint_worker_token(worker_id, WORKER_SECRET)}"}


def account(client, uid: str | None = UID) -> None:
    client.store.put_account(
        "va-1",
        {"password": "pw"},
        worker_id="va-1",
        fb_username="someone@example.test",
        fb_uid=uid,
        allow_password_login=True,
    )


def credentials(client):
    return client.post("/v1/auth/credentials", json={"reason": "test"}, headers=auth())


def start(client, datr_fp: str | None = None, device_id: str = "dev-1"):
    body = {"phase": "start", "trigger": "boot", "device_id": device_id, "datr_fp": datr_fp}
    return client.post("/v1/workers/va-1/logins", json=body, headers=auth())


def finish(client, attempt_id: int, outcome: str, detail: dict | None = None):
    body = {"phase": "finish", "attempt_id": attempt_id, "outcome": outcome, "detail": detail}
    return client.post("/v1/workers/va-1/logins", json=body, headers=auth())


def seed(client, cookies: list):
    body = {"fb_uid": UID, "device_cookies": cookies}
    return client.put("/v1/accounts/va-1", json=body, headers=ADMIN)


DATR = {"name": "datr", "value": LEGACY_DATR, "domain": ".facebook.com"}


# -- the budget ----------------------------------------------------------------


def test_the_third_password_login_in_a_day_is_refused_and_audited(env):
    account(env)

    assert credentials(env).status_code == 200
    assert credentials(env).status_code == 200
    third = credentials(env)

    assert third.status_code == 403
    assert "Watch" in third.json()["detail"]
    kinds = [row["kind"] for row in env.db.list_code_audit()]
    assert kinds.count("password") == 2
    assert kinds.count("password_refused") == 1


def test_the_budget_is_configurable(env, monkeypatch):
    monkeypatch.setenv("RS_PASSWORD_LOGINS_PER_DAY", "1")
    account(env)

    assert credentials(env).status_code == 200
    assert credentials(env).status_code == 403


# -- the lock --------------------------------------------------------------------


def test_a_login_that_ends_on_the_lock_page_stops_password_logins(env):
    account(env)
    attempt = start(env).json()["attempt_id"]

    assert finish(env, attempt, "locked", {"url": "https://www.facebook.com/checkpoint/8282/"}).status_code == 200

    refused = credentials(env)
    assert refused.status_code == 403
    assert "locked" in refused.json()["detail"]
    assert "rsc vault unlock" in refused.json()["detail"]
    assert any("Locked" in page for page in env.pages)
    # One page per lock, not per report.
    second = start(env).json()["attempt_id"]
    finish(env, second, "locked")
    assert sum("Locked" in page for page in env.pages) == 1

    assert env.db.unlock_account("va-1")
    assert credentials(env).status_code == 200


# -- no uid, no password ---------------------------------------------------------


def test_with_the_uid_gate_on_an_account_without_a_uid_gets_no_password(env, monkeypatch):
    account(env, uid=None)
    assert credentials(env).status_code == 200  # gate off: unchanged behaviour

    monkeypatch.setenv("RS_REQUIRE_FB_UID", "1")
    refused = credentials(env)
    assert refused.status_code == 403
    assert "uid" in refused.json()["detail"]


# -- the ledger ------------------------------------------------------------------


def test_each_login_is_recorded_with_its_device_and_outcome(env):
    account(env)
    attempt = start(env, datr_fp=datr_fingerprint("d1")).json()["attempt_id"]
    finish(env, attempt, "password_ok")

    [row] = env.db.list_login_attempts("va-1")
    assert row["device_id"] == "dev-1"
    assert row["datr_fp"] == datr_fingerprint("d1")
    assert row["trigger"] == "boot"
    assert row["outcome"] == "password_ok"
    assert row["identity_key"] == f"uid:{UID}"
    assert row["finished_at"]
    assert env.get("/v1/logins", headers=ADMIN).json()["logins"][0]["id"] == attempt


def test_a_worker_cannot_close_another_workers_attempt(env):
    account(env)
    attempt = start(env).json()["attempt_id"]
    body = {"phase": "finish", "attempt_id": attempt, "outcome": "failed"}

    assert env.post("/v1/workers/va-2/logins", json=body, headers=auth("va-1")).status_code == 403
    assert env.post("/v1/workers/va-2/logins", json=body, headers=auth("va-2")).status_code == 404
    assert finish(env, attempt, "failed").status_code == 200
    assert finish(env, attempt, "failed").status_code == 404  # already closed


def test_a_login_on_a_datr_the_device_does_not_hold_pages_ops(env):
    account(env)
    assert seed(env, [DATR]).status_code == 200

    same = start(env, datr_fp=datr_fingerprint(LEGACY_DATR)).json()
    assert same["device_drift"] is False
    assert env.pages == []

    other = start(env, datr_fp=datr_fingerprint("a-brand-new-datr")).json()
    assert other["device_drift"] is True
    assert any("New device" in page for page in env.pages)


# -- seeding the legacy device ---------------------------------------------------


def test_the_legacy_datr_seeds_an_account_with_no_device(env):
    account(env)
    response = seed(env, [DATR])

    assert response.status_code == 200
    profile = env.db.get_device_profile(f"uid:{UID}")
    cookies = env.vault.decrypt(profile["device_cookies_blob"])["cookies"]
    assert [(c["name"], c["value"]) for c in cookies] == [("datr", LEGACY_DATR)]


def test_a_device_with_cookies_already_is_never_reseeded(env):
    account(env)
    seed(env, [DATR])
    seed(env, [{**DATR, "value": "a-later-datr"}])

    profile = env.db.get_device_profile(f"uid:{UID}")
    cookies = env.vault.decrypt(profile["device_cookies_blob"])["cookies"]
    assert cookies[0]["value"] == LEGACY_DATR


def test_only_device_cookies_are_accepted(env):
    """The pool cookie carries a live session; none of it may reach a worker."""
    account(env)
    for name in ("xs", "c_user", "fr"):
        bad = seed(env, [{"name": name, "value": "v", "domain": ".facebook.com"}])
        assert bad.status_code == 422, name
    assert seed(env, [{**DATR, "domain": ".example.com"}]).status_code == 422
    assert env.db.get_device_profile(f"uid:{UID}") is None


def test_seeding_needs_the_uid(env):
    account(env, uid=None)
    response = env.put("/v1/accounts/va-1", json={"device_cookies": [DATR]}, headers=ADMIN)

    assert response.status_code == 400
    assert "fb_uid" in response.json()["detail"]


def test_a_locked_escalation_locks_the_account(env):
    account(env)
    response = env.post(
        "/v1/auth/escalate", json={"kind": "locked", "detail": {}}, headers=auth()
    )
    assert response.status_code == 200
    assert "locked" in credentials(env).json()["detail"]


def test_the_seeded_device_is_what_the_worker_presents_on_its_next_login(env):
    """The ERP writes the account with its legacy device, then queues Re-login;
    the worker's re-login asks for its identity first, so its very first page
    already carries the account's own datr."""
    account(env)
    assert seed(env, [DATR]).status_code == 200

    answer = env.post("/v1/workers/va-1/identity", json={}, headers=auth()).json()

    assert answer["device"]["device_id"]
    assert [(c["name"], c["value"]) for c in answer["device_cookies"]] == [("datr", LEGACY_DATR)]
    # And the worker's own first-page report cannot replace it.
    issued = {"name": "datr", "value": "freshly-issued", "domain": ".facebook.com"}
    report = env.post(
        "/v1/workers/va-1/identity/device-cookies",
        json={"device_id": answer["device"]["device_id"], "cookies": [issued]},
        headers=auth(),
    ).json()
    assert report["stored"] is False
    assert report["device_cookies"][0]["value"] == LEGACY_DATR


# -- restore triggers (RS-338) -------------------------------------------------


def token_account(client, token: str | None = "EAAtoken", uid: str | None = UID) -> None:
    secrets = {"password": "pw"}
    if token is not None:
        secrets["fb_token"] = token
    client.store.put_account(
        "va-1",
        secrets,
        worker_id="va-1",
        fb_username="someone@example.test",
        fb_uid=uid,
        allow_password_login=True,
    )


def session_token(client, reason: str = "saved session invalid"):
    return client.post("/v1/auth/session-token", json={"reason": reason}, headers=auth())


@pytest.mark.parametrize("trigger", ["cookie-restore", "token-refresh"])
def test_a_restore_triggers_login_row_is_recorded(env, trigger):
    # Before RS-338 these triggers 422'd and the ledger row silently dropped.
    account(env)
    body = {"phase": "start", "trigger": trigger, "device_id": "dev-1"}
    response = env.post("/v1/workers/va-1/logins", json=body, headers=auth())
    assert response.status_code == 200, response.text
    assert response.json().get("attempt_id")


# -- the access token release (RS-338) ----------------------------------------


def test_the_token_is_released_and_audited(env):
    token_account(env)
    response = session_token(env)
    assert response.status_code == 200, response.text
    assert response.json() == {"token": "EAAtoken"}
    kinds = [row["kind"] for row in env.db.list_code_audit()]
    assert kinds.count("token") == 1


def test_the_token_release_has_no_daily_budget(env):
    # A password login is capped at 2/day; a token refresh is a far softer
    # signal, so it is released as often as the worker needs it.
    token_account(env)
    for _ in range(5):
        assert session_token(env).status_code == 200


def test_an_account_without_a_token_gets_404(env):
    token_account(env, token=None)
    response = session_token(env)
    assert response.status_code == 404
    assert "no access token" in response.json()["detail"].lower()


def test_a_locked_account_is_refused_a_token(env):
    token_account(env)
    attempt = start(env).json()["attempt_id"]
    assert finish(env, attempt, "locked").status_code == 200

    refused = session_token(env)
    assert refused.status_code == 403
    assert "locked" in refused.json()["detail"]
    kinds = [row["kind"] for row in env.db.list_code_audit()]
    assert "token" not in kinds
    assert kinds.count("password_refused") == 1


def test_the_fleet_token_cannot_fetch_a_token(env):
    token_account(env)
    # The shared fleet-wide token proves no worker identity, like credentials.
    response = env.post(
        "/v1/auth/session-token", json={"reason": "x"}, headers={"Authorization": "Bearer test-token"}
    )
    assert response.status_code == 403
