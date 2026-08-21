"""Session backup: cookies sealed on the way in, never handed to the wrong caller.

The whole point of this feature is that a worker's live Facebook cookies pass
through the control plane and land in SQLite. So these tests are mostly about
what must *not* happen: no plaintext in the database file, no state in the admin
metadata view, and no worker reading another worker's session.
"""

import importlib
import json

import pytest
from fastapi.testclient import TestClient

from rs_coordinator.tokens import mint_worker_token
from rs_coordinator.vault import Vault, VaultError, generate_key

ADMIN_TOKEN = "test-admin-token"
LEGACY_TOKEN = "test-token"
WORKER_SECRET = "test-hmac-secret"

# The value that must never show up in the database file or an API response.
SESSION_COOKIE = "xs%3A17-sUpErSeCrEtSeSsIoNvAlUe"


def sample_state(cookie: str = SESSION_COOKIE) -> dict:
    """A trimmed-down Playwright storage_state."""
    return {
        "cookies": [
            {
                "name": "xs",
                "value": cookie,
                "domain": ".facebook.com",
                "path": "/",
                "expires": 1798761600,
                "httpOnly": True,
                "secure": True,
            },
            {"name": "c_user", "value": "100000000000001", "domain": ".facebook.com"},
        ],
        "origins": [
            {
                "origin": "https://www.facebook.com",
                "localStorage": [{"name": "Session", "value": "another-secret"}],
            }
        ],
    }


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """A coordinator wired for the control plane: vault key, admin + worker tokens."""
    key = generate_key()
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "session.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", LEGACY_TOKEN)
    monkeypatch.setenv("RS_ADMIN_TOKEN", ADMIN_TOKEN)
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", WORKER_SECRET)
    monkeypatch.setenv("RS_VAULT_KEY", key)
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    # deps holds the process singletons (db handle, tokens, cached vault), so it
    # has to be reloaded against the test env before app re-imports them.
    importlib.reload(deps_module)
    importlib.reload(app_module)

    client = TestClient(app_module.app)
    client.db = app_module.db
    client.vault = Vault(key)
    client.deps = deps_module
    yield client


def worker_auth(worker_id: str = "denver-1") -> dict:
    return {"Authorization": f"Bearer {mint_worker_token(worker_id, WORKER_SECRET)}"}


ADMIN_AUTH = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
LEGACY_AUTH = {"Authorization": f"Bearer {LEGACY_TOKEN}"}


def backup(client, worker_id: str = "denver-1", **overrides):
    payload = {
        "worker_id": worker_id,
        "account_id": "denver",
        "storage_state": sample_state(),
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120",
        "session_expiry": "2026-11-01T00:00:00+00:00",
    }
    payload.update(overrides)
    return client.post("/v1/session/backup", json=payload, headers=worker_auth(worker_id))


# -- backup ----------------------------------------------------------------


def test_backup_round_trips_through_the_vault(env):
    assert backup(env).json() == {"status": "ok"}

    snapshot = env.db.get_snapshot("denver-1")
    assert env.vault.decrypt(snapshot["state_blob"]) == sample_state()
    assert snapshot["user_agent"].startswith("Mozilla/5.0")
    assert snapshot["session_expiry"] == "2026-11-01T00:00:00+00:00"
    assert snapshot["backed_up_at"]


def test_cookies_are_never_stored_in_plaintext(env):
    backup(env)

    raw = bytes(env.db.get_snapshot("denver-1")["state_blob"])
    # The session cookie, the user id, and the localStorage token must all be
    # unreadable to anyone holding the .db file but not the vault key.
    assert SESSION_COOKIE.encode() not in raw
    assert b"100000000000001" not in raw
    assert b"another-secret" not in raw
    assert b"facebook.com" not in raw


def test_a_second_backup_replaces_the_first(env):
    backup(env)
    fresh = sample_state(cookie="xs%3A18-rotated-value")
    backup(env, storage_state=fresh)

    snapshot = env.db.get_snapshot("denver-1")
    assert env.vault.decrypt(snapshot["state_blob"]) == fresh
    # One row per worker: the stale snapshot is gone, not accumulating.
    with env.db.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM session_snapshots")
        assert cur.fetchone()["n"] == 1


def test_backup_requires_a_valid_token(env):
    payload = {"worker_id": "denver-1", "storage_state": sample_state()}
    assert env.post("/v1/session/backup", json=payload).status_code == 401
    assert (
        env.post(
            "/v1/session/backup", json=payload, headers={"Authorization": "Bearer wrong"}
        ).status_code
        == 401
    )
    assert env.db.get_snapshot("denver-1") is None


def test_a_per_worker_token_overrides_the_body(env):
    """A worker cannot file its snapshot under someone else's id."""
    response = env.post(
        "/v1/session/backup",
        json={"worker_id": "tx-1", "storage_state": sample_state()},
        headers=worker_auth("denver-1"),
    )
    assert response.status_code == 200
    assert env.db.get_snapshot("denver-1") is not None
    assert env.db.get_snapshot("tx-1") is None


def test_the_registered_account_wins_over_a_claimed_one(env):
    env.deps.get_account_store().put_account("denver", {"password": "pw"}, worker_id="denver-1")
    backup(env, account_id="someone-elses-account")
    assert env.db.get_snapshot("denver-1")["account_id"] == "denver"


def test_the_legacy_token_must_name_the_worker(env):
    response = env.post(
        "/v1/session/backup", json={"storage_state": sample_state()}, headers=LEGACY_AUTH
    )
    assert response.status_code == 400
    assert "worker_id" in response.json()["detail"]


def test_an_oversized_storage_state_is_refused(env):
    import rs_coordinator.routers.session as session_router

    oversized = {"origins": [{"blob": "x" * (session_router.MAX_STATE_BYTES + 1024)}]}
    response = backup(env, storage_state=oversized)

    assert response.status_code == 413
    # Refused outright rather than stored: this never reaches the database.
    assert env.db.get_snapshot("denver-1") is None


def test_a_missing_vault_key_is_a_503(env, monkeypatch):
    def no_vault():
        raise VaultError("RS_VAULT_KEY is not set.")

    monkeypatch.setattr(env.deps, "get_vault", no_vault)
    response = backup(env)

    assert response.status_code == 503
    assert "RS_VAULT_KEY" in response.json()["detail"]
    assert env.db.get_snapshot("denver-1") is None


# -- meta ------------------------------------------------------------------


def test_meta_returns_non_secret_fields_only(env):
    backup(env)
    response = env.get("/v1/session/denver-1/meta", headers=ADMIN_AUTH)
    assert response.status_code == 200

    body = response.json()
    assert set(body) == {
        "worker_id",
        "account_id",
        "user_agent",
        "session_expiry",
        "backed_up_at",
    }
    assert body["worker_id"] == "denver-1"
    assert body["account_id"] == "denver"
    assert body["session_expiry"] == "2026-11-01T00:00:00+00:00"
    assert body["backed_up_at"]

    # Neither the blob nor anything derived from it may appear on the wire.
    raw = response.text
    assert "state_blob" not in raw
    assert SESSION_COOKIE not in raw
    assert "100000000000001" not in raw


def test_meta_404s_for_a_worker_with_no_snapshot(env):
    response = env.get("/v1/session/never-backed-up/meta", headers=ADMIN_AUTH)
    assert response.status_code == 404
    assert "never-backed-up" in response.json()["detail"]


def test_meta_requires_the_admin_token(env):
    backup(env)
    assert env.get("/v1/session/denver-1/meta").status_code == 401
    # A worker token is not an admin token, even a valid one.
    assert env.get("/v1/session/denver-1/meta", headers=worker_auth()).status_code == 401
    assert env.get("/v1/session/denver-1/meta", headers=LEGACY_AUTH).status_code == 401


# -- restore ---------------------------------------------------------------


def test_a_worker_restores_its_own_session(env):
    backup(env)
    response = env.get("/v1/session/denver-1/restore", headers=worker_auth("denver-1"))

    assert response.status_code == 200
    body = response.json()
    assert body["storage_state"] == sample_state()
    assert body["user_agent"].startswith("Mozilla/5.0")
    assert body["backed_up_at"]


def test_a_worker_cannot_restore_another_workers_session(env):
    backup(env, worker_id="denver-1")
    response = env.get("/v1/session/denver-1/restore", headers=worker_auth("tx-1"))

    assert response.status_code == 403
    assert SESSION_COOKIE not in response.text


def test_the_legacy_fleet_token_cannot_restore(env):
    """It is shared by the whole fleet, so it proves nothing about the caller."""
    backup(env)
    response = env.get("/v1/session/denver-1/restore", headers=LEGACY_AUTH)

    assert response.status_code == 403
    assert SESSION_COOKIE not in response.text


def test_restore_needs_a_token_at_all(env):
    backup(env)
    assert env.get("/v1/session/denver-1/restore").status_code == 401


def test_restore_404s_without_a_snapshot(env):
    assert env.get("/v1/session/tx-1/restore", headers=worker_auth("tx-1")).status_code == 404


def test_restore_reports_a_rotated_vault_key_as_a_503(env, monkeypatch):
    backup(env)

    # Simulate the key having been rotated since the snapshot was sealed.
    stale = Vault(generate_key())
    monkeypatch.setattr(env.deps, "get_vault", lambda: stale)
    response = env.get("/v1/session/denver-1/restore", headers=worker_auth("denver-1"))

    assert response.status_code == 503
    assert "does not match" in response.json()["detail"]


def test_the_snapshot_survives_a_coordinator_restart(env, tmp_path):
    """A rebuilt worker's whole reason for this feature: the backup outlives it."""
    backup(env)
    blob = env.db.get_snapshot("denver-1")["state_blob"]

    from rs_coordinator.db import Database

    reopened = Database(str(tmp_path / "session.db"))
    restored = env.vault.decrypt(reopened.get_snapshot("denver-1")["state_blob"])
    assert restored == json.loads(json.dumps(sample_state()))
    assert bytes(reopened.get_snapshot("denver-1")["state_blob"]) == bytes(blob)
    reopened.close()
