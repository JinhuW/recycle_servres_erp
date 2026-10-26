"""The monitor's fleet loop against the fake fleet, over real HTTP.

The exit criterion for the worker image short of a real backend: the
entrypoint claims and renders the config, the monitor loads that config,
logs in once, receives a manual task, "searches" it with the browser
mocked, reports it done and receives the next task without another login;
and when the slot's epoch moves on it leaves with 75, still without one.
"""

from __future__ import annotations

import json
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
    monkeypatch: pytest.MonkeyPatch,
    config_path: Path,
    asks_allowed: int,
    stop: type[BaseException] = EndOfScriptError,
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
                raise stop()
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
    # Every fleet call names itself: Cloudflare refuses urllib's default agent.
    assert all(not r[3].get("user-agent", "").startswith("Python-urllib") for r in fleet.requests)
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
    assert seen["sleeps"] == [5, 5] + [1.0] * 30


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
    assert len(asks) == 2 and seen["searched"] == [] and seen["sleeps"] == [1.0] * 60

    fleet.stop()
    seen = monitor_for(monkeypatch, config_path, asks_allowed=3)
    with pytest.raises(EndOfScriptError):
        seen["monitor"].fleet_loop()
    assert seen["sleeps"] == [30, 60, 120]
    assert seen["logins"] == 1


def test_docker_stop_hands_the_last_result_back_and_takes_nothing(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shared_env: None
) -> None:
    config_path = rendered_config(fleet, tmp_path / "home")
    first = fleet.add_task("houston", "server_ram")
    waiting = fleet.add_task("denver", "server_ram")
    # SIGTERM reaches the monitor as KeyboardInterrupt (cli.py), here on the
    # ask after the first task.
    seen = monitor_for(monkeypatch, config_path, asks_allowed=1, stop=KeyboardInterrupt)
    with pytest.raises(KeyboardInterrupt):
        seen["monitor"].fleet_loop()

    assert seen["searched"] == [("server_ram", "houston")]
    asks = [r[2] for r in fleet.requests if r[1] == "/api/fleet/worker/next-task"]
    assert asks[-1] == {"done": fleet.done[-1], "wait": 0, "take": False}
    assert [d["task_id"] for d in fleet.done] == [first["id"]]
    # Nothing new was leased to a worker on its way out.
    assert fleet.tasks == [waiting]
    assert seen["logins"] == 1


def test_master_tomls_date_listed_list_reaches_the_search_url(
    fleet: FakeFleet, tmp_path: Path, shared_env: None
) -> None:
    from unittest.mock import MagicMock as Mock

    from ai_marketplace_monitor.config import Config
    from ai_marketplace_monitor.facebook import FacebookMarketplace

    # What configs/master.toml says, as the fleet hands it over in settings.search.
    literal = ["last 7 days", "last 7 days"]
    assert fleet_settings_search()["date_listed"] == literal
    config_path = rendered_config(fleet, tmp_path / "home")
    with open(config_path, "rb") as f:
        assert tomllib.load(f)["marketplace"]["facebook"]["date_listed"] == literal

    config = Config([config_path], logging.getLogger("fleet-mode-test"))
    assert config.marketplace["facebook"].date_listed == [7, 7]
    market = FacebookMarketplace("facebook", Mock())
    market.configure(config.marketplace["facebook"])
    item = config.item["server_ram"]
    first = market.base_search_options(item)
    item.searched_count += 1
    assert first == market.base_search_options(item) == [
        "daysSinceListed=7",
        "deliveryMethod=local_pick_up",
    ]


def fleet_settings_search() -> Dict[str, Any]:
    from .fake_fleet import SETTINGS

    return dict(SETTINGS["search"])


# ---------------------------------------------------------------------------
# the MVP: no coordinator
# ---------------------------------------------------------------------------
def test_without_a_coordinator_the_worker_searches_judges_and_notifies(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shared_env: None
) -> None:
    import urllib.request

    from ai_marketplace_monitor.ai import AIResponse
    from ai_marketplace_monitor.facebook import FacebookMarketplace
    from ai_marketplace_monitor.listing import Listing
    from ai_marketplace_monitor.monitor import MarketplaceMonitor
    from ai_marketplace_monitor.notification import NotificationStatus
    from ai_marketplace_monitor.user import User

    fleet.settings["coordinator_url"] = ""
    # Even with a token about, nothing may find a coordinator.
    monkeypatch.setenv("RS_CONTROL_PLANE_TOKEN", "made-up-control-plane-token")
    monkeypatch.delenv("RS_CONTROL_PLANE_URL", raising=False)
    config_path = rendered_config(fleet, tmp_path / "home")
    task = fleet.add_task("houston", "server_ram")
    seen = monitor_for(monkeypatch, config_path, asks_allowed=2)

    lot = Listing(
        marketplace="facebook", name="server_ram", id="9000000000001", title="24x 32GB DDR4 ECC",
        image="", price="$400", post_url="https://www.facebook.com/marketplace/item/9000000000001/",
        location="Houston, TX", seller="made-up seller", condition="used",
        description="A box of 24 sticks of 32GB DDR4 ECC RDIMM.",
    )

    def search_city(self: FacebookMarketplace, item_config: Any, found: Any, city: str, *rest: Any) -> Any:
        seen["searched"].append((item_config.name, city))
        self.count_stage("cards", 1)
        yield lot
        return False

    judged: List[str] = []
    notified: List[str] = []

    def evaluate_by_ai(self: MarketplaceMonitor, item: Listing, **_: Any) -> AIResponse:
        judged.append(item.id)
        return AIResponse(score=5, comment="24x 32GB DDR4 ECC RDIMM, $400", name="openrouter",
                          unit_count=24)

    def notify(self: User, listings: List[Listing], *_: Any) -> bool:
        notified.append(listings[0].id)
        return True

    monkeypatch.setattr(FacebookMarketplace, "_search_city", search_city)
    monkeypatch.setattr(MarketplaceMonitor, "evaluate_by_ai", evaluate_by_ai)
    monkeypatch.setattr(MarketplaceMonitor, "prescreen_rejects", lambda self, *a: None)
    monkeypatch.setattr(User, "notification_status", lambda self, listing: NotificationStatus.NOT_NOTIFIED)
    monkeypatch.setattr(User, "notify", notify)
    urls: List[str] = []
    real_urlopen = urllib.request.urlopen

    def urlopen(request: Any, *args: Any, **kwargs: Any) -> Any:
        urls.append(request.full_url if hasattr(request, "full_url") else str(request))
        return real_urlopen(request, *args, **kwargs)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    with pytest.raises(EndOfScriptError):
        seen["monitor"].fleet_loop()

    marketplace = seen["monitor"].active_marketplaces["facebook"]
    assert marketplace.control_plane is None
    assert judged == [lot.id] and notified == [lot.id]
    assert fleet.done[0]["task_id"] == task["id"] and fleet.done[0]["result"]["alerted"] == 1
    # Nothing but the fleet was spoken to: no listing post, no claim, no report.
    assert urls and all(url.startswith(fleet.url + "/api/fleet/worker/") for url in urls)
    assert seen["logins"] == 1


# ---------------------------------------------------------------------------
# Facebook or the proxy out of reach: parked for an operator
# ---------------------------------------------------------------------------
class ParkEndedError(BaseException):
    """Ends the parked wait; the park turns any Exception into an exit 78."""


def test_a_worker_that_cannot_reach_facebook_parks_heartbeating_dead(
    fleet: FakeFleet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shared_env: None
) -> None:
    import time as real_time

    from ai_marketplace_monitor.facebook import FacebookMarketplace

    parked_file = tmp_path / "home" / "parked.json"
    monkeypatch.setenv("RS_PARKED_FILE", str(parked_file))
    config_path = rendered_config(fleet, tmp_path / "home")
    fleet.add_task("houston")
    nap = real_time.sleep  # before monitor_for records every sleep instead
    seen = monitor_for(monkeypatch, config_path, asks_allowed=5)

    def login(self: FacebookMarketplace) -> None:
        # The real boot navigation, through a proxy that does not resolve.
        seen["logins"] += 1
        self.page = MagicMock()
        self.page.goto.side_effect = RuntimeError(
            "Page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://www.facebook.com/marketplace/"
        )
        self.goto_url(self.marketplace_url)

    def parked_wait(seconds: float) -> None:
        seen["sleeps"].append(seconds)
        nap(0.05)
        dead = [h for h in fleet.heartbeats if h["state"] == "DEAD"]
        if len(dead) >= 4:
            raise ParkEndedError()
        if len(seen["sleeps"]) > 200:
            raise AssertionError("the heartbeats stopped")

    monkeypatch.setattr(FacebookMarketplace, "login", login)
    # The repeater, quick: it is what keeps the slot's lease while parked.
    monkeypatch.setattr(FacebookMarketplace, "heartbeat_interval", 0.05)
    from ai_marketplace_monitor import monitor as monitor_mod

    monkeypatch.setattr(monitor_mod.time, "sleep", parked_wait)

    marketplace = None
    try:
        with pytest.raises(ParkEndedError):
            seen["monitor"].fleet_loop()
    finally:
        marketplace = seen["monitor"].active_marketplaces.get("facebook")
        if marketplace is not None:
            marketplace._heartbeat_stop.set()

    assert seen["logins"] == 1
    assert marketplace is not None and marketplace.page.goto.call_count == 1  # no retry
    paths = [r[1] for r in fleet.requests]
    assert "/api/fleet/worker/next-task" not in paths
    assert len(fleet.tasks) == 1  # never taken
    dead = [h for h in fleet.heartbeats if h["state"] == "DEAD"]
    assert len(dead) >= 4
    for heartbeat in dead:
        assert heartbeat["detail"]["epoch"] == 7
        assert heartbeat["detail"]["reason"] == "connect_failed"
        assert heartbeat["detail"]["operator"] is True
        assert "ERR_PROXY_CONNECTION_FAILED" in heartbeat["detail"]["error"]
    # Nothing after the park said otherwise.
    first_dead = next(i for i, h in enumerate(fleet.heartbeats) if h["state"] == "DEAD")
    assert all(h["state"] == "DEAD" for h in fleet.heartbeats[first_dead:])
    assert set(seen["sleeps"]) == {15}
    assert json.loads(parked_file.read_text())["reason"] == "connect_failed"
