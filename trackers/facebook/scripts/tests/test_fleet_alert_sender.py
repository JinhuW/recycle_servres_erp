"""One pass of scripts/fleet-alert-sender.py against stand-ins for
OpenSearch, the coordinator and Telegram.

    .venv-coordinator/bin/python -m pytest scripts/tests/test_fleet_alert_sender.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import urllib.error
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "fleet-alert-sender.py"
spec = importlib.util.spec_from_file_location("fleet_alert_sender", SCRIPT)
sender = importlib.util.module_from_spec(spec)
sys.modules["fleet_alert_sender"] = sender
spec.loader.exec_module(sender)  # type: ignore[union-attr]

ENV = {"TELEGRAM_CHAT_ID": "-100", "TELEGRAM_TOKEN": "made-up", "TELEGRAM_TOPIC_HIGH": "7"}


def alert(at: str = "2026-10-30T01:00:00.000+00:00") -> dict:
    return {"@timestamp": at, "worker": "homelab-1", "listing_id": "111", "title": "Lot of RAM",
            "url": "https://www.facebook.com/marketplace/item/111/", "score": 4, "item": "ram"}


class World:
    def __init__(self, monkeypatch, tmp_path):
        self.alerts = [alert()]
        self.verdict = {"unit_count": "60", "price": "$500", "location": "Denver, CO"}
        self.claims: list[str] = ["new"]
        self.fail_delivered = 0
        self.unauthorized = 0
        self.sent: list[str] = []
        self.calls: list[tuple[str, str | None]] = []
        self.minted = 0
        self.tokens: dict = {}
        monkeypatch.setattr(sender, "STATE", str(tmp_path / "state.json"))
        monkeypatch.setattr(sender, "SEND_GAP_S", 0)
        monkeypatch.setattr(sender, "withheld", lambda hours: self.alerts)
        monkeypatch.setattr(sender, "verdict", lambda lid: self.verdict)
        monkeypatch.setattr(sender, "call", self.call)
        monkeypatch.setattr(sender.subprocess, "run", self.mint)

    def mint(self, *args, **kwargs):
        self.minted += 1
        return type("Done", (), {"stdout": f"token-{self.minted}\n"})()

    def call(self, url: str, body: dict | None = None, token: str | None = None) -> dict:
        if "api.telegram.org" in url:
            self.sent.append(body["text"])
            return {"result": {"message_id": len(self.sent), "chat": {"id": -100}}}
        path = url.split("8500", 1)[1]
        self.calls.append((path, token))
        if self.unauthorized:
            self.unauthorized -= 1
            raise urllib.error.HTTPError(url, 401, "no", {}, io.BytesIO(b"{}"))
        if path == "/v1/alerts/claim":
            verdict = self.claims.pop(0)
            return {"send": verdict in ("new", "discounted"), "verdict": verdict}
        if path == "/v1/alerts/claim/delivered" and self.fail_delivered:
            self.fail_delivered -= 1
            raise urllib.error.URLError("coordinator timed out")
        return {"ok": True}

    def run(self):
        return sender.run_once(24, False, ENV, self.tokens)

    def state(self) -> dict:
        return json.load(open(sender.STATE))


@pytest.fixture
def world(monkeypatch, tmp_path):
    return World(monkeypatch, tmp_path)


def test_routes_a_count_logged_as_a_string():
    assert sender.priority("60") == "high"
    assert sender.priority("12") == "medium"
    assert sender.priority(0) is None and sender.priority("lots") is None


def test_sends_once_and_reports(world):
    assert world.run() == (1, 0)
    assert len(world.sent) == 1 and world.sent[0].startswith("*🔥")
    assert [p for p, _ in world.calls] == ["/v1/alerts/claim", "/v1/alerts/claim/delivered", "/v1/alerts/telegram"]
    assert "report" not in world.state()["111"]
    assert world.run() == (0, 0)
    assert len(world.sent) == 1


def test_a_failed_report_after_the_send_is_retried_never_resent(world):
    world.fail_delivered = 1
    with pytest.raises(urllib.error.URLError):
        world.run()
    assert len(world.sent) == 1 and "report" in world.state()["111"]
    world.run()
    assert len(world.sent) == 1
    assert [p for p, _ in world.calls][-2:] == ["/v1/alerts/claim/delivered", "/v1/alerts/telegram"]
    assert "report" not in world.state()["111"]


def test_another_workers_pending_claim_is_asked_again(world):
    world.claims = ["pending", "new"]
    assert world.run() == (0, 0)
    assert "111" not in (json.load(open(sender.STATE)) if Path(sender.STATE).exists() else {})
    assert world.run() == (1, 0)


def test_a_later_sighting_reaches_the_coordinator_for_a_price_drop(world):
    world.claims = ["duplicate"]
    assert world.run() == (0, 1)
    assert world.run() == (0, 0)  # the same sighting: not asked again
    world.alerts = [alert("2026-10-30T05:00:00.000+00:00")]
    world.verdict = {**world.verdict, "price": "$300"}
    world.claims = ["discounted"]
    assert world.run() == (1, 0)
    assert world.state()["111"]["verdict"] == "discounted"


def test_an_entry_from_before_seen_is_matched_by_when_it_was_handled(world):
    Path(sender.STATE).write_text(json.dumps({"111": {"verdict": "new", "sent": 9, "at": "2026-10-30 02:00:00"}}))
    assert world.run() == (0, 0)
    assert world.calls == []


def test_a_rejected_token_is_minted_again(world):
    world.unauthorized = 1
    assert world.run() == (1, 0)
    assert world.minted == 2
    assert world.calls[0][1] == "token-1" and world.calls[1][1] == "token-2"
