"""Verdict logic of scripts/fleet-verify.py, run without the VM.

    .venv-coordinator/bin/python -m pytest scripts/tests/test_fleet_verify.py
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "fleet-verify.py"
spec = importlib.util.spec_from_file_location("fleet_verify", SCRIPT)
fv = importlib.util.module_from_spec(spec)
sys.modules["fleet_verify"] = fv
spec.loader.exec_module(fv)  # type: ignore[union-attr]

UTC = dt.timezone.utc
RUNNING = {"container": "rs-monitor-x", "running": True, "status": "running"}
STOPPED = {"container": "rs-monitor-x", "running": False, "status": "exited"}
LIVE = {"worker_id": "x-1", "liveness": "live", "state": "HEALTHY", "session_days_left": 300.0}


def test_productive_worker_is_ok():
    r = fv.assess("x-1", LIVE, {"search_start": 70, "ai_eval": 900, "listing_alert": 3}, RUNNING, 0)
    assert r["verdict"] == "OK" and r["reasons"] == []


def test_empty_searches_flag_a_checkpointed_account():
    r = fv.assess("x-1", LIVE, {"search_start": 40, "search_empty": 7, "ai_eval": 10}, RUNNING, 0)
    assert r["verdict"] == "ATTENTION"
    assert any("empty" in reason for reason in r["reasons"])


def test_healthy_but_nothing_evaluated_is_a_dud():
    r = fv.assess("x-1", LIVE, {"search_start": 40, "results_loaded": 40}, RUNNING, 0)
    assert r["verdict"] == "ATTENTION"
    assert "searched but evaluated nothing" in r["reasons"]


def test_missed_sweep():
    r = fv.assess("x-1", LIVE, {}, RUNNING, 0)
    assert r["reasons"] == ["no search in window"]


def test_stopped_container_is_attention_unless_muted():
    stale = dict(LIVE, liveness="stale")
    r = fv.assess("x-1", stale, {}, STOPPED, 0)
    assert r["verdict"] == "ATTENTION"
    assert r["reasons"] == ["container exited", "heartbeat stale"]
    assert fv.assess("x-1", stale, {}, STOPPED, 0, muted=True)["verdict"] == "MUTED"


def test_registered_but_never_deployed_is_not_paged():
    r = fv.assess("west-1", {"worker_id": "west-1", "liveness": "unknown"}, {}, None, 0)
    assert r["verdict"] == "NOT DEPLOYED"


def test_open_challenge_and_expiry():
    soon = dict(LIVE, session_days_left=3.2)
    r = fv.assess("x-1", soon, {"search_start": 5, "ai_eval": 5}, RUNNING, 2)
    assert "session expires in 3d" in r["reasons"]
    assert "2 open challenge(s)" in r["reasons"]


def test_fleet_joins_coordinator_and_docker_views():
    rows = [LIVE, {"worker_id": "west-1", "liveness": "unknown"}]
    containers = {"x-1": RUNNING, "orphan-1": STOPPED}
    results = fv.assess_fleet(rows, {"x-1": {"search_start": 1, "ai_eval": 1}}, containers, [])
    assert [r["worker_id"] for r in results] == ["orphan-1", "west-1", "x-1"]
    assert [r["verdict"] for r in results] == ["ATTENTION", "NOT DEPLOYED", "OK"]


def test_sweep_window_rolls_back_a_day_before_the_sweep():
    before = dt.datetime(2026, 9, 8, 9, 0, tzinfo=UTC)
    after = dt.datetime(2026, 9, 8, 21, 0, tzinfo=UTC)
    assert fv.sweep_window_start(before) == dt.datetime(2026, 9, 7, 9, 50, tzinfo=UTC)
    assert fv.sweep_window_start(after) == dt.datetime(2026, 9, 8, 9, 50, tzinfo=UTC)


def test_render_mentions_reasons_and_headline():
    results = fv.assess_fleet(
        [LIVE], {"x-1": {"search_start": 3, "search_empty": 3}}, {"x-1": RUNNING}, []
    )
    text = fv.render(results, dt.datetime(2026, 9, 8, 9, 50, tzinfo=UTC), dt.datetime(2026, 9, 8, 21, 0, tzinfo=UTC))
    assert text.startswith("Fleet verify — 0/1 OK, 1 need attention")
    assert "x-1: 3 empty search(es)" in text
