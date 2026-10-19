"""The facade's whole contract: allowlist, auth, and never leaking upstream.

What must stay true: every fleet route needs the console token; the coordinator
admin token appears in upstream requests and nowhere in any response; the
prompt endpoint returns exactly three fields from the mounted TOML; and no
route outside the allowlist exists at all.
"""

import httpx
import pytest
from fastapi.testclient import TestClient

import rs_console.app as console

AUTH = {"Authorization": "Bearer console-token"}


@pytest.fixture()
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("RS_CONSOLE_TOKEN", "console-token")
    monkeypatch.setenv("RS_COORDINATOR_URL", "http://upstream:8500")
    monkeypatch.setenv("RS_COORDINATOR_ADMIN_TOKEN", "admin-secret")
    monkeypatch.setenv("RS_MONITOR_CONFIG", str(tmp_path / "monitor.toml"))

    (tmp_path / "monitor.toml").write_text(
        '[ai.openrouter]\nmodel = "openai/gpt-5.6-luna"\napi_key = "SECRET"\n\n'
        '[marketplace.facebook]\nprompt = "judge the listing"\n'
        'rating_prompt = "rate 1-5"\npassword = "SECRET"\n'
    )

    # Capture upstream calls instead of making them.
    calls = []

    async def fake_forward_transport(request):
        calls.append(request)
        return httpx.Response(200, json={"workers": []})

    real_client = httpx.AsyncClient

    class FakeClient(real_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(fake_forward_transport)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(console.httpx, "AsyncClient", FakeClient)

    test_client = TestClient(console.app)
    test_client.calls = calls
    yield test_client


def test_token_required_everywhere(client):
    for path in (
        "/v1/workers",
        "/v1/challenges",
        "/v1/challenges/1/screenshot",
        "/v1/stats/reviews",
        "/v1/stats/alert-hits",
        "/v1/config/filter-prompt",
    ):
        assert client.get(path).status_code == 401, path
    assert client.post("/v1/challenges/1/resolve").status_code == 401
    assert client.post("/v1/vnc/homelab-1/ticket").status_code == 401


def test_city_tiers_forward_only_settings_pins_and_who(client):
    assert client.get("/v1/city-tiers").status_code == 401
    assert client.put("/v1/city-tiers", json={}).status_code == 401
    assert client.get("/v1/city-tiers", headers=AUTH).status_code == 200
    res = client.put(
        "/v1/city-tiers",
        json={"settings": {"top_pct": 10}, "pins": {"denver": 3}, "updated_by": " alex ",
              "worker_id": "se-1"},
        headers=AUTH,
    )
    assert res.status_code == 200
    get, put = client.calls
    assert (get.method, get.url.path) == ("GET", "/v1/city-tiers")
    assert (put.method, put.url.path) == ("PUT", "/v1/city-tiers")
    assert put.headers["Authorization"] == "Bearer admin-secret"
    import json

    assert json.loads(put.content) == {
        "settings": {"top_pct": 10}, "pins": {"denver": 3}, "updated_by": "alex",
    }
    assert client.put("/v1/city-tiers", json=[1], headers=AUTH).status_code == 400


def test_unset_token_fails_closed(client, monkeypatch):
    monkeypatch.delenv("RS_CONSOLE_TOKEN")
    assert client.get("/v1/workers", headers=AUTH).status_code == 503


def test_forwards_with_admin_token_and_never_echoes_it(client):
    res = client.get("/v1/workers", headers=AUTH)
    assert res.status_code == 200
    assert res.json() == {"workers": []}

    (request,) = client.calls
    assert str(request.url) == "http://upstream:8500/v1/workers"
    assert request.headers["Authorization"] == "Bearer admin-secret"
    assert "admin-secret" not in res.text


def test_resolve_passes_only_resolved_by(client):
    res = client.post(
        "/v1/challenges/7/resolve",
        headers=AUTH,
        json={"resolved_by": "jinhu", "worker_id": "sneaky", "kind": "x"},
    )
    assert res.status_code == 200
    (request,) = client.calls
    assert request.url.path == "/v1/challenges/7/resolve"
    assert request.read() == b'{"resolved_by":"jinhu"}'


def test_stats_days_param_forwarded_and_bounded(client):
    assert client.get("/v1/stats/reviews?days=30", headers=AUTH).status_code == 200
    (request,) = client.calls
    assert request.url.params["days"] == "30"
    assert client.get("/v1/stats/reviews?days=5000", headers=AUTH).status_code == 422


def test_alert_hits_forwarded_with_admin_token(client):
    res = client.get("/v1/stats/alert-hits?days=30", headers=AUTH)
    assert res.status_code == 200

    (request,) = client.calls
    assert request.url.path == "/v1/stats/alert-hits"
    assert request.url.params["days"] == "30"
    assert request.headers["Authorization"] == "Bearer admin-secret"
    assert "admin-secret" not in res.text
    assert client.get("/v1/stats/alert-hits?days=0", headers=AUTH).status_code == 422


def test_filter_prompt_returns_three_fields_only(client):
    res = client.get("/v1/config/filter-prompt", headers=AUTH)
    assert res.status_code == 200
    assert res.json() == {
        "prompt": "judge the listing",
        "rating_prompt": "rate 1-5",
        "model": "openai/gpt-5.6-luna",
    }
    assert "SECRET" not in res.text


def test_missing_config_is_404(client, monkeypatch, tmp_path):
    monkeypatch.setenv("RS_MONITOR_CONFIG", str(tmp_path / "absent.toml"))
    assert client.get("/v1/config/filter-prompt", headers=AUTH).status_code == 404


def test_relogin_forwards_to_coordinator_with_admin_token(client):
    assert client.post("/v1/workers/homelab-1/relogin").status_code == 401

    res = client.post("/v1/workers/homelab-1/relogin", headers=AUTH)
    assert res.status_code == 200

    (request,) = client.calls
    assert request.method == "POST"
    assert request.url.path == "/v1/workers/homelab-1/relogin"
    assert request.headers["Authorization"] == "Bearer admin-secret"
    assert "admin-secret" not in res.text


def test_no_auth_routes_exist(client):
    # The coordinator's dangerous surface must not exist here at all — 404,
    # not 401, so a future catch-all proxy would fail this loudly.
    for path in ("/v1/auth/code", "/v1/auth/credentials", "/v1/session/x/restore"):
        assert client.post(path, headers=AUTH).status_code in (404, 405), path
        assert client.get(path, headers=AUTH).status_code in (404, 405), path


def test_healthz_is_open(client):
    assert client.get("/healthz").status_code == 200


def test_shells_version_their_assets_and_static_revalidates(client, monkeypatch):
    # A stale cached fleet.css hid the whole viewer once; the shells must
    # point at a URL that changes with the asset, and /static must not be
    # cached without asking.
    monkeypatch.setenv("RS_VNC_TARGETS", "w=127.0.0.1:1")
    for path in ("/", "/vnc/w"):
        res = client.get(path)
        assert res.status_code == 200, path
        assert f"/static/fleet.css?v={console.ASSET_VERSION}" in res.text, path
        assert "__ASSET_V__" not in res.text
        assert res.headers["cache-control"] == "no-cache"
    assert client.get("/static/fleet.css").headers["cache-control"] == "no-cache"
    assert client.get("/static/novnc/core/rfb.js").headers["cache-control"] == "no-cache"
    assert len(console.ASSET_VERSION) == 10


def test_put_account_forwards_only_the_allowed_fields(client):
    body = {
        "worker_id": "ne-1",
        "fb_username": "lisa@example.com",
        "fb_uid": "100000000000001",
        "allow_password_login": True,
        "proxy": "http://user:pass@proxy.example:10002",  # not settable from here
        "vnc_url": "vnc://x",
        "secrets": {"password": "s3cret-pw", "totp_secret": "JBSWY3DP", "bogus": "x", "email": None},
    }
    assert client.put("/v1/accounts/ne-1", json=body).status_code == 401

    res = client.put("/v1/accounts/ne-1", json=body, headers=AUTH)
    assert res.status_code == 200

    (request,) = client.calls
    assert request.method == "PUT"
    assert request.url.path == "/v1/accounts/ne-1"
    assert request.headers["Authorization"] == "Bearer admin-secret"
    import json

    sent = json.loads(request.content)
    assert sent == {
        "worker_id": "ne-1",
        "fb_username": "lisa@example.com",
        "fb_uid": "100000000000001",
        "allow_password_login": True,
        "secrets": {"password": "s3cret-pw", "totp_secret": "JBSWY3DP", "email": None},
    }
    # The upstream answer is passed through; this service adds nothing of its own.
    assert "admin-secret" not in res.text
    assert "s3cret-pw" not in res.text


def test_put_account_forwards_the_legacy_device_and_nothing_else_of_the_cookie(client):
    datr = {"name": "datr", "value": "legacy", "domain": ".facebook.com", "extra": "dropped"}
    res = client.put(
        "/v1/accounts/ne-1",
        json={"fb_uid": "100000000000001", "device_cookies": [datr]},
        headers=AUTH,
    )
    assert res.status_code == 200
    import json

    (request,) = client.calls
    assert json.loads(request.content)["device_cookies"] == [
        {"name": "datr", "value": "legacy", "domain": ".facebook.com"}
    ]

    for name in ("xs", "c_user", "fr"):
        bad = {"device_cookies": [{"name": name, "value": "v", "domain": ".facebook.com"}]}
        assert client.put("/v1/accounts/ne-1", json=bad, headers=AUTH).status_code == 400
    assert client.put("/v1/accounts/ne-1", json={"device_cookies": []}, headers=AUTH).status_code == 400
    assert len(client.calls) == 1


def test_put_account_refuses_a_bad_id_or_body_before_forwarding(client):
    assert client.put("/v1/accounts/bad%20id", json={}, headers=AUTH).status_code == 400
    assert client.put("/v1/accounts/ne-1", json=["not", "an", "object"], headers=AUTH).status_code == 400
    assert client.put(
        "/v1/accounts/ne-1", content=b"not json", headers={**AUTH, "Content-Type": "application/json"}
    ).status_code == 400
    assert client.calls == []


# -- cookie-first assign (RS-308) ---------------------------------------------


def test_restore_session_forwards_to_coordinator(client):
    assert client.post("/v1/workers/homelab-1/restore-session").status_code == 401

    res = client.post("/v1/workers/homelab-1/restore-session", headers=AUTH)
    assert res.status_code == 200

    (request,) = client.calls
    assert request.method == "POST"
    assert request.url.path == "/v1/workers/homelab-1/restore-session"
    assert request.headers["Authorization"] == "Bearer admin-secret"
    assert "admin-secret" not in res.text


def test_restore_session_refuses_a_bad_worker_id(client):
    assert client.post("/v1/workers/bad%20id/restore-session", headers=AUTH).status_code == 400
    assert client.calls == []


def test_seed_session_forwards_only_cookie_and_reason(client):
    import json

    body = {"cookie": "c_user=1; xs=s", "reason": "assign #2", "worker_id": "evil", "extra": "x"}
    assert client.put("/v1/workers/homelab-1/session", json=body).status_code == 401

    res = client.put("/v1/workers/homelab-1/session", json=body, headers=AUTH)
    assert res.status_code == 200

    (request,) = client.calls
    assert request.method == "PUT"
    assert request.url.path == "/v1/workers/homelab-1/session"
    assert request.headers["Authorization"] == "Bearer admin-secret"
    # Only the cookie and the reason cross; nothing else the caller tried to set.
    assert json.loads(request.content) == {"cookie": "c_user=1; xs=s", "reason": "assign #2"}


def test_seed_session_needs_a_cookie_string_and_a_valid_worker(client):
    assert client.put(
        "/v1/workers/homelab-1/session", json={"reason": "x"}, headers=AUTH
    ).status_code == 400
    assert client.put(
        "/v1/workers/bad%20id/session", json={"cookie": "x"}, headers=AUTH
    ).status_code == 400
    assert client.calls == []
