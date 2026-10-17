"""Settings saved from the ERP: what may change, and how it reaches a worker.

What must stay true: only the listed keys can change; a bad value writes
nothing; a worker config keeps its inode and its comments; a config with no
saved values renders to itself (the deploy's verify depends on it); and the
values survive in the console's state file, not in master.toml.
"""

import json
import os
import tomllib

import httpx
import pytest
from fastapi.testclient import TestClient

import rs_console.app as console
from rs_console import settings

AUTH = {"Authorization": "Bearer console-token"}

MASTER = """\
# master comment
[ai.openrouter]
api_key = "${OPENROUTER_API_KEY}"
model = "openai/gpt-5.6-luna"

[marketplace.facebook]
start_at = ["10:00"]
date_listed = ["last 7 days", "last 7 days"]
delivery_method = "local_pick_up"
max_results = 120
title_prefilter = true
min_seller_rating = 4.5
exclude_unrated_sellers = false
search_interval = "45m"
max_search_interval = "75m"
rating = 4  # keep this comment
min_unit_count = 5
prompt = \"\"\"judge the listing\"\"\"
rating_prompt = \"\"\"rate 1-5\"\"\"
proxy_server = "${PROXY_HOMELAB}"

[item.server_ram]
search_phrases = ["server ram"]
keywords = ["ram OR ddr4"]
antikeywords = ["single stick"]

[user.recycle]
telegram_chat_id = "${TELEGRAM_CHAT_ID}"
"""


@pytest.fixture()
def env(monkeypatch, tmp_path):
    (tmp_path / "master.toml").write_text(MASTER)
    workers = [tmp_path / "homelab.toml", tmp_path / "homelab-ne.toml"]
    for w in workers:
        w.write_text("# generated\n" + MASTER)
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("RS_CONSOLE_TOKEN", "console-token")
    monkeypatch.setenv("RS_COORDINATOR_URL", "http://upstream:8500")
    monkeypatch.setenv("RS_COORDINATOR_ADMIN_TOKEN", "admin-secret")
    monkeypatch.setenv("RS_MASTER_CONFIG", str(tmp_path / "master.toml"))
    monkeypatch.setenv("RS_MONITOR_CONFIG", str(workers[0]))
    monkeypatch.setenv("RS_WORKER_CONFIGS", ",".join(str(w) for w in workers))
    monkeypatch.setenv("RS_SETTINGS_STATE", str(state / "settings.json"))
    monkeypatch.setenv("RS_FLEET_CONFIG", str(tmp_path / "absent-fleet.toml"))

    async def upstream(request):
        return httpx.Response(200, json={"workers": [], "accounts": []})

    real_client = httpx.AsyncClient

    class FakeClient(real_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(upstream)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(console.httpx, "AsyncClient", FakeClient)
    return {"client": TestClient(console.app), "workers": workers, "state": state / "settings.json",
            "master": tmp_path / "master.toml"}


def test_put_writes_every_worker_config_in_place(env):
    inodes = [os.stat(w).st_ino for w in env["workers"]]
    res = env["client"].put(
        "/v1/config/settings",
        json={
            "search": {"rating": 3, "date_listed": "last 24 hours", "prompt": "new prompt\nsecond line"},
            "ai_model": "openai/other",
            "items": {"server_ram": {"keywords": ["ram", " ddr5 ", ""]}},
            "updated_by": "Jinhu",
        },
        headers=AUTH,
    )
    assert res.status_code == 200, res.text
    assert res.json()["changed"] == ["homelab.toml", "homelab-ne.toml"]
    assert res.json()["updated_by"] == "Jinhu"

    for path, inode in zip(env["workers"], inodes):
        assert os.stat(path).st_ino == inode, "a replaced file is invisible to a bind mount"
        text = path.read_text()
        assert text.startswith("# generated\n# master comment\n")
        assert "rating = 3  # keep this comment" in text
        parsed = tomllib.loads(text)
        fb = parsed["marketplace"]["facebook"]
        assert fb["date_listed"] == ["last 24 hours", "last 24 hours"]
        assert fb["prompt"].rstrip() == "new prompt\nsecond line"
        assert fb["proxy_server"] == "${PROXY_HOMELAB}"
        assert parsed["ai"]["openrouter"]["model"] == "openai/other"
        assert parsed["item"]["server_ram"]["keywords"] == ["ram", "ddr5"]

    # master.toml is the default, never the target.
    assert env["master"].read_text() == MASTER
    saved = json.loads(env["state"].read_text())
    assert saved["values"]["search"]["rating"] == 3
    assert saved["updated_by"] == "Jinhu"


def test_fleet_shows_the_saved_values(env):
    client = env["client"]
    before = client.get("/v1/fleet", headers=AUTH).json()
    assert before["settings"]["editable"] is True
    assert before["search"]["rating"] == 4
    assert before["search"]["start_at"] == ["10:00"]

    client.put("/v1/config/settings", json={"search": {"start_at": ["09:30", "21:00"]}}, headers=AUTH)
    after = client.get("/v1/fleet", headers=AUTH).json()
    assert after["search"]["start_at"] == ["09:30", "21:00"]
    assert after["settings"]["updated_at"]


@pytest.mark.parametrize(
    "body",
    [
        {"search": {"rating": 7}},
        {"search": {"rating": True}},
        {"search": {"proxy_server": "http://evil"}},
        {"search": {"start_at": ["25:00"]}},
        {"search": {"date_listed": "last year"}},
        {"search": {"search_interval": "2h"}},  # longer than max 75m
        {"search": {"prompt": "   "}},
        {"items": {"server_cpu": {"keywords": ["xeon"]}}},
        {"items": {"server_ram": {"search_phrases": [""]}}},
        {"items": {"server_ram": {"description": "x"}}},
        {"ai_model": "bad model id"},
        {"telegram_chat_id": "123"},
        {},
    ],
)
def test_bad_input_is_a_400_and_writes_nothing(env, body):
    before = [w.read_text() for w in env["workers"]]
    res = env["client"].put("/v1/config/settings", json=body, headers=AUTH)
    assert res.status_code == 400, body
    assert res.json()["detail"]
    assert [w.read_text() for w in env["workers"]] == before
    assert not env["state"].exists()


def test_token_required(env):
    assert env["client"].put("/v1/config/settings", json={"search": {"rating": 3}}).status_code == 401


def test_read_only_mounts_refuse_and_say_why(env):
    os.chmod(env["workers"][1], 0o444)
    try:
        if os.access(env["workers"][1], os.W_OK):
            pytest.skip("running as root; permissions are not enforced")
        assert env["client"].get("/v1/fleet", headers=AUTH).json()["settings"]["editable"] is False
        res = env["client"].put("/v1/config/settings", json={"search": {"rating": 3}}, headers=AUTH)
        assert res.status_code == 409
    finally:
        os.chmod(env["workers"][1], 0o644)


def test_saves_accumulate(env):
    client = env["client"]
    client.put("/v1/config/settings", json={"search": {"rating": 3}}, headers=AUTH)
    client.put("/v1/config/settings", json={"search": {"min_unit_count": 10}}, headers=AUTH)
    fb = tomllib.loads(env["workers"][0].read_text())["marketplace"]["facebook"]
    assert (fb["rating"], fb["min_unit_count"]) == (3, 10)


def test_render_without_values_is_the_identity():
    assert settings.render(MASTER, {}) == MASTER


def test_render_cli_applies_saved_values(env, monkeypatch, capsys):
    settings.save(settings.stamp({"search": {"max_results": 60}}, "x"))
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(MASTER))
    assert settings.main(["settings", "render"]) == 0
    assert tomllib.loads(capsys.readouterr().out)["marketplace"]["facebook"]["max_results"] == 60


def test_a_corrupt_state_file_is_an_error_not_empty(env):
    env["state"].write_text("[]")
    with pytest.raises(settings.SettingsError):
        settings.load()
    assert env["client"].get("/v1/fleet", headers=AUTH).json()["settings"]["editable"] is False
