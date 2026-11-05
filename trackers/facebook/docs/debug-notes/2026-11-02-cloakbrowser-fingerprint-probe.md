# CloakBrowser fingerprint probe: what a worker presents, with no account

**2026-11-02, facebook-tracker 0.16.0, RS-505.** R1 passed on the dev host; see *R1: amd64 on worker-60-14* below.

- **Image:** the worker image built locally from this branch
  (`aimm-recycle:cloak-dev`, linux/arm64). The first pass had the monitor at
  `dc7137c`. The second pass, after the review fixes, had it at `f76ca2a`; see
  *Second pass* below.
- **Browsers:** CloakBrowser 155.0.8059.39.2 on a free key, and stock Chromium
  156.0.8078.4 (Playwright 1.64.1).
- **Repeated on a second build.** Every run was repeated on an earlier build of
  the same image (monitor `6d464cd`/`ab1f7c8`) with identical hashes, so a seed
  holds across rebuilds as well as containers.

`scripts/fingerprint-probe.py` runs inside the worker image and goes the way a
fleet worker goes, minus the claim:

1. A made-up claim device becomes `identity.json` through rs_worker's `identity_for`.
2. rs_worker's own `start_display` runs Xvfb at `screen_geometry`'s screen,
   with openbox for a cloak device (since the second pass).
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

## Second pass: the window, the locale, the engine (monitor `f76ca2a`)

The review of the first pass asked for four changes:

- **Window.** A cloak window placed at 0,0 and sized as the device's screen
  (`--window-position`, `--window-size`), under a window manager. Before, it
  was 945 px wide and unframed.
- **Locale and timezone** through cloakbrowser's `build_args`, which adds
  `--fingerprint-locale` beside `--lang`.
- **An API-mismatch park.** A moved cloakbrowser internal parks the worker
  `browser_failed` instead of crash-looping it.
- **`detail.engine` in heartbeats.**

**Choosing the window setup.** It was measured first, with a cloak browser on
a 1920x1080 Xvfb screen. CloakBrowser clamps the outer height to the available
height (1032).

| Window manager | Flags | outerWidth / availWidth | outer − inner |
| --- | --- | --- | --- |
| none | `--window-position=0,0 --window-size=1920,1080` | 1919 / 1920 | 0 |
| openbox | `--start-maximized` | 1920 / 1920 | 0 |
| **openbox** | **`--window-position=0,0 --window-size=1920,1080`** | **1919 / 1920** | **8** |
| openbox | `--window-position=0,0 --window-size=1920,1032` | 1920 / 1920 | 8 (the inner height shrinks to 907) |

So rs_worker starts openbox after Xvfb, **for a cloak device only**, and the
monitor passes the screen's size. Stock keeps the display it always had, so
the windows that live stock accounts present don't move. The frame is 8 px
rather than the ~16 px of a Windows Chrome, which is openbox's border, not a
Windows one. It is recorded here, not tuned.

### arm64, second pass: `--compare` 31/31 pass

| Run | webdriver | platform | canvas | WebGL | outer / inner / availWidth | frame | outer − avail | languages / Accept-Language |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stock | true | Linux x86_64 | `bf15a9f204e8` | `24c117c43ccc` | 1928 / 1920 / 1920 | 8 (emulated viewport) | +8 | `en-US` / `en-US` |
| cloak A | false | Win32 | `62c165a0e1b0` | `bbec01befde1` (RTX 4070 SUPER) | 1919 / 1911 / 1920 | 8 | −1 | `en-US, en` / `en-US,en;q=0.9` |
| cloak B | false | Win32 | `005f9a634953` | `123cddfe2d8d` (GTX 750 Ti) | 1919 / 1911 / 1920 | 8 | −1 | the same |
| cloak A again, fresh container | false | Win32 | `62c165a0e1b0` | `bbec01befde1` | 1919 / 1911 / 1920 | 8 | −1 | the same |

- **New checks.** Every cloak run now also passes three: the window has a
  frame (outer − inner > 0); the window is the screen's width (|outer −
  availWidth| ≤ 16); and `navigator.languages` and Accept-Language (read back
  from `httpbin.org/headers` through the proxy) lead with the device locale.
- **Fingerprints unchanged.** The canvas and WebGL hashes match the first
  pass, so the window change moved no fingerprint.
- **Proxy.** Its log shows `api.ipify.org` (the page), `api4.ipify.org`
  (`context.request`) and `httpbin.org` (the headers) for every run.
- **Key absence.** `docker history --no-trunc` and `docker inspect` count 0
  for `cb_`. The exported filesystem holds neither the key nor its sha256.

### amd64: the local build

`aimm-recycle:cloak-dev-amd64` builds from the same tree. It bakes the x86-64
CloakBrowser 155.0.8059.39.2, and its key-absence checks are all 0. Its
installed font families are identical to arm64's (`fc-list : family`):

> Bitstream Charter, C059, Caladea, Carlito, Courier 10 Pitch, D050000L,
> FreeMono/Sans/Serif, IPAGothic, IPAPGothic, Liberation Mono/Sans/Sans
> Narrow/Serif, Loma, Nimbus Mono PS/Roman/Sans/Sans Narrow, Noto Color
> Emoji, Noto Sans/Sans Mono/Serif CJK (HK, JP, KR, SC, TC), P052, Standard
> Symbols PS, URW Bookman, URW Gothic, Unifont (+CSUR, Upper, JP),
> WenQuanYi Zen Hei (+Mono, Sharp), Z003.

**No Chromium runs on amd64 on this Mac.** Colima's VM is aarch64, and amd64
containers run under qemu user-mode emulation. Under it, stock Playwright
Chromium aborts as CloakBrowser does:

- `qemu: uncaught target signal 6`;
- `ptrace: Function not implemented`;
- with `--single-process --no-zygote --disable-gpu`, `QEMU internal SIGTRAP`.

That is the emulator, not the image. Restarting colima with Rosetta would stop
every session's containers, so it wasn't done.

**R1 gate, still to run.** The amd64 probe runs on the dev host, with no
account, no Facebook, and **no cloak worker running at the same time**,
because the free key has one seat. Run each line on its own, wait for it to
finish, then run the next:

```bash
# on the dev host, from trackers/facebook, with the R1 image and a throwaway proxy as above
docker run --rm --network cloakprobe -e PYTHONPATH=/app -e CLOAKBROWSER_LICENSE_KEY     -v "$PWD/scripts:/probe:ro" --entrypoint python <image> /probe/fingerprint-probe.py     --engine stock --proxy http://probe:probe-only@cloakprobe-proxy:8899 > stock.json
# then the same with: --engine cloak --seed 48213 --gpu NVIDIA  > cloak_a.json
#                     --engine cloak --seed 71529 --gpu NVIDIA  > cloak_b.json
#                     --engine cloak --seed 48213 --gpu NVIDIA  > cloak_a2.json  (a new container)
python3 scripts/fingerprint-probe.py --compare stock.json cloak_a.json cloak_b.json cloak_a2.json
```

R1 passes when `--compare` passes.

### R1: amd64 on worker-60-14, `--compare` 31/31 pass

Run on 2026-11-03 UTC against the released image
`ghcr.io/jinhuw/aimm-recycle:0.16.0@sha256:fce04736d45bea11f83aa9502eb88ce09f3a5473d561a220f4eecc472ead7533`
(label `com.recycleservers.cloak-version` = 155.0.8059.39.2), pulled on the
host beside its nine running workers. Those were not touched, and no cloak
worker existed, so the probe had the free key's one seat. The proxy was the
same throwaway `proxy.py` sidecar on a private network; it, the network and
the probe files were removed afterwards.

| Run | webdriver | platform | canvas | WebGL | renderer | cores |
| --- | --- | --- | --- | --- | --- | --- |
| stock | true | Linux x86_64 | `bf15a9f204e8` | `1231b6cedb15` | ANGLE SwiftShader (Vulkan, Subzero) | 8 |
| cloak A | false | Win32 | `62c165a0e1b0` | `bbec01befde1` | RTX 4070 SUPER, D3D11 | 24 |
| cloak B | false | Win32 | `005f9a634953` | `123cddfe2d8d` | GTX 750 Ti, D3D11 | 16 |
| cloak A again, fresh container | false | Win32 | `62c165a0e1b0` | `bbec01befde1` | RTX 4070 SUPER, D3D11 | 24 |

- **A seed's fingerprint does not depend on the host.** The cloak canvas
  and WebGL hashes are the arm64 ones exactly, so a seed is the same device
  wherever its worker runs. Stock's WebGL hash differs from arm64's (its
  SwiftShader backend is Vulkan here), and stock reports the host's cores.
- **Window and locale** as on arm64: outer 1919 / inner 1911 / available
  1920, an 8 px frame, `en-US, en` and `en-US,en;q=0.9`.
- **Proxy.** Every run logged CONNECTs for `api.ipify.org` (the page),
  `api4.ipify.org` (`context.request`) and `httpbin.org`. Only stock also
  opened `www.google.com`.
- **License outage.** `--network none`, and a run with `cloakbrowser.dev`,
  `api.` and `www.` mapped to 127.0.0.1 behind the proxy, each failed
  within seconds with `CloakBrowserLicenseError` (license server
  unreachable), exit code 78, `park_reason` = `license_denied`.
- **Key absence.** `docker history --no-trunc` and `docker inspect` of the
  pushed image count 0 for `cb_`, and the build log holds no key. The key
  reached the host only over ssh stdin, into the probe's environment.

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
- **The window, fixed in the second pass.** In the first pass, with no window
  manager, the cloak window opened 945 px wide on a 1920 px screen, unframed.
  It is now the screen's width with an 8 px frame. A Windows frame is ~16 px.
- **Both architectures probed.** The persona reports x86 64-bit either way,
  and the amd64 run on the dev host passed (R1 above).

## Spikes S1, S4 and S5: `oci-sg-1`, 2026-11-05

Run with no account and no Facebook page, on a throwaway image
(`aimm-recycle:spike-ee40173`, monitor `ee40173`), using the worker's own launch,
preflight and outage classification. The proxy was a throwaway `proxy.py` on the Mac,
tunnelled over ssh, so the exit (`74.104.122.134`) differs from the host
(`140.245.106.33`). An outage was simulated by dropping the test containers' direct
egress in `DOCKER-USER`; the proxy path stayed up. These runs stop at the classifier:
`monitor.py`'s exit itself is covered by unit tests, not by these runs.

**The key changed what gets baked.** A build now fetches 156.0.8078.47.1, where 0.16.0
has 155.0.8059.39.2. The key identifies as CloakBrowser Pro and ran 4 browsers at once;
the upper limit was not measured.

| Spike | Result |
| --- | --- |
| S1, no flag | Preflight saw no WebRTC candidates, so no host IP |
| S1, with the flag | An mDNS name plus a srflx candidate on the exit IP; the `webrtc` check passes |
| S1, forced wrong exit, blocked WebRTC | Both fail their checks and park `profile_preflight` |
| S5, blocked before launch | Dies in about 25 s, exit 78, `license_outage()` true; a retry after unblocking works |
| S4, fresh launch during an outage | Cannot stay up: the same 25 s |
| S5 and S4, blocked after launch | **Fails. See below.** A retry after unblocking works |
| S4, does `playwright.stop()` free the seat | **Inconclusive.** A new launch worked straight after, but the key has spare seats |

**A live browser in an outage dies as a plain crash.** Each blocked browser died about
16 minutes after launch (961 to 968 s), with the block applied either at once or 90 s
after launch, on both 155 and 156. Two unblocked controls, one per build, ran the full
25 minutes beside them. After each death:

- The error is `TargetClosedError`, and the guard does not turn it into a licence error.
- The denial file never appears, checked for 44 s after the death.
- `license_denial()` is None, `license_outage()` is false, `park_reason()` is `browser_failed`.

So the after-launch row of the plan's outage table doesn't hold: these workers would
park `browser_failed` rather than exit 74. Not measured: when a browser dies if the
outage starts long after launch.

**Probe timing.** A browser whose block starts just after launch lives past
`OUTAGE_RECOVERED_MS` (15 minutes) by about a minute, so one launched in that window
could falsely end an outage. A launch inside an outage dies in 25 s and can't.

**156 fails the preflight on a good profile.** Same code and host, three runs on 156 and
one on 155:

| Binary | outer / inner width | `window` check |
| --- | --- | --- |
| 155.0.8059.39.2 | 1919 / 1911 | passes |
| 156.0.8078.47.1 | 1919 / 1919, no frame | **fails** |

Every cloak worker on 156 would park `profile_preflight`, and the failure also hides a
moved exit, since `exit_moved` needs the exit to be the only failure.

**S3, in part.** Seed 48213's canvas (`62c165a0e1b0`) and WebGL (`bbec01befde1`) hashes
and its font count are the same on both builds. The UA's Chrome version does change.

