"""Device profiles: one device per Facebook account, wherever it runs.

What these fence is the user's ask: an account keeps the same device id for
good — across restarts, rebuilt hosts and new workers — and two accounts never
share one, because a shared device links them.
"""

import importlib

import pytest
from fastapi.testclient import TestClient

from rs_coordinator.device_profiles import SCREENS, generate_profile
from rs_coordinator.tokens import mint_worker_token
from rs_coordinator.vault import Vault, VaultError, generate_key

LEGACY_TOKEN = "test-token"
WORKER_SECRET = "test-hmac-secret"
UID = "100000000000001"
OTHER_UID = "200000000000002"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    key = generate_key()
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "identity.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", LEGACY_TOKEN)
    monkeypatch.setenv("RS_ADMIN_TOKEN", "test-admin-token")
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", WORKER_SECRET)
    monkeypatch.setenv("RS_VAULT_KEY", key)
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    importlib.reload(deps_module)
    importlib.reload(app_module)

    client = TestClient(app_module.app)
    client.db = app_module.db
    client.vault = Vault(key)
    client.deps = deps_module
    client.store = deps_module.get_account_store()
    yield client


def auth(worker_id: str) -> dict:
    return {"Authorization": f"Bearer {mint_worker_token(worker_id, WORKER_SECRET)}"}


def state(uid: str = UID, datr: str = "datr-of-the-device") -> dict:
    return {
        "cookies": [
            {"name": "xs", "value": "session", "domain": ".facebook.com", "path": "/"},
            {"name": "c_user", "value": uid, "domain": ".facebook.com", "path": "/"},
            {"name": "datr", "value": datr, "domain": ".facebook.com", "path": "/"},
            {"name": "sb", "value": "sb-of-the-device", "domain": ".facebook.com", "path": "/"},
        ],
        "origins": [],
    }


def assign(client, worker_id: str = "va-1", account_id: str = "va-1", **fields) -> None:
    fields.setdefault("fb_uid", UID)
    client.store.put_account(account_id, {"password": "pw"}, worker_id=worker_id, **fields)


def ask(client, worker_id: str = "va-1", observed: dict | None = None):
    body = {"observed": observed} if observed is not None else {}
    return client.post(f"/v1/workers/{worker_id}/identity", json=body, headers=auth(worker_id))


def backup(client, worker_id: str = "va-1", **overrides):
    payload = {"storage_state": state(), **overrides}
    return client.post("/v1/session/backup", json=payload, headers=auth(worker_id))


OBSERVED = {
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0",
    "viewport_w": 1280,
    "viewport_h": 720,
    "screen_w": 1280,
    "screen_h": 720,
    "locale": "en-US",
    "timezone_id": "UTC",
}


# -- who may ask ---------------------------------------------------------------


def test_a_slot_without_an_account_uid_has_no_device(env):
    assign(env, fb_uid=None, fb_username="someone@example.test")
    response = ask(env)

    # A 200, so a worker never confuses it with a coordinator lacking the route.
    assert response.status_code == 200
    assert response.json()["device"] is None
    assert "uid" in response.json()["reason"]
    assert env.db.list_device_profiles() == []
    assert env.post("/v1/workers/nobody/identity", json={}, headers=auth("nobody")).json()["device"] is None


def test_only_the_workers_own_token_reads_its_device(env):
    """The answer carries the account's device cookies."""
    assign(env)
    legacy = {"Authorization": f"Bearer {LEGACY_TOKEN}"}
    assert env.post("/v1/workers/va-1/identity", json={}, headers=legacy).status_code == 403
    assert env.post("/v1/workers/va-1/identity", json={}, headers=auth("va-2")).status_code == 403


# -- the device id never changes ----------------------------------------------


def test_the_first_ask_creates_a_device_and_every_later_one_returns_it(env):
    assign(env, region="rs_west")
    first = ask(env).json()
    again = ask(env).json()

    assert first["identity_key"] == f"uid:{UID}"
    assert first["device"]["device_id"] == again["device"]["device_id"]
    assert first["device"]["source"] == "generated"
    assert first["device"]["timezone_id"] == "America/Los_Angeles"
    # A generated device leaves the user agent to the real browser.
    assert first["device"]["user_agent"] is None
    assert len(env.db.list_device_profiles()) == 1


def test_a_new_worker_for_the_same_account_reuses_its_device(env):
    """The ask in so many words: a new VM / worker reuses the device id."""
    assign(env, worker_id="va-1", account_id="va-1")
    device = ask(env, "va-1").json()["device"]

    # The account leaves va-1 and lands on a brand-new slot on another host.
    env.store.delete_account("va-1")
    assign(env, worker_id="nyc-3", account_id="nyc-3")
    moved = ask(env, "nyc-3").json()["device"]

    assert moved == device


def test_two_accounts_never_share_a_device(env):
    assign(env, worker_id="va-1", account_id="va-1", fb_uid=UID)
    assign(env, worker_id="va-2", account_id="va-2", fb_uid=OTHER_UID)

    assert ask(env, "va-1").json()["device"]["device_id"] != ask(env, "va-2").json()["device"]["device_id"]


def test_a_swap_changes_the_device_and_swapping_back_restores_it(env):
    assign(env)
    original = ask(env).json()["device"]["device_id"]

    env.store.put_account("va-1", {}, fb_username="next@example.test", fb_uid=OTHER_UID)
    swapped = ask(env).json()["device"]["device_id"]
    env.store.put_account("va-1", {}, fb_username="first@example.test", fb_uid=UID)
    back = ask(env).json()["device"]["device_id"]

    assert swapped != original
    assert back == original


def test_a_new_login_without_a_uid_forgets_the_old_uid(env):
    """Otherwise the new login would be dressed in the old login's device."""
    assign(env, fb_username="first@example.test")
    ask(env)
    env.store.put_account("va-1", {}, fb_username="next@example.test")

    assert env.db.get_account_row("va-1")["fb_uid"] is None
    assert ask(env).json()["device"] is None


def test_rewriting_the_same_login_keeps_its_uid(env):
    assign(env, fb_username="first@example.test")
    env.store.put_account("va-1", {}, fb_username="FIRST@example.test")
    assert env.db.get_account_row("va-1")["fb_uid"] == UID


# -- joining without Facebook noticing ----------------------------------------


def test_a_logged_in_worker_seeds_the_device_from_what_it_presents(env):
    assign(env)
    backup(env)  # the slot's session is this account's, as of today
    device = ask(env, observed=OBSERVED).json()["device"]

    assert device["source"] == "seeded"
    assert device["user_agent"] == OBSERVED["user_agent"]
    assert device["viewport"] == {"width": 1280, "height": 720}
    assert device["screen"] == {"width": 1280, "height": 720}
    assert device["timezone_id"] == "UTC"


def test_seeding_takes_the_device_cookies_from_the_slots_session(env):
    assign(env)
    backup(env)
    body = ask(env, observed=OBSERVED).json()

    names = {c["name"]: c["value"] for c in body["device_cookies"]}
    assert names == {"datr": "datr-of-the-device", "sb": "sb-of-the-device"}


def test_a_session_of_another_login_never_seeds_the_device(env):
    """The slot still holds the previous login's browser: copy nothing of it."""
    assign(env)
    backup(env, storage_state=state(uid=OTHER_UID))
    body = ask(env, observed=OBSERVED).json()

    assert body["device"]["source"] == "generated"
    assert body["device_cookies"] is None


def test_observed_is_ignored_once_the_device_exists(env):
    assign(env)
    first = ask(env).json()["device"]
    backup(env)
    later = ask(env, observed=OBSERVED).json()["device"]
    assert later == first


# -- backups keep the device cookies current ----------------------------------


def test_a_backup_under_the_device_records_its_cookies(env):
    assign(env)
    device_id = ask(env).json()["device"]["device_id"]
    backup(env, device_id=device_id)

    body = ask(env).json()
    assert {c["name"] for c in body["device_cookies"]} == {"datr", "sb"}
    assert body["session"]["restorable"] is True
    assert body["session"]["identity_key"] == f"uid:{UID}"


def test_a_refreshed_datr_replaces_the_stored_one(env):
    assign(env)
    device_id = ask(env).json()["device"]["device_id"]
    backup(env, device_id=device_id)
    backup(env, device_id=device_id, storage_state=state(datr="datr-refreshed"))

    cookies = {c["name"]: c["value"] for c in ask(env).json()["device_cookies"]}
    assert cookies["datr"] == "datr-refreshed"


def test_a_backup_of_another_login_leaves_the_device_alone(env):
    assign(env)
    device_id = ask(env).json()["device"]["device_id"]
    backup(env, device_id=device_id, storage_state=state(uid=OTHER_UID, datr="foreign"))

    body = ask(env).json()
    assert body["device_cookies"] is None
    assert body["session"]["restorable"] is False


def test_device_cookies_are_sealed_at_rest(env):
    assign(env)
    device_id = ask(env).json()["device"]["device_id"]
    backup(env, device_id=device_id)

    with env.db.cursor() as cur:
        cur.execute("SELECT device_cookies_blob FROM device_profiles")
        raw = bytes(cur.fetchone()["device_cookies_blob"])
    assert b"datr-of-the-device" not in raw


def test_a_missing_vault_key_is_a_503(env, monkeypatch):
    assign(env)

    def no_vault():
        raise VaultError("RS_VAULT_KEY is not set.")

    monkeypatch.setattr(env.deps, "get_vault", no_vault)
    assert ask(env).status_code == 503


# -- generation ----------------------------------------------------------------


def test_generated_devices_fit_the_workers_display():
    for _ in range(50):
        profile = generate_profile(UID, None)
        assert (profile["screen_w"], profile["screen_h"], profile["device_scale_factor"]) in SCREENS
        assert profile["screen_w"] <= 1920 and profile["screen_h"] <= 1080
        assert 0 < profile["viewport_h"] < profile["screen_h"]
        assert profile["timezone_id"] == "America/New_York"


# -- the device is fixed on first contact, before any login ---------------------

FIRST_CONTACT = [
    {"name": "datr", "value": "issued-on-first-page", "domain": ".facebook.com", "path": "/",
     "expires": 1893456000, "httpOnly": True, "secure": True, "sameSite": "None"},
    {"name": "sb", "value": "sb-first", "domain": ".facebook.com", "path": "/"},
]


def report(client, device_id: str, cookies=None, worker_id: str = "va-1"):
    return client.post(
        f"/v1/workers/{worker_id}/identity/device-cookies",
        json={"device_id": device_id, "cookies": cookies or FIRST_CONTACT},
        headers=auth(worker_id),
    )


def test_an_account_that_never_logged_in_keeps_its_first_datr(env):
    """va-1, 2026-10-18: six attempts, six fresh datr, one locked account."""
    assign(env)
    device_id = ask(env).json()["device"]["device_id"]

    first = report(env, device_id).json()
    assert first["stored"] is True
    # A second attempt (another worker, a later boot) is handed the first datr.
    later = report(env, device_id, [{**FIRST_CONTACT[0], "value": "a-newer-one"}]).json()
    assert later["stored"] is False
    assert later["device_cookies"][0]["value"] == "issued-on-first-page"
    assert {c["value"] for c in ask(env).json()["device_cookies"]} == {"issued-on-first-page", "sb-first"}


def test_a_logged_in_backup_still_keeps_the_device_current(env):
    assign(env)
    device_id = ask(env).json()["device"]["device_id"]
    report(env, device_id)
    backup(env, device_id=device_id, storage_state=state(datr="rotated-after-login"))

    cookies = {c["name"]: c["value"] for c in ask(env).json()["device_cookies"]}
    assert cookies["datr"] == "rotated-after-login"


def test_a_device_that_is_no_longer_the_accounts_is_refused(env):
    assign(env)
    device_id = ask(env).json()["device"]["device_id"]
    env.store.put_account("va-1", {}, fb_username="next@example.test", fb_uid=OTHER_UID)

    assert report(env, device_id).status_code == 409
    assert ask(env).json()["device_cookies"] is None


def test_only_device_cookies_for_facebook_are_taken(env):
    assign(env)
    device_id = ask(env).json()["device"]["device_id"]
    assert report(env, device_id, [{"name": "xs", "value": "session", "domain": ".facebook.com"}]).status_code == 422
    assert report(env, device_id, [{**FIRST_CONTACT[0], "domain": ".evil.example"}]).status_code == 422
    legacy = {"Authorization": f"Bearer {LEGACY_TOKEN}"}
    body = {"device_id": device_id, "cookies": FIRST_CONTACT}
    assert env.post("/v1/workers/va-1/identity/device-cookies", json=body, headers=legacy).status_code == 403
