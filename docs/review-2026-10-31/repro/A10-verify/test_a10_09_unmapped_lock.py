"""A10-09: a worker with no account mapping locks an account it merely names."""
from test_session_backup import env, worker_auth  # noqa: F401


def test_unmapped_worker_locks_someone_elses_account(env):
    env.deps.get_account_store().put_account("victim", {"password": "pw"}, worker_id="va-1")
    r = env.post("/v1/auth/escalate", json={"kind": "locked", "account_id": "victim"},
                 headers=worker_auth("fresh-9"))   # fresh-9 has no account
    print("escalate:", r.status_code)
    row = env.db.get_account_row("victim")
    print("victim locked_at:", row["locked_at"], "reason:", row["locked_reason"])
    assert row["locked_at"]
