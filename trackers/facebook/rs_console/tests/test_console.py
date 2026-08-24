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
        "/v1/config/filter-prompt",
    ):
        assert client.get(path).status_code == 401, path
    assert client.post("/v1/challenges/1/resolve").status_code == 401


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


def test_no_auth_routes_exist(client):
    # The coordinator's dangerous surface must not exist here at all — 404,
    # not 401, so a future catch-all proxy would fail this loudly.
    for path in ("/v1/auth/code", "/v1/auth/credentials", "/v1/session/x/restore"):
        assert client.post(path, headers=AUTH).status_code in (404, 405), path
        assert client.get(path, headers=AUTH).status_code in (404, 405), path


def test_healthz_is_open(client):
    assert client.get("/healthz").status_code == 200
