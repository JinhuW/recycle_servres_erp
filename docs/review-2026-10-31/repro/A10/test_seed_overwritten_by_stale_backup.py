"""A10 repro: a seeded pool cookie is replaced by the slot's previous login.

Run from trackers/facebook/rs_coordinator with the coordinator's venv:
  .venv-review/bin/python -m pytest -q -p no:cacheprovider \
      ../../../docs/review-2026-10-31/repro/A10/test_seed_overwritten_by_stale_backup.py \
      --rootdir tests -c /dev/null
It reuses the fixtures of tests/test_session_backup.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "tests"))
from test_session_backup import (  # noqa: E402
    UID, WORKER_SECRET, env, register_account, sample_state, seed, worker_auth,  # noqa: F401
)

OLD_UID = "999999999999999"


def test_stale_backup_replaces_seeded_snapshot(env):  # noqa: F811
    register_account(env)                      # slot now holds account UID
    assert seed(env, reason="assign").status_code == 200
    assert env.get("/v1/session/denver-1/restore", headers=worker_auth()).status_code == 200

    # The browser still carries the previous login and saves it (its periodic backup).
    stale = sample_state()
    for c in stale["cookies"]:
        if c["name"] == "c_user":
            c["value"] = OLD_UID
    r = env.post("/v1/session/backup", json={"storage_state": stale}, headers=worker_auth())
    assert r.status_code == 200                # accepted, although not this account's login

    snap = env.db.get_snapshot("denver-1")
    assert snap["fb_user_id"] == OLD_UID       # the seeded cookie is gone
    # ...and the restore the ERP queued now refuses: the worker falls back to a password login.
    assert env.get("/v1/session/denver-1/restore", headers=worker_auth()).status_code == 409
