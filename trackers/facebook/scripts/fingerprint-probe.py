#!/usr/bin/env python3
"""What a fleet worker's browser presents, measured with no Facebook account at all.

Runs inside the worker image. It goes the way a fleet worker goes, minus the
claim: a made-up claim device becomes `identity.json` through rs_worker's
`identity_for`, rs_worker's `start_display` runs Xvfb at `screen_geometry`'s
screen (with the window manager a cloak device gets), the monitor's
`browser_engine.launch` starts the browser and `create_page` opens the
context (proxy, device options) exactly as before a login. Then it opens one
IP-echo page and asks a second echo host through `context.request`, the path
the token exchange takes, then reads the request headers back from an echo,
and prints one JSON object. It never opens a
facebook.com page and holds no session.

    docker run --rm -e PYTHONPATH=/app -e CLOAKBROWSER_LICENSE_KEY \\
        -v "$PWD/scripts:/probe:ro" --entrypoint python aimm-recycle:<tag> \\
        /probe/fingerprint-probe.py --engine cloak --seed 48213 --gpu NVIDIA \\
        --proxy http://user:pass@proxy:8899

A cloak run takes one CloakBrowser license session for as long as it runs;
on a free key that is the only one, so no worker may run cloak meanwhile.

    python3 scripts/fingerprint-probe.py --compare a.json b.json ...

reads saved runs and prints the checks across them (stdlib only, any host).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List

ECHO_URL = "https://api.ipify.org?format=json"
# Another host for the context.request leg, so a proxy's access log tells the
# two legs apart (it sees only CONNECT host:port).
REQUEST_ECHO_URL = "https://api4.ipify.org?format=json"
# Echoes the request headers the page sent, through the same proxy.
HEADERS_URL = "https://httpbin.org/headers"
# How far a full-screen window's outer width may sit from the screen's
# available width (a Windows frame's invisible borders are about 16 px).
WINDOW_SLACK_PX = 16

# Probed by width against the generic fallbacks: `document.fonts.check` says
# true for any local name, installed or not.
FONTS = [
    "Arial", "Arial Black", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas",
    "Courier New", "Georgia", "Impact", "Segoe UI", "Tahoma", "Times New Roman",
    "Trebuchet MS", "Verdana", "Carlito", "Caladea", "Liberation Sans", "Liberation Serif",
    "Liberation Mono", "DejaVu Sans", "Noto Color Emoji", "Noto Sans CJK SC", "Helvetica",
    "Ubuntu", "Cantarell",
]

FINGERPRINT_JS = """
async (fonts) => {
  const out = {};
  out.webdriver = navigator.webdriver;
  out.user_agent = navigator.userAgent;
  out.platform = navigator.platform;
  out.languages = navigator.languages;
  out.hardware_concurrency = navigator.hardwareConcurrency;
  out.device_memory = navigator.deviceMemory ?? null;
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.screen = {width: screen.width, height: screen.height,
                avail_width: screen.availWidth, avail_height: screen.availHeight};
  out.window = {outer_width: outerWidth, outer_height: outerHeight,
                inner_width: innerWidth, inner_height: innerHeight,
                device_pixel_ratio: devicePixelRatio};
  if (navigator.userAgentData) {
    out.ua_data = {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform,
      high_entropy: await navigator.userAgentData.getHighEntropyValues(
        ["architecture", "bitness", "model", "platformVersion", "fullVersionList"]),
    };
  } else {
    out.ua_data = null;
  }
  const gl = document.createElement("canvas").getContext("webgl");
  if (gl) {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    out.webgl = {
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : null,
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
    };
    const params = [gl.MAX_TEXTURE_SIZE, gl.MAX_VIEWPORT_DIMS, gl.MAX_RENDERBUFFER_SIZE,
                    gl.ALIASED_LINE_WIDTH_RANGE, gl.MAX_VERTEX_ATTRIBS];
    out.webgl.params = params.map((p) => Array.from([].concat(gl.getParameter(p) ?? [])));
  } else {
    out.webgl = null;
  }
  const c = document.createElement("canvas");
  c.width = 280; c.height = 60;
  const x = c.getContext("2d");
  x.textBaseline = "top";
  x.font = "16px 'Arial'";
  x.fillStyle = "#f60"; x.fillRect(120, 5, 70, 30);
  x.fillStyle = "#069"; x.fillText("Recycle Servers, fingerprint \\u{1F600}", 4, 12);
  x.fillStyle = "rgba(102, 204, 0, 0.7)"; x.fillText("Recycle Servers, fingerprint", 6, 30);
  x.beginPath(); x.arc(240, 30, 18, 0, Math.PI * 2); x.stroke();
  out.canvas_data_url = c.toDataURL();
  const m = document.createElement("canvas").getContext("2d");
  const sample = "mmmmmmmmmmlli1WWW";
  const base = {};
  for (const f of ["monospace", "serif", "sans-serif"]) {
    m.font = `72px ${f}`; base[f] = m.measureText(sample).width;
  }
  out.fonts = fonts.filter((name) => ["monospace", "serif", "sans-serif"].some((f) => {
    m.font = `72px "${name}", ${f}`; return m.measureText(sample).width !== base[f];
  }));
  return out;
}
"""


def claim_answer(engine: str, seed: int | None, gpu: str | None, timezone: str,
                 locale: str, screen: List[int]) -> Dict[str, Any]:
    """A claim answer as the ERP would send it, with no account behind it."""
    device: Dict[str, Any] = {"timezone": timezone, "locale": locale, "screen": list(screen)}
    if engine == "cloak":
        device.update(browser_engine="cloak", cloak_gpu=gpu)
        if seed is not None:
            device["cloak_seed"] = seed
    else:
        device["viewport"] = [screen[0], screen[1] - 123]
    return {"account": {"no": 0, "uid": None, "cookies": []}, "device": device}


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def summarize(raw: Dict[str, Any]) -> Dict[str, Any]:
    """The browser's answers, with the large ones reduced to hashes."""
    out = dict(raw)
    data_url = out.pop("canvas_data_url", "") or ""
    out["canvas_sha256"] = sha256(data_url) if data_url else None
    webgl = out.get("webgl") or {}
    out["webgl_sha256"] = sha256(json.dumps(webgl, sort_keys=True)) if webgl else None
    out["font_count"] = len(out.get("fonts") or [])
    window = out.get("window") or {}
    out["outer_ge_inner"] = (
        window.get("outer_width", 0) >= window.get("inner_width", 1)
        and window.get("outer_height", 0) >= window.get("inner_height", 1)
    )
    screen = out.get("screen") or {}
    out["frame_width"] = window.get("outer_width", 0) - window.get("inner_width", 0)
    out["outer_to_avail_width"] = window.get("outer_width", 0) - screen.get("avail_width", 0)
    return out


def windows_consistent(fp: Dict[str, Any]) -> bool:
    """User agent, client hints and navigator.platform all say Windows."""
    ua_data = fp.get("ua_data") or {}
    return (
        "Windows NT" in (fp.get("user_agent") or "")
        and ua_data.get("platform") == "Windows"
        and fp.get("platform") == "Win32"
    )


def compare(runs: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The probe's expectations, one row each, across runs named stock/cloak_a/cloak_b/cloak_a2."""
    rows: List[Dict[str, Any]] = []

    def row(check: str, ok: bool, detail: str) -> None:
        rows.append({"check": check, "pass": bool(ok), "detail": detail})

    for name, run in runs.items():
        fp = run.get("fingerprint") or {}
        ip = run.get("ip") or {}
        if run.get("error"):
            row(f"{name}: launched", False, run["error"])
            continue
        row(f"{name}: page and context.request leave by the same IP",
            bool(ip.get("page")) and ip.get("page") == ip.get("request"),
            "same" if ip.get("page") == ip.get("request") else f"{ip.get('page')} vs {ip.get('request')}")
        row(f"{name}: outerWidth >= innerWidth", fp.get("outer_ge_inner") is True,
            json.dumps(fp.get("window")))
        if name.startswith("cloak"):
            row(f"{name}: navigator.webdriver is false", fp.get("webdriver") is False,
                str(fp.get("webdriver")))
            row(f"{name}: UA, client hints and platform say Windows", windows_consistent(fp),
                f"{fp.get('platform')} / {(fp.get('ua_data') or {}).get('platform')}")
            # A window with no frame, or one that is not the screen, is a tell.
            row(f"{name}: the window has a frame (outerWidth > innerWidth)",
                (fp.get("frame_width") or 0) > 0, f"outer - inner = {fp.get('frame_width')}")
            row(f"{name}: the window is the screen's width",
                abs(fp.get("outer_to_avail_width") or 10**6) <= WINDOW_SLACK_PX,
                f"outer - availWidth = {fp.get('outer_to_avail_width')}")
            locale = run.get("device", {}).get("locale")
            languages = fp.get("languages") or []
            accept = run.get("accept_language") or ""
            row(f"{name}: navigator.languages and Accept-Language lead with the device locale",
                bool(locale) and languages[:1] == [locale] and accept.startswith(locale),
                f"{languages} / {accept}")
    a, b, a2 = runs.get("cloak_a"), runs.get("cloak_b"), runs.get("cloak_a2")
    if a and b:
        fa, fb = a.get("fingerprint") or {}, b.get("fingerprint") or {}
        row("seed A and seed B differ (canvas)", fa.get("canvas_sha256") != fb.get("canvas_sha256"),
            f"{str(fa.get('canvas_sha256'))[:12]} vs {str(fb.get('canvas_sha256'))[:12]}")
        row("seed A and seed B differ (WebGL)", fa.get("webgl_sha256") != fb.get("webgl_sha256"),
            f"{(fa.get('webgl') or {}).get('renderer')} vs {(fb.get('webgl') or {}).get('renderer')}")
    if a and a2:
        fa, f2 = a.get("fingerprint") or {}, a2.get("fingerprint") or {}
        for key in ("canvas_sha256", "webgl_sha256", "user_agent", "hardware_concurrency",
                    "device_memory", "font_count"):
            row(f"seed A twice, fresh container: same {key}", fa.get(key) == f2.get(key),
                f"{str(fa.get(key))[:40]} / {str(f2.get(key))[:40]}")
    return rows


def probe(args: argparse.Namespace) -> Dict[str, Any]:
    from playwright.sync_api import sync_playwright
    from rs_worker.entry import (
        CLOAK_WINDOW_MANAGER,
        WINDOW_MANAGER_ENV,
        identity_for,
        is_cloak,
        screen_geometry,
        split_proxy,
        start_display,
        stop_all,
    )

    from ai_marketplace_monitor import browser_engine
    from ai_marketplace_monitor.facebook import FacebookMarketplace, FacebookMarketplaceConfig
    from ai_marketplace_monitor.utils import MonitorConfig

    answer = claim_answer(args.engine, args.seed, args.gpu, args.timezone, args.locale,
                          args.screen)
    home = Path(tempfile.mkdtemp(prefix="probe-"))
    identity = identity_for(answer)
    (home / "identity.json").write_text(json.dumps(identity))
    geometry = screen_geometry(answer["device"])
    result: Dict[str, Any] = {"engine": args.engine, "seed": args.seed, "gpu": args.gpu,
                              "geometry": geometry, "device": identity["device"]}
    # The display as rs_worker starts it for this device: its screen, and
    # the window manager a cloak window gets. The monitor reads the same
    # SCREEN_GEOMETRY when the device names no screen.
    os.environ.setdefault("DISPLAY", ":99")
    os.environ["SCREEN_GEOMETRY"] = geometry
    if is_cloak(answer["device"]):
        os.environ[WINDOW_MANAGER_ENV] = CLOAK_WINDOW_MANAGER
    display = start_display(dict(os.environ))
    time.sleep(1)
    pw = sync_playwright().start()
    browser = None
    try:
        browser = browser_engine.launch(pw, identity, False, None)
        result["browser_version"] = browser.version
        monitor = MonitorConfig(name="monitor", storage_state_path=str(home / "session.json"),
                                **(split_proxy(args.proxy) if args.proxy else {}))
        config = FacebookMarketplaceConfig(name="facebook")
        config.monitor_config = monitor
        market = FacebookMarketplace("facebook", browser, None, None)
        market.configure(config)
        page = market.create_page()
        page.goto(args.echo_url, wait_until="domcontentloaded", timeout=60_000)
        page_ip = json.loads(page.locator("body").inner_text()).get("ip")
        response = page.context.request.get(args.request_echo_url, timeout=60_000)
        request_ip = response.json().get("ip")
        result["ip"] = {"page": page_ip, "request": request_ip}
        result["fingerprint"] = summarize(page.evaluate(FINGERPRINT_JS, FONTS))
        page.goto(args.headers_url, wait_until="domcontentloaded", timeout=60_000)
        headers = json.loads(page.locator("body").inner_text()).get("headers") or {}
        result["accept_language"] = headers.get("Accept-Language")
        page.context.close()
    except Exception as e:
        reason = browser_engine.park_reason(e, args.engine)
        result["error"] = f"{type(e).__name__}: {str(e)[:400]}"
        result["park_reason"] = reason
        denial = browser_engine.license_denial(e, args.engine)
        if denial is not None:
            result["license"] = denial
    finally:
        # Closed, not killed: a killed browser holds its license seat for minutes.
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        pw.stop()
        stop_all(display, 3)
        shutil.rmtree(home, ignore_errors=True)
    return result


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--engine", choices=("stock", "cloak"), default="stock")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--gpu", default="NVIDIA")
    parser.add_argument("--timezone", default="America/Denver")
    parser.add_argument("--locale", default="en-US")
    parser.add_argument("--screen", type=int, nargs=2, default=[1920, 1080], metavar=("W", "H"))
    parser.add_argument("--proxy", help="http://user:pass@host:port, per context as the fleet sets it")
    parser.add_argument("--echo-url", default=ECHO_URL)
    parser.add_argument("--request-echo-url", default=REQUEST_ECHO_URL)
    parser.add_argument("--headers-url", default=HEADERS_URL)
    parser.add_argument("--compare", nargs="+", type=Path,
                        help="saved runs, named by file stem (stock, cloak_a, cloak_b, cloak_a2)")
    args = parser.parse_args(argv)
    if args.compare:
        runs = {p.stem: json.loads(p.read_text()) for p in args.compare}
        rows = compare(runs)
        print(json.dumps(rows, indent=2))
        return 0 if all(r["pass"] for r in rows) else 1
    result = probe(args)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 1 if result.get("error") else 0


if __name__ == "__main__":
    sys.exit(main())
