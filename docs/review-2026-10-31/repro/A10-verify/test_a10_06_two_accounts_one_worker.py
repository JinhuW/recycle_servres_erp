"""A10-06: nothing below the API stops two accounts mapping to one worker."""
from test_session_backup import env, ADMIN_AUTH  # noqa: F401


def test_store_and_cli_path_accept_a_second_account_on_one_worker(env):
    store = env.deps.get_account_store()
    store.put_account("acct-a", {"password": "a"}, worker_id="va-1", fb_uid="111")
    # `rsc vault set-account acct-b --worker va-1` calls exactly this (cli.py:390)
    store.put_account("acct-b", {"password": "b"}, worker_id="va-1", fb_uid="222")
    rows = [a for a in env.db.list_accounts() if a["worker_id"] == "va-1"]
    print("accounts on va-1:", sorted(r["account_id"] for r in rows),
          "account_row_for_worker ->", env.db.account_row_for_worker("va-1")["account_id"])
    assert len(rows) == 2


def test_the_api_refuses_it(env):
    env.deps.get_account_store().put_account("acct-a", {"password": "a"}, worker_id="va-1")
    r = env.put("/v1/accounts/acct-b", json={"worker_id": "va-1", "password": "b"}, headers=ADMIN_AUTH)
    print("API second mapping:", r.status_code)
    assert r.status_code == 409
