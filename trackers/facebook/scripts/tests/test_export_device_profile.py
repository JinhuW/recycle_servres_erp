"""What scripts/export-device-profile.py says a homelab browser presents, run without the VM.

    .venv-coordinator/bin/python -m pytest scripts/tests/test_export_device_profile.py
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "export-device-profile.py"
spec = importlib.util.spec_from_file_location("export_device_profile", SCRIPT)
edp = importlib.util.module_from_spec(spec)
sys.modules["export_device_profile"] = edp
spec.loader.exec_module(edp)  # type: ignore[union-attr]

CHROME = "156.0.8078.4"
NATIVE = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/156.0.0.0 Safari/537.36"
)
MAC_151 = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/151.0.0.0 Safari/537.36"
)
ENV = {"LANG": "C.UTF-8"}
GENERATED = {
    "device": {
        "device_id": "d-1", "fb_uid": "100000000000001", "user_agent": None,
        "viewport": {"width": 1536, "height": 731}, "screen": {"width": 1536, "height": 864},
        "device_scale_factor": 1.25, "locale": "en-US", "timezone_id": "America/Los_Angeles",
    },
    "device_cookies": [{"name": "datr", "value": "x", "domain": ".facebook.com"}],
}
LOGGED_IN = {"cookies": [{"name": "c_user", "value": "1"}, {"name": "datr", "value": "x"}]}


def test_a_generated_profile_without_a_user_agent_presents_the_browsers_own():
    device, source = edp.presented_device(GENERATED, {"device_id": "d-1"}, CHROME, ENV)
    assert device == {
        "user_agent": NATIVE,
        "viewport": [1536, 731],
        "screen": [1536, 864],
        "device_scale_factor": 1.25,
        "timezone": "America/Los_Angeles",
        "locale": "en-US",
        "native": ["user_agent"],
    }
    assert source["geometry"] == "identity.json"


def test_no_identity_is_playwrights_defaults_and_the_sidecars_user_agent_as_is():
    device, source = edp.presented_device(None, {"user_agent": MAC_151}, CHROME, ENV)
    assert device == {
        "user_agent": MAC_151,  # no identity, so the monitor does not rewrite its version
        "viewport": [1280, 720],
        "screen": [1280, 720],
        "device_scale_factor": 1.0,
        "timezone": "UTC",
        "locale": "en-US",
        "native": ["locale", "timezone"],
    }
    assert source == {"user_agent": "sidecar", "geometry": "playwright default"}


def test_a_pinned_user_agent_under_an_identity_takes_the_browsers_version():
    identity = {"device": {**GENERATED["device"], "user_agent": MAC_151}}
    device, source = edp.presented_device(identity, None, CHROME, ENV)
    assert "Chrome/156.0.0.0" in device["user_agent"] and "Macintosh" in device["user_agent"]
    assert "native" not in device
    assert source["user_agent"] == "identity.json + browser version"


def test_the_containers_clock_and_language_are_the_native_ones():
    device, _ = edp.presented_device(None, None, CHROME, {"LANG": "de_DE.UTF-8", "TZ": "Europe/Berlin"})
    assert (device["locale"], device["timezone"]) == ("de-DE", "Europe/Berlin")
    assert device["user_agent"] == NATIVE


def test_assess_names_datr_and_a_session_without_reading_cookie_values():
    device, _ = edp.presented_device(GENERATED, {"device_id": "d-1"}, CHROME, ENV)
    facts = edp.assess(GENERATED, {"device_id": "d-1"}, LOGGED_IN, device, CHROME)
    assert facts == {"session": True, "datr": True, "fb_uid": "100000000000001", "flags": []}


def test_assess_flags_what_would_not_carry_over():
    device, _ = edp.presented_device(None, {"user_agent": MAC_151, "device_id": "old"}, CHROME, ENV)
    facts = edp.assess(None, {"user_agent": MAC_151, "device_id": "old"}, {"cookies": []}, device, CHROME)
    assert facts["session"] is False and facts["datr"] is False
    assert "no logged-in session to hand over" in facts["flags"]
    assert "session saved under another device than the cached one" in facts["flags"]
    assert "fleet presents Chrome/156 (browser-version rewrite)" in facts["flags"]


def test_worker_names_resolve_to_session_folders():
    folders = ["homelab", "homelab-ca1", "homelab-hl1b"]
    ids = {"homelab": "homelab-1", "homelab-ca1": "ca-1", "homelab-hl1b": "homelab-1b"}
    for name in ("ca1", "homelab-ca1", "rs-monitor-ca1", "ca-1"):
        assert edp.folder_for(name, folders, ids) == "homelab-ca1"
    assert edp.folder_for("rs-monitor", folders, ids) == "homelab"
    assert edp.folder_for("homelab-1b", folders, ids) == "homelab-hl1b"
    assert edp.folder_for("nope", folders, ids) is None
