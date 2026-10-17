"""Escalation queue: a stuck worker asks for a human, and ops gets one page.

The contract this pins down is that an escalation is never lost — not to a
missing account mapping, not to an unreachable vault, not to a Telegram
outage — and that the evidence (screenshot, VNC link) reaches the operator.
"""

import base64
import importlib

import pytest
from fastapi.testclient import TestClient

from rs_coordinator.escalation import (
    MAX_SCREENSHOT_B64_CHARS,
    ScreenshotError,
    decode_screenshot,
    format_alert,
    resolve_vnc_url,
    screenshot_dir,
    to_challenge_out,
)
from rs_coordinator.tokens import mint_worker_token
from rs_coordinator.vault import generate_key

# A real 1x1 PNG, so the screenshot endpoint is proven to hand back image bytes
# rather than whatever the test happened to upload.
PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ"
    "/pLvAAAAAElFTkSuQmCC"
)
PNG_BYTES = base64.b64decode(PNG_B64)
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

VNC_URL = "https://vnc.example.com/denver-1"

WORKER_AUTH = {"Authorization": "Bearer test-token"}
ADMIN_AUTH = {"Authorization": "Bearer admin-token"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "test-token")
    monkeypatch.setenv("RS_ADMIN_TOKEN", "admin-token")
    monkeypatch.setenv("RS_WORKER_TOKEN_SECRET", "worker-token-secret")
    monkeypatch.setenv("RS_VAULT_KEY", generate_key())
    monkeypatch.setenv("RS_SCREENSHOT_DIR", str(tmp_path / "shots"))
    monkeypatch.delenv("TELEGRAM_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    monkeypatch.delenv("TELEGRAM_OPS_CHAT_ID", raising=False)

    import rs_coordinator.app as app_module
    import rs_coordinator.deps as deps_module

    # The process singletons live in deps, so it has to pick up the test env
    # (DB path, tokens, vault key) before app re-imports them.
    importlib.reload(deps_module)
    importlib.reload(app_module)

    sent = []
    app_module.ops_notifier.send = lambda text: (sent.append(text), True)[1]

    test_client = TestClient(app_module.app)
    test_client.sent = sent
    test_client.db = app_module.db
    test_client.deps = deps_module
    test_client.shots = tmp_path / "shots"
    yield test_client


def escalate(client, **overrides):
    payload = {"worker_id": "denver-1", "kind": "captcha", "screenshot_b64": PNG_B64}
    payload.update(overrides)
    return client.post("/v1/auth/escalate", json=payload, headers=WORKER_AUTH)


# -- helpers ---------------------------------------------------------------


def test_screenshot_dir_follows_the_env_and_is_created(tmp_path, monkeypatch):
    target = tmp_path / "nested" / "shots"
    monkeypatch.setenv("RS_SCREENSHOT_DIR", str(target))
    assert screenshot_dir() == target
    assert target.is_dir()


def test_data_url_prefix_is_tolerated():
    assert decode_screenshot(f"data:image/png;base64,{PNG_B64}") == PNG_BYTES
    # Clients that wrap long base64 must not be rejected over newlines.
    assert decode_screenshot(PNG_B64[:20] + "\n" + PNG_B64[20:]) == PNG_BYTES
    assert decode_screenshot(None) is None


def test_bad_and_oversized_payloads_raise_a_clear_error():
    with pytest.raises(ScreenshotError, match="not valid base64"):
        decode_screenshot("this is not base64!!!")
    with pytest.raises(ScreenshotError, match="too large"):
        decode_screenshot("A" * (MAX_SCREENSHOT_B64_CHARS + 4))


def test_worker_row_vnc_url_wins_over_the_account_row():
    assert resolve_vnc_url({"vnc_url": "live"}, {"vnc_url": "configured"}) == "live"
    assert resolve_vnc_url({"vnc_url": None}, {"vnc_url": "configured"}) == "configured"
    assert resolve_vnc_url(None, None) is None


def test_alert_names_the_worker_and_links_the_vnc_session():
    alert = format_alert(7, "denver-1", "captcha", VNC_URL, {"reason": "grid puzzle"})
    assert "captcha" in alert
    # Dynamic text is MarkdownV2-escaped, or Telegram rejects the message.
    assert "denver\\-1" in alert
    # …but the link target itself stays usable.
    assert f"({VNC_URL})" in alert
    assert "grid puzzle" in alert


def test_alert_says_so_when_no_vnc_url_is_known():
    alert = format_alert(7, "denver-1", "checkpoint", None, None)
    assert "No VNC URL" in alert


def test_to_challenge_out_parses_detail_and_links_only_stored_screenshots():
    row = {
        "id": 3,
        "worker_id": "denver-1",
        "account_id": "denver",
        "kind": "captcha",
        "status": "open",
        "vnc_url": VNC_URL,
        "screenshot_path": "/data/screenshots/3.png",
        "detail_json": '{"url": "https://facebook.com/checkpoint"}',
        "created_at": "2026-08-19T00:00:00+00:00",
        "resolved_at": None,
        "resolved_by": None,
    }
    out = to_challenge_out(row)
    assert out["detail"] == {"url": "https://facebook.com/checkpoint"}
    assert out["screenshot_url"] == "/v1/challenges/3/screenshot"

    # No file stored -> no URL to offer, and unparseable detail must not raise.
    out = to_challenge_out({**row, "screenshot_path": None, "detail_json": "not json"})
    assert out["screenshot_url"] is None
    assert out["detail"] == {"raw": "not json"}


# -- escalate --------------------------------------------------------------


def test_escalate_stores_the_challenge_screenshot_and_pages_ops_once(client):
    client.db.update_worker_health("denver-1", {"vnc_url": VNC_URL})

    body = escalate(client, detail={"reason": "image grid"}).json()
    assert body["vnc_url"] == VNC_URL

    row = client.db.get_challenge(body["challenge_id"])
    assert row["worker_id"] == "denver-1"
    assert row["kind"] == "captcha"
    assert row["status"] == "open"

    stored = client.shots / f"{body['challenge_id']}.png"
    assert row["screenshot_path"] == str(stored)
    assert stored.read_bytes() == PNG_BYTES

    # Exactly one page, carrying the link the operator needs.
    assert len(client.sent) == 1
    assert VNC_URL in client.sent[0]
    assert "denver" in client.sent[0]


def test_escalate_requires_a_worker_token(client):
    assert client.post("/v1/auth/escalate", json={"worker_id": "denver-1"}).status_code == 401
    assert (
        client.post(
            "/v1/auth/escalate",
            json={"worker_id": "denver-1"},
            headers={"Authorization": "Bearer wrong"},
        ).status_code
        == 401
    )


def test_a_per_worker_token_overrides_the_claimed_worker_id(client):
    token = mint_worker_token("denver-1", "worker-token-secret")
    body = client.post(
        "/v1/auth/escalate",
        json={"worker_id": "someone-else", "kind": "checkpoint"},
        headers={"Authorization": f"Bearer {token}"},
    ).json()
    assert client.db.get_challenge(body["challenge_id"])["worker_id"] == "denver-1"


def test_escalation_survives_a_worker_with_no_registered_account(client):
    """A stuck worker must be heard even if the fleet config forgot it."""
    response = escalate(client, account_id="denver-unregistered")
    assert response.status_code == 200

    row = client.db.get_challenge(response.json()["challenge_id"])
    # Falls back to what the worker claimed rather than 404-ing the escalation.
    assert row["account_id"] == "denver-unregistered"
    assert len(client.sent) == 1


def test_escalation_survives_an_unreachable_vault(client, monkeypatch):
    monkeypatch.delenv("RS_VAULT_KEY", raising=False)
    client.deps.get_vault.cache_clear()

    response = escalate(client)
    assert response.status_code == 200
    assert client.db.get_challenge(response.json()["challenge_id"])["status"] == "open"


def test_registered_account_supplies_the_vnc_url(client):
    client.deps.get_account_store().put_account(
        "denver",
        {"password": "pw"},
        worker_id="denver-1",
        vnc_url=VNC_URL,
    )
    body = escalate(client).json()
    assert body["vnc_url"] == VNC_URL

    row = client.db.get_challenge(body["challenge_id"])
    assert row["account_id"] == "denver"
    assert row["vnc_url"] == VNC_URL


def test_invalid_base64_is_a_400_and_leaves_no_challenge_behind(client):
    response = escalate(client, screenshot_b64="not-valid-base64!!")
    assert response.status_code == 400
    assert "base64" in response.json()["detail"]
    assert client.db.list_challenges("all") == []
    assert client.sent == []


def test_a_failing_ops_alert_does_not_fail_the_escalation(client):
    def explode(text):
        raise RuntimeError("telegram is down")

    client.deps.ops_notifier.send = explode
    response = escalate(client)
    assert response.status_code == 200
    assert client.db.get_challenge(response.json()["challenge_id"]) is not None


# -- console ---------------------------------------------------------------


def test_open_challenge_is_listed_then_leaves_the_queue_when_resolved(client):
    challenge_id = escalate(client, detail={"reason": "image grid"}).json()["challenge_id"]

    listed = client.get("/v1/challenges", headers=ADMIN_AUTH).json()["challenges"]
    assert len(listed) == 1
    assert listed[0]["id"] == challenge_id
    assert listed[0]["status"] == "open"
    assert listed[0]["detail"] == {"reason": "image grid"}
    assert listed[0]["screenshot_url"] == f"/v1/challenges/{challenge_id}/screenshot"

    resolved = client.post(
        f"/v1/challenges/{challenge_id}/resolve", json={"resolved_by": "jinhu"}, headers=ADMIN_AUTH
    )
    assert resolved.json()["status"] == "ok"

    assert client.get("/v1/challenges", headers=ADMIN_AUTH).json()["challenges"] == []
    everything = client.get("/v1/challenges?status=all", headers=ADMIN_AUTH).json()["challenges"]
    assert everything[0]["status"] == "resolved"
    assert everything[0]["resolved_by"] == "jinhu"
    assert everything[0]["resolved_at"]


def test_resolving_twice_reports_the_state_instead_of_failing(client):
    challenge_id = escalate(client).json()["challenge_id"]
    client.post(f"/v1/challenges/{challenge_id}/resolve", json={}, headers=ADMIN_AUTH)

    second = client.post(f"/v1/challenges/{challenge_id}/resolve", json={}, headers=ADMIN_AUTH)
    assert second.status_code == 200
    assert second.json()["status"] == "already_resolved"


def test_resolving_an_unknown_challenge_is_404(client):
    assert client.post("/v1/challenges/999/resolve", json={}, headers=ADMIN_AUTH).status_code == 404


def test_console_endpoints_are_admin_only(client):
    challenge_id = escalate(client).json()["challenge_id"]
    for path in ("/v1/challenges", f"/v1/challenges/{challenge_id}/screenshot"):
        assert client.get(path).status_code == 401
        # A worker token is not an admin token.
        assert client.get(path, headers=WORKER_AUTH).status_code == 401
    assert (
        client.post(f"/v1/challenges/{challenge_id}/resolve", json={}, headers=WORKER_AUTH).status_code
        == 401
    )


def test_screenshot_endpoint_serves_the_captured_png(client):
    challenge_id = escalate(client).json()["challenge_id"]
    response = client.get(f"/v1/challenges/{challenge_id}/screenshot", headers=ADMIN_AUTH)

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content == PNG_BYTES
    assert response.content.startswith(PNG_MAGIC)


def test_screenshot_is_404_when_none_was_captured(client):
    challenge_id = escalate(client, screenshot_b64=None).json()["challenge_id"]

    listed = client.get("/v1/challenges", headers=ADMIN_AUTH).json()["challenges"]
    assert listed[0]["screenshot_url"] is None
    assert client.get(
        f"/v1/challenges/{challenge_id}/screenshot", headers=ADMIN_AUTH
    ).status_code == 404
    assert client.get("/v1/challenges/999/screenshot", headers=ADMIN_AUTH).status_code == 404
