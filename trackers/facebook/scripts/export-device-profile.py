#!/usr/bin/env python3
"""Print the device a homelab worker's browser presents, as an ERP fleet slot's `device`.

Runs on the homelab VM, read-only: it reads the worker's bind-mounted session
folder (identity.json and the session's .meta.json sidecar), `docker inspect`
and the Playwright build inside the image. It never attaches to, navigates or
restarts a browser, and writes nothing.

What Facebook saw is decided by the monitor when it opens a browser context
(`device_context_options` in the vendored monitor), not by the coordinator's
`device_profiles`: a worker presents its cached `identity.json`, or, with none
cached, Playwright's defaults. This script replays that decision:

  * identity.json cached: its viewport, screen, scale, locale and timezone;
    its user agent, else the sidecar's, with the Chrome version set to the
    running browser's; with neither, the browser's own user agent.
  * no identity.json: the sidecar's user agent as it is, else the browser's
    own; Playwright's 1280x720 viewport and screen at scale 1, and the
    container's language and clock.

Fields the browser decided for itself are listed in `native`; rs_worker leaves
them unset in the fleet browser, so it presents its own value the same way
(the UA string and its client hints come from the same build only then).

    python3 scripts/export-device-profile.py ca1            # the slot's device JSON
    python3 scripts/export-device-profile.py ca-1 --sources # plus where each value came from
    python3 scripts/export-device-profile.py --all          # every worker, JSON lines
    python3 scripts/export-device-profile.py --all --table  # every worker, a table

Before this file reaches the VM, pipe it in:
    ssh jinhu@10.10.10.73 'cd ~/recycle_servers/facebook_tracker && python3 - --all --table' \\
        < scripts/export-device-profile.py

Prints no cookie value, token or secret: only cookie names are looked at.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Mirrors the monitor's identity.LEGACY_VIEWPORT: Playwright's default, which
# it also reports as the screen when none is given.
LEGACY_VIEWPORT = (1280, 720)
NATIVE_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/{major}.0.0.0 Safari/537.36"
)
_CHROME_VERSION = re.compile(r"Chrome/([0-9][0-9.]*)")
BROWSERS_JSON = "/usr/local/lib/python3.12/site-packages/playwright/driver/package/browsers.json"


def _root() -> Path:
    here = Path(__file__)
    return here.resolve().parent.parent if here.is_file() else Path.cwd()


# ---------------------------------------------------------------- the decision


def _size(value: Any) -> Optional[Tuple[int, int]]:
    if isinstance(value, dict) and value.get("width") and value.get("height"):
        return int(value["width"]), int(value["height"])
    return None


def native_user_agent(browser_version: Optional[str]) -> Optional[str]:
    """What Chrome for Testing on Linux reports with no override (reduced UA)."""
    major = (browser_version or "").split(".", 1)[0]
    return NATIVE_UA.format(major=major) if major.isdigit() else None


def with_browser_version(user_agent: str, browser_version: Optional[str]) -> str:
    """Mirrors the monitor's identity.with_browser_version."""
    major = (browser_version or "").split(".", 1)[0]
    if not major.isdigit():
        return user_agent
    return _CHROME_VERSION.sub(f"Chrome/{major}.0.0.0", user_agent, count=1)


def native_locale(lang: Optional[str]) -> str:
    """Chromium's default language from the container's LANG."""
    base = (lang or "").split(".", 1)[0]
    if not base or base in ("C", "POSIX"):
        return "en-US"
    return base.replace("_", "-")


def presented_device(
    identity: Optional[Dict[str, Any]],
    sidecar: Optional[Dict[str, Any]],
    browser_version: Optional[str],
    container_env: Dict[str, str],
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """(the slot's `device`, where each value came from)."""
    device = identity.get("device") if isinstance(identity, dict) else None
    device = device if isinstance(device, dict) else None
    sidecar_ua = (sidecar or {}).get("user_agent") or None
    native: List[str] = []
    source: Dict[str, str] = {}

    if device is not None:
        viewport = _size(device.get("viewport"))
        screen = _size(device.get("screen")) if viewport else None
        scale = float(device.get("device_scale_factor") or 1.0)
        locale = device.get("locale") or None
        timezone = device.get("timezone_id") or None
        ua = device.get("user_agent") or sidecar_ua
        if ua:
            source["user_agent"] = "identity.json" if device.get("user_agent") else "sidecar"
            if browser_version:
                ua = with_browser_version(str(ua), browser_version)
                source["user_agent"] += " + browser version"
        source["geometry"] = "identity.json"
    else:
        viewport, screen, scale, locale, timezone = None, None, 1.0, None, None
        ua = sidecar_ua
        if ua:
            source["user_agent"] = "sidecar"
        source["geometry"] = "playwright default"

    if not ua:
        ua = native_user_agent(browser_version)
        native.append("user_agent")
        source["user_agent"] = f"browser's own (Chrome {browser_version})" if ua else "unknown"
    viewport = viewport or LEGACY_VIEWPORT
    screen = screen or viewport
    if not locale:
        locale = native_locale(container_env.get("LANG"))
        native.append("locale")
    if not timezone:
        timezone = container_env.get("TZ") or "UTC"
        native.append("timezone")

    out: Dict[str, Any] = {
        "user_agent": ua,
        "viewport": list(viewport),
        "screen": list(screen),
        "device_scale_factor": scale,
        "timezone": timezone,
        "locale": locale,
    }
    if native:
        out["native"] = native
    return out, source


def cookie_names(state: Optional[Dict[str, Any]]) -> List[str]:
    return [
        str(c.get("name"))
        for c in (state or {}).get("cookies") or []
        if isinstance(c, dict) and c.get("name")
    ]


def assess(
    identity: Optional[Dict[str, Any]],
    sidecar: Optional[Dict[str, Any]],
    session_state: Optional[Dict[str, Any]],
    device: Dict[str, Any],
    browser_version: Optional[str],
) -> Dict[str, Any]:
    """Facts the handover needs beside the device, and what would not carry over."""
    names = cookie_names(session_state)
    device_cookie_names = [
        str(c.get("name"))
        for c in (identity or {}).get("device_cookies") or []
        if isinstance(c, dict)
    ]
    cached = ((identity or {}).get("device") or {}).get("device_id")
    saved_under = (sidecar or {}).get("device_id")
    flags: List[str] = []
    if "c_user" not in names:
        flags.append("no logged-in session to hand over")
    if saved_under and saved_under != cached:
        flags.append("session saved under another device than the cached one")
    major = (browser_version or "").split(".", 1)[0]
    ua_major = _CHROME_VERSION.search(device.get("user_agent") or "")
    if (
        "user_agent" not in device.get("native", [])
        and ua_major
        and major.isdigit()
        and ua_major.group(1).split(".", 1)[0] != major
    ):
        # The fleet always caches an identity, and the monitor then sets a
        # pinned user agent's version to the browser's.
        flags.append(f"fleet presents Chrome/{major} (browser-version rewrite)")
    return {
        "session": "c_user" in names,
        "datr": "datr" in names or "datr" in device_cookie_names,
        "fb_uid": ((identity or {}).get("device") or {}).get("fb_uid"),
        "flags": flags,
    }


# ---------------------------------------------------------------- the VM


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _docker(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def containers() -> Dict[str, Dict[str, Any]]:
    """Session folder name -> {container, running, worker_id, image, env subset, data}."""
    names = _docker("ps", "-a", "--filter", "name=rs-monitor", "--format", "{{.Names}}").stdout.split()
    if not names:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for item in json.loads(_docker("inspect", *names).stdout or "[]"):
        env = dict(kv.partition("=")[::2] for kv in item["Config"].get("Env", []))
        data = next((m["Source"] for m in item.get("Mounts", []) if m.get("Destination") == "/data"), None)
        if not data:
            continue
        out[Path(data).name] = {
            "container": item["Name"].lstrip("/"),
            "running": bool(item["State"].get("Running")),
            "image": item.get("Image"),
            "worker_id": env.get("RS_WORKER_ID"),
            "version": env.get("RS_VERSION"),
            # Only what decides the browser's defaults; the rest holds tokens.
            "env": {k: env[k] for k in ("LANG", "TZ") if k in env},
            "data": data,
        }
    return out


def browser_version(container: str, running: bool) -> Optional[str]:
    if running:
        raw = _docker("exec", container, "cat", BROWSERS_JSON).stdout
    else:
        tar = subprocess.run(["docker", "cp", f"{container}:{BROWSERS_JSON}", "-"], capture_output=True)
        try:
            with tarfile.open(fileobj=io.BytesIO(tar.stdout)) as archive:
                member = archive.extractfile(archive.getmembers()[0])
                raw = member.read().decode() if member else ""
        except (tarfile.TarError, IndexError):
            raw = ""
    try:
        browsers = json.loads(raw)["browsers"]
    except (ValueError, KeyError):
        return None
    return next((b.get("browserVersion") for b in browsers if b.get("name") == "chromium"), None)


def worker_id_from_secrets(root: Path, folder: str) -> Optional[str]:
    """RS_WORKER_ID only; the file's other lines are tokens and stay unread."""
    try:
        text = (root / "configs" / f"secrets.{folder}.env").read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"^RS_WORKER_ID=(\S+)", text, re.M)
    return match.group(1) if match else None


def folder_for(name: str, folders: List[str], ids: Dict[str, str]) -> Optional[str]:
    """ca1, ca-1, homelab-ca1, rs-monitor-ca1 -> the session folder name."""
    for candidate in (name, f"homelab-{name}", name.replace("rs-monitor", "homelab", 1)):
        if candidate in folders:
            return candidate
    return next((f for f, wid in ids.items() if wid == name), None)


def export(root: Path, folder: str, info: Optional[Dict[str, Any]], versions: Dict[str, str]) -> Dict[str, Any]:
    data = Path(info["data"]) if info else root / "configs" / "sessions" / folder
    identity = _read_json(data / "identity.json")
    sidecar = _read_json(data / "fb_state.json.meta.json")
    state = _read_json(data / "fb_state.json")
    version = None
    if info:
        version = versions.get(info["image"])
        if version is None:
            version = browser_version(info["container"], info["running"])
            if version:
                versions[info["image"]] = version
    device, source = presented_device(identity, sidecar, version, (info or {}).get("env", {"LANG": "C.UTF-8"}))
    facts = assess(identity, sidecar, state, device, version)
    if not info:
        facts["flags"].append("no container: browser version unknown")
    return {
        "worker": folder,
        "worker_id": (info or {}).get("worker_id") or worker_id_from_secrets(root, folder),
        "container": (info or {}).get("container"),
        "running": bool(info and info["running"]),
        "image_version": (info or {}).get("version"),
        "browser_version": version,
        "device": device,
        "source": source,
        **facts,
    }


def table(rows: List[Dict[str, Any]]) -> str:
    head = ("worker", "id", "run", "UA (60)", "viewport", "screen", "dpr", "timezone", "locale",
            "ua source", "geometry", "sess", "datr", "flags")
    lines = ["\t".join(head)]
    for r in rows:
        d = r["device"]
        lines.append("\t".join(str(x) for x in (
            r["worker"], r["worker_id"], "y" if r["running"] else "n", (d["user_agent"] or "")[:60],
            "x".join(map(str, d["viewport"])), "x".join(map(str, d["screen"])), d["device_scale_factor"],
            d["timezone"], d["locale"], r["source"]["user_agent"], r["source"]["geometry"],
            "y" if r["session"] else "n", "y" if r["datr"] else "n", "; ".join(r["flags"]) or "-",
        )))
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("workers", nargs="*", help="ca1, ca-1, homelab-ca1 or rs-monitor-ca1")
    parser.add_argument("--all", action="store_true", help="every worker with a session folder")
    parser.add_argument("--sources", action="store_true", help="wrap each device with its sources and flags")
    parser.add_argument("--table", action="store_true", help="a tab-separated table (implies --sources)")
    parser.add_argument("--root", type=Path, default=None, help="the tracker tree (default: this script's)")
    args = parser.parse_args(argv)
    root = args.root or _root()
    sessions = root / "configs" / "sessions"
    folders = sorted(p.name for p in sessions.iterdir() if p.is_dir() and p.name.startswith("homelab"))
    info = containers()
    ids = {f: (info.get(f) or {}).get("worker_id") or worker_id_from_secrets(root, f) or "" for f in folders}
    if args.all:
        wanted = folders
    else:
        if not args.workers:
            parser.error("name a worker, or pass --all")
        wanted = []
        for name in args.workers:
            folder = folder_for(name, folders, ids)
            if folder is None:
                parser.error(f"no session folder for {name!r} under {sessions}")
            wanted.append(folder)
    versions: Dict[str, str] = {}
    rows = [export(root, f, info.get(f), versions) for f in wanted]
    if args.table:
        print(table(rows))
    elif args.sources or len(rows) > 1:
        for row in rows:
            print(json.dumps(row if args.sources else {"worker": row["worker"], "device": row["device"]}))
    else:
        print(json.dumps(rows[0]["device"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
