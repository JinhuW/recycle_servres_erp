"""What scripts/fingerprint-probe.py builds and how it judges saved runs, without a browser.

    .venv-aimm/bin/python -m pytest scripts/tests/test_fingerprint_probe.py
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "fingerprint-probe.py"
spec = importlib.util.spec_from_file_location("fingerprint_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
sys.modules["fingerprint_probe"] = probe
spec.loader.exec_module(probe)  # type: ignore[union-attr]

WINDOWS_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/155.0.0.0 Safari/537.36"
)


def run(canvas: str = "a", renderer: str = "RTX", **fp: Any) -> Dict[str, Any]:
    raw = {
        "webdriver": False,
        "user_agent": WINDOWS_UA,
        "platform": "Win32",
        "ua_data": {"platform": "Windows"},
        "hardware_concurrency": 24,
        "device_memory": 16,
        "languages": ["en-US", "en"],
        "screen": {"width": 1920, "height": 1080, "avail_width": 1920, "avail_height": 1032},
        "window": {"outer_width": 1919, "outer_height": 1032, "inner_width": 1911,
                   "inner_height": 954},
        "webgl": {"vendor": "Google Inc. (NVIDIA)", "renderer": renderer},
        "canvas_data_url": f"data:image/png;base64,{canvas}",
        "fonts": ["Arial"],
    }
    raw.update(fp)
    return {"ip": {"page": "203.0.113.7", "request": "203.0.113.7"},
            "device": {"locale": "en-US"}, "accept_language": "en-US,en;q=0.9",
            "fingerprint": probe.summarize(raw)}


def test_the_claim_answer_is_a_cloak_device_with_its_seed() -> None:
    answer = probe.claim_answer("cloak", 48213, "NVIDIA", "America/Denver", "en-US", [1920, 1080])
    assert answer["device"]["browser_engine"] == "cloak"
    assert answer["device"]["cloak_seed"] == 48213
    assert answer["account"]["cookies"] == []


def test_a_cloak_answer_without_a_seed_has_none_to_invent() -> None:
    answer = probe.claim_answer("cloak", None, "NVIDIA", "UTC", "en-US", [1920, 1080])
    assert "cloak_seed" not in answer["device"]


def test_the_stock_answer_names_no_engine() -> None:
    answer = probe.claim_answer("stock", None, None, "UTC", "en-US", [1920, 1080])
    assert "browser_engine" not in answer["device"]
    assert answer["device"]["viewport"] == [1920, 957]


def test_the_rs_worker_identity_carries_what_the_probe_asked_for() -> None:
    entry = pytest.importorskip("rs_worker.entry")
    answer = probe.claim_answer("cloak", 48213, "Intel", "America/Denver", "en-US", [1536, 864])
    device = entry.identity_for(answer)["device"]
    assert (device["browser_engine"], device["cloak_seed"], device["cloak_gpu"]) == (
        "cloak", 48213, "Intel")
    assert entry.screen_geometry(answer["device"]) == "1536x864x24"


def test_summarize_hashes_the_canvas_and_checks_the_window() -> None:
    fp = run()["fingerprint"]
    assert "canvas_data_url" not in fp
    assert len(fp["canvas_sha256"]) == 64
    assert fp["outer_ge_inner"] is True
    assert probe.summarize({"window": {"outer_width": 800, "inner_width": 1280,
                                       "outer_height": 1, "inner_height": 1}})[
        "outer_ge_inner"] is False


def test_windows_consistency_needs_all_three() -> None:
    assert probe.windows_consistent(run()["fingerprint"])
    linux = run(platform="Linux x86_64")["fingerprint"]
    assert not probe.windows_consistent(linux)


def test_every_expectation_passes_for_a_good_set() -> None:
    runs = {"stock": run(webdriver=True, platform="Linux x86_64"),
            "cloak_a": run("a", "RTX"), "cloak_b": run("b", "GTX"), "cloak_a2": run("a", "RTX")}
    rows = probe.compare(runs)
    assert rows and all(r["pass"] for r in rows), [r for r in rows if not r["pass"]]


@pytest.mark.parametrize(
    ("name", "change", "failing"),
    [
        ("cloak_a2", {"canvas": "other"}, "seed A twice, fresh container: same canvas_sha256"),
        ("cloak_b", {"canvas": "a", "renderer": "RTX"}, "seed A and seed B differ (canvas)"),
        ("cloak_a", {"webdriver": True}, "cloak_a: navigator.webdriver is false"),
    ],
)
def test_a_broken_expectation_fails_its_row(name: str, change: Dict[str, Any], failing: str) -> None:
    runs = {"cloak_a": run("a", "RTX"), "cloak_b": run("b", "GTX"), "cloak_a2": run("a", "RTX")}
    runs[name] = run(**{"canvas": "a" if name != "cloak_b" else "b",
                        "renderer": "RTX" if name != "cloak_b" else "GTX", **change})
    rows = {r["check"]: r["pass"] for r in probe.compare(runs)}
    assert rows[failing] is False


@pytest.mark.parametrize(
    ("window", "failing"),
    [
        # No window manager: no frame.
        ({"outer_width": 1919, "inner_width": 1919}, "cloak_a: the window has a frame (outerWidth > innerWidth)"),
        # Maximize ignored without one: a window narrower than the screen.
        ({"outer_width": 945, "inner_width": 937}, "cloak_a: the window is the screen's width"),
    ],
)
def test_a_window_that_is_not_a_framed_screen_fails(window: Dict[str, int], failing: str) -> None:
    good = run()["fingerprint"]
    raw = {**{k: v for k, v in good.items()}, "window": {**good["window"], **window}}
    body = {**run(), "fingerprint": probe.summarize(raw)}
    rows = {r["check"]: r["pass"] for r in probe.compare({"cloak_a": body})}
    assert rows[failing] is False


def test_a_locale_the_headers_do_not_carry_fails() -> None:
    body = {**run(), "accept_language": "en,en-GB;q=0.9"}
    rows = {r["check"]: r["pass"] for r in probe.compare({"cloak_a": body})}
    assert rows["cloak_a: navigator.languages and Accept-Language lead with the device locale"] is False


def test_the_frame_and_screen_offsets_are_recorded() -> None:
    fp = run()["fingerprint"]
    assert fp["frame_width"] == 8 and fp["outer_to_avail_width"] == -1


def test_a_request_that_leaves_another_way_fails() -> None:
    bad = copy.deepcopy(run())
    bad["ip"]["request"] = "198.51.100.9"
    rows = {r["check"]: r["pass"] for r in probe.compare({"cloak_a": bad})}
    assert rows["cloak_a: page and context.request leave by the same IP"] is False


def test_compare_from_saved_files(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    for name, body in {"cloak_a": run("a"), "cloak_a2": run("a")}.items():
        (tmp_path / f"{name}.json").write_text(json.dumps(body))
    code = probe.main(["--compare", str(tmp_path / "cloak_a.json"), str(tmp_path / "cloak_a2.json")])
    assert code == 0
    assert json.loads(capsys.readouterr().out)
