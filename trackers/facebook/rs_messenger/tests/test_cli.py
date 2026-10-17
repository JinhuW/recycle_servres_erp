"""CLI wiring: defaults, pacing math, and the offline status command."""

import json

import pytest

from rs_messenger.cli import build_parser, cmd_status
from rs_messenger.sender import min_send_interval, seconds_until_next_send


def test_parser_defaults_are_conservative():
    args = build_parser().parse_args(["poll"])
    assert args.depth == 10
    assert args.dry_run is False
    assert args.lock_timeout == 0

    run = build_parser().parse_args(["run"])
    assert run.interval == 300
    assert run.dry_run is False  # run never dry-runs; poll --dry-run is the probe


def test_pacing_floor_and_math(monkeypatch):
    monkeypatch.delenv("RS_MESSENGER_MIN_SEND_INTERVAL", raising=False)
    assert min_send_interval() == 60.0

    # The env var tunes it, but never below the 10 s floor — an operator typo
    # of "0" must not turn the bridge into a rapid-fire bot.
    monkeypatch.setenv("RS_MESSENGER_MIN_SEND_INTERVAL", "120")
    assert min_send_interval() == 120.0
    monkeypatch.setenv("RS_MESSENGER_MIN_SEND_INTERVAL", "0")
    assert min_send_interval() == 10.0
    monkeypatch.setenv("RS_MESSENGER_MIN_SEND_INTERVAL", "not a number")
    assert min_send_interval() == 60.0

    monkeypatch.delenv("RS_MESSENGER_MIN_SEND_INTERVAL", raising=False)
    assert seconds_until_next_send(last_send_at=100.0, now=130.0) == 30.0
    assert seconds_until_next_send(last_send_at=100.0, now=500.0) == 0.0


def test_status_runs_offline(tmp_path, capsys, monkeypatch):
    """`status` must never need a browser or a reachable coordinator."""
    for name in ("RS_COORDINATOR_URL", "RS_COORDINATOR_TOKEN", "RS_WORKER_ID"):
        monkeypatch.delenv(name, raising=False)

    state = tmp_path / "fb_state.json"
    state.write_text(json.dumps({"cookies": []}))
    args = build_parser().parse_args(
        ["--storage-state", str(state), "--lock-file", str(tmp_path / "lock"), "status"]
    )
    assert cmd_status(args) == 0
    out = capsys.readouterr().out
    assert "NOT configured" in out
    assert "fb_state.json" in out
    assert "lock:        free" in out


def test_status_reports_a_missing_session(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("RS_COORDINATOR_URL", "http://coordinator:8500")
    monkeypatch.setenv("RS_COORDINATOR_TOKEN", "tok")
    monkeypatch.setenv("RS_WORKER_ID", "homelab-1")

    args = build_parser().parse_args(
        [
            "--storage-state",
            str(tmp_path / "absent.json"),
            "--lock-file",
            str(tmp_path / "lock"),
            "status",
        ]
    )
    assert cmd_status(args) == 0
    out = capsys.readouterr().out
    assert "coordinator: http://coordinator:8500 (worker homelab-1)" in out
    assert "MISSING" in out


def test_unknown_command_is_rejected():
    with pytest.raises(SystemExit):
        build_parser().parse_args(["frobnicate"])
