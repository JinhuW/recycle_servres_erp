# CloakBrowser fingerprint probe: what a worker presents, with no account

**2026-11-02, facebook-tracker 0.16.0 (unreleased), RS-505.**

- **Image:** the worker image built locally from this branch
  (`aimm-recycle:cloak-dev`, linux/arm64), with the monitor at `dc7137c`.
- **Browsers:** CloakBrowser 155.0.8059.39.2 on a free key, and stock Chromium
  156.0.8078.4 (Playwright 1.64.1).
- **Repeated on a second build.** Every run was repeated on an earlier build of
  the same image (monitor `6d464cd`/`ab1f7c8`) with identical hashes, so a seed
  holds across rebuilds as well as containers.

`scripts/fingerprint-probe.py` runs inside the worker image and goes the way a
fleet worker goes, minus the claim:

1. A made-up claim device becomes `identity.json` through rs_worker's `identity_for`.
2. Xvfb gets `screen_geometry`'s screen.
3. The monitor's `browser_engine.launch` starts the browser.
4. `FacebookMarketplace.create_page` opens the context with the proxy split as
   rs_worker splits it.

It opens one IP-echo page (`api.ipify.org`) and asks a second echo host
(`api4.ipify.org`) through `context.request`, the path the token exchange
takes. It opens no facebook.com page and holds no session.

## Setup

- **Proxy.** A throwaway credentialed proxy (`proxy.py` 2.4.10 with
  `--basic-auth`) ran in a sidecar container on a private Docker network. The
  probe passed it per context, as `http://user:pass@cloakprobe-proxy:8899`,
  exactly as the fleet sets a slot's proxy.
- **One browser at a time.** The free key allows one session in total, so each
  run was its own `docker run --rm` and closed its browser before the next one
  started.
- **The key** was passed with `-e CLOAKBROWSER_LICENSE_KEY` from the shell. It
  was never on a command line or in the image.

```bash
docker run --rm --network cloakprobe -e PYTHONPATH=/app -e CLOAKBROWSER_LICENSE_KEY \
    -v "$PWD/scripts:/probe:ro" --entrypoint python aimm-recycle:cloak-dev \
    /probe/fingerprint-probe.py --engine cloak --seed 48213 --gpu NVIDIA \
    --proxy http://probe:probe-only@cloakprobe-proxy:8899 > cloak_a.json
python3 scripts/fingerprint-probe.py --compare stock.json cloak_a.json cloak_b.json cloak_a2.json
```

## Runs

Seeds A = 48213 and B = 71529, both with GPU NVIDIA. Every run used
America/Denver and en-US on a 1920x1080 Xvfb screen. Hashes are cut to 12
characters.

| Run | webdriver | platform / client-hint platform | UA | WebGL renderer | canvas | WebGL | cores / memory | outer vs inner width |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stock | **true** | Linux x86_64 / Linux | Chromium 156 (Linux) | ANGLE SwiftShader (Google) | `bf15a9f204e8` | `24c117c43ccc` | 4 / 4 | 1928 ≥ 1920 |
| cloak A | false | Win32 / Windows 19.0.0 x86 64-bit | Windows NT 10.0, Chrome 155, brand "Google Chrome" | ANGLE NVIDIA GeForce RTX 4070 SUPER, D3D11 | `62c165a0e1b0` | `bbec01befde1` | 24 / 16 | 945 ≥ 945 |
| cloak B | false | Win32 / Windows | same | ANGLE NVIDIA GeForce GTX 750 Ti, D3D11 | `005f9a634953` | `123cddfe2d8d` | 16 / 32 | 945 ≥ 945 |
| cloak A again, fresh container | false | Win32 / Windows | same | RTX 4070 SUPER | `62c165a0e1b0` | `bbec01befde1` | 24 / 16 | 945 ≥ 945 |

`--compare` checked 22 expectations and all passed:

- **Every cloak run:** `navigator.webdriver` false, and the UA, client hints
  and `navigator.platform` all say Windows.
- **Every run:** outerWidth ≥ innerWidth, and the page and `context.request`
  left by the same IP.
- **Across seeds:** A and B differ in both the canvas and the WebGL hash.
- **Seed A twice:** the canvas, WebGL, UA, cores, memory and font count were
  identical across two separate containers.

## Proxy: both legs go through it

The proxy's access log for each run shows one CONNECT per leg:

```
172.20.0.3 - CONNECT api4.ipify.org:443 - 4611 bytes - 55.83ms   # context.request
172.20.0.3 - CONNECT api.ipify.org:443 - 4113 bytes - 259.33ms   # the page
```

The same pair appears for stock, cloak A, cloak B and cloak A again. A few
`CONNECT None:None - 0 bytes` lines before them are the proxy's
authentication handshake. Stock Chromium also sent one `www.google.com` CONNECT
of its own; no cloak run did. `context.request` honours the context's proxy
under CloakBrowser, so the token exchange (`facebook.py`, `page.context.request.get`)
needs no `page.evaluate(fetch)` fallback.

## License outage

| Run | Result | Monitor mapping |
| --- | --- | --- |
| `--network none` | `CloakBrowserLicenseError`: "couldn't verify your license (license server unreachable…)", within 3.6 s of the start | `park_reason` = `license_denied`, `license_denial` = `{exit_code: 78}` |
| `cloakbrowser.dev` (and `api.`/`www.`) mapped to 127.0.0.1, proxy as usual | the same, exit 78 | the same |

The binary checks its license **directly from the container**, not through the
context's proxy, so the license server sees the host's IP, never the account's.
A worker host needs direct egress to cloakbrowser.dev.

`test_browser_engine.py::test_a_fleet_worker_whose_license_is_refused_parks_as_such`
covers the rest of the path in the monitor: the fleet loop parks `DEAD` with
`{reason: "license_denied", exit_code: 78}`.

## What the probe shows that is not yet right

- **Fonts.** Every engine and every seed lists the same 13 fonts: Arial,
  Calibri, Cambria, Courier New, Times New Roman, Carlito, Caladea, Liberation
  Sans/Serif/Mono, Noto Color Emoji, Noto Sans CJK SC and Helvetica.
  - Segoe UI, Tahoma, Verdana and Consolas are missing, which a real Windows
    machine has.
  - The Liberation, Carlito and Caladea names are present, which Windows does
    not have.
  - So the Windows persona's font list reads as Linux, and it is identical
    across accounts.
  - `ttf-mscorefonts-installer` would add Verdana, Tahoma and Georgia, but not
    Segoe UI or Consolas. It is still waiting on the owner's licence decision.
- **The window.** Under Xvfb, with no window manager, the cloak window opens
  945 px wide on a 1920 px screen, with outerWidth equal to innerWidth (no
  frame). That passes the outer ≥ inner check, but it is neither a maximized
  window nor the Windows frame width.
- **Arm64.** These runs were on linux/arm64, and the persona still reports
  x86 64-bit. The fleet runs amd64.
