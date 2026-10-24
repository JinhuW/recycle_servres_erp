"""The monitor's fleet loop against the fake fleet, over real HTTP.

The exit criterion for the worker image short of a real backend: the
entrypoint claims and renders the config, the monitor loads that config,
logs in once, receives a manual task, "searches" it with the browser
mocked, reports it done and receives the next task without another login;
and when the slot's epoch moves on it leaves with 75, still without one.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Iterator, List
from unittest.mock import MagicMock

import pytest
import tomllib

from rs_worker import entry

from .fake_fleet import HOST_TOKEN, FakeFleet


@pytest.fixture
def fleet() -> Iterator[FakeFleet]:
    with FakeFleet(hold_seconds=0.2) as server:
        yield server


@pytest.fixture
def shared_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """What the host agent's secrets file gives every worker, made up."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "made-up-openrouter-key")
    monkeypatch.setenv("TELEGRAM_TOKEN", "123456789:made-up-bot-token")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-1001234567890")
    monkeypatch.setenv("RS_VNC_PORT", "5903")
    monkeypatch.delenv("RS_CONTROL_PLANE_TOKEN", raising=False)


class EndOfScriptError(Exception):
    pass


def rendered_config(fleet: FakeFleet, home: Path) -> Path:
    """What rs_worker.entry writes after a claim, as the monitor reads it."""
    answer = entry.claim(fleet.url, "lab", HOST_TOKEN, "lab-1", "0.14.0", 5903, sleep=lambda s: None)
    with open(entry.TEMPLATE, "rb") as f:
        template = tomllib.load(f)
    config = entry.render_config(template, answer, fleet.url, "lab-1", home)
    entry.write_files(home, answer, config)
    return home / "config.toml"


def monitor_for(
    monkeypatch: pytest.MonkeyPatch, config_path: Path, asks_allowed: int
) -> Dict[str, Any]:
    """A real MarketplaceMonitor on the rendered config, with the browser mocked.

    `login` records itself and gives the marketplace a page; `_search_city`
    counts a page of cards and opens nothing; the fleet client stops the loop
    after `asks_allowed` asks so the test can read what happened.
    """
    from ai_marketplace_monitor import monitor as monitor_mod
    from ai_marketplace_monitor.control_plane import FleetClient
    from ai_marketplace_monitor.facebook import FacebookMarketplace
    from ai_marketplace_monitor.monitor import MarketplaceMonitor

    seen: Dict[str, Any] = {"logins": 0, "searched": [], "sleeps": []}

    class Scripted(FleetClient):
        asks = 0

        def next_task(self, done: Any, wait: int) -> Any:
            Scripted.asks += 1
            if Scripted.asks > asks_allowed:
                raise EndOfScriptError()
            return super().next_task(done, wait)

    monkeypatch.setattr(monitor_mod, "FleetClient", Scripted)
    monkeypatch.setattr(monitor_mod.time, "sleep", lambda s: seen["sleeps"].append(s))

    def login(self: FacebookMarketplace) -> None:
        seen["logins"] += 1
        self.page = MagicMock()
        self.page.url = "https://www.facebook.com/marketplace/"

    def search_city(
        self: FacebookMarketplace, item_config: Any, found: Any, city: str, *rest: Any
    ) -> Any:
        seen["searched"].append((item_config.name, city))
        self.count_stage("searches")
        self.count_stage("cards", 40)
        yield from ()
        return False

    monkeypatch.setattr(FacebookMarketplace, "login", login)
    monkeypatch.setattr(FacebookMarketplace, "is_logged_in", lambda self: self.page is not None)
    monkeypatch.setattr(FacebookMarketplace, "_search_city", search_city)
    monkeypatch.setattr(FacebookMarketplace, "save_storage_state", lambda self: True)
    monkeypatch.setattr(FacebookMarketplace, "heartbeat_interval", 0)
    monkeypatch.setattr(MarketplaceMonitor, "active_marketplaces", {})

    monitor = MarketplaceMonitor.__new__(MarketplaceMonitor)
    monitor.config_files = [config_path]
    monitor.config = None
    monitor.config_hash = None
    monitor.headless = True
    monitor.defer_login_until_credentials = False
    monitor.ai_agents = []
    monitor.keyboard_monitor = None
    monitor.browser = MagicMock()
    monitor.logger = logging.getLogger("fleet-mode-test")
    monitor._ai_outage = None
    seen["monitor"] = monitor
    return seen


def test_the_worker_claims_logs_in_once_and_takes_task_after_task(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shared_env: None
) -> None:
    config_path = rendered_config(fleet, tmp_path / "home")
    first = fleet.add_task("houston", "server_ram", why="manual")
    second = fleet.add_task("denver", "enterprise_ssd", why="home", name="Denver, CO")
    seen = monitor_for(monkeypatch, config_path, asks_allowed=3)

    with pytest.raises(EndOfScriptError):
        seen["monitor"].fleet_loop()

    # One login, two tasks searched as handed, each closed with the next ask.
    assert seen["logins"] == 1
    assert seen["searched"] == [("server_ram", "houston"), ("enterprise_ssd", "denver")]
    assert [d["task_id"] for d in fleet.done] == [first["id"], second["id"]]
    assert fleet.done[0]["result"]["cards"] == 40
    assert set(fleet.done[0]["result"]) >= {"cards", "opened", "reviewed", "alerted", "seconds"}
    asks = [r for r in fleet.requests if r[1] == "/api/fleet/worker/next-task"]
    assert asks[0][2]["done"] is None
    assert all(a[2]["wait"] == 2 for a in asks)  # the claim's poll_hold_seconds
    # Heartbeats went to the fleet, HEALTHY, with the epoch and the VNC port.
    assert fleet.heartbeats and all(h["state"] == "HEALTHY" for h in fleet.heartbeats[1:])
    assert all(h["detail"]["epoch"] == 7 and h["vnc_port"] == 5903 for h in fleet.heartbeats)
    # The city log saw each task start and finish (the per-page `searched`
    # comes from the real _search_city, mocked here).
    kinds = [(e["task_id"], e["kind"]) for e in fleet.events]
    assert kinds == [
        (first["id"], "started"), (first["id"], "finished"),
        (second["id"], "started"), (second["id"], "finished"),
    ]
    assert fleet.heartbeats[0]["state"] == "DEGRADED"  # booting, before the login
    # The idle session check saved and uploaded the session to the pool, and
    # nothing but the fleet was talked to.
    assert fleet.sessions and fleet.sessions[0]["cookies"][0]["name"] == "c_user"
    assert {r[1] for r in fleet.requests} == {
        "/api/fleet/worker/claim",
        "/api/fleet/worker/heartbeat",
        "/api/fleet/worker/next-task",
        "/api/fleet/worker/events",
        "/api/fleet/worker/session",
    }
    # Only the monitor's own pause after each search; no backoff, no parked wait.
    assert seen["sleeps"] == [5, 5]


def test_a_stale_epoch_ends_the_worker_without_a_login(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shared_env: None
) -> None:
    config_path = rendered_config(fleet, tmp_path / "home")
    fleet.add_task("houston")
    seen = monitor_for(monkeypatch, config_path, asks_allowed=10)
    # Another claim moved the slot on before this worker's first ask.
    fleet.bump_epoch()

    with pytest.raises(SystemExit) as exit_:
        seen["monitor"].fleet_loop()

    assert exit_.value.code == entry.EXIT_RESTART == 75
    assert seen["logins"] == 1 and seen["searched"] == []
    assert fleet.tasks, "the task was not taken"
    marketplace = seen["monitor"].active_marketplaces["facebook"]
    assert marketplace.page is None


def test_an_empty_fleet_is_asked_again_and_an_unreachable_one_waited_for(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shared_env: None
) -> None:
    config_path = rendered_config(fleet, tmp_path / "home")
    seen = monitor_for(monkeypatch, config_path, asks_allowed=2)
    with pytest.raises(EndOfScriptError):
        seen["monitor"].fleet_loop()
    # Two held asks, nothing due, nothing searched, no sleep of our own.
    asks: List[Any] = [r for r in fleet.requests if r[1] == "/api/fleet/worker/next-task"]
    assert len(asks) == 2 and seen["searched"] == [] and seen["sleeps"] == []

    fleet.stop()
    seen = monitor_for(monkeypatch, config_path, asks_allowed=3)
    with pytest.raises(EndOfScriptError):
        seen["monitor"].fleet_loop()
    assert seen["sleeps"] == [30, 60, 120]
    assert seen["logins"] == 1
