"""A10-04: a stale backup of the slot's previous login overwrites a seeded pool cookie."""
from test_session_backup import (  # noqa: F401  (env fixture)
    env, backup, own_device, seed, worker_auth, sample_state,
)

NEW_UID = "200000000000002"


def test_old_login_backup_after_seed_kills_the_restore(env):
    old_device = own_device(env)            # slot holds old login (uid ...001)
    backup(env, device_id=old_device)
    # ERP Assign: new pool account on the slot, then PUT /session with its cookie
    env.deps.get_account_store().put_account(
        "denver", {"password": "pw"}, worker_id="denver-1", fb_uid=NEW_UID
    )
    r = seed(env, cookie=f"c_user={NEW_UID}; xs=seed-xs; datr=d; sb=s")
    assert r.status_code == 200, r.text
    ok = env.get("/v1/session/denver-1/restore", headers=worker_auth("denver-1"))
    assert ok.status_code == 200          # seed is restorable right now
    # The worker's periodic save of the browser it still has (old login) lands
    r = backup(env, device_id=old_device)
    assert r.status_code == 200, r.text   # accepted, replaces the seed
    restored = env.get("/v1/session/denver-1/restore", headers=worker_auth("denver-1"))
    print("restore after stale backup:", restored.status_code, restored.json().get("detail", "")[:120])
    assert restored.status_code == 409    # the seeded cookie is gone
