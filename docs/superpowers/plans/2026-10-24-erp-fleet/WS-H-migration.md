# WS-H — homelab → ERP fleet migration

## Device profiles for the handover

A moved account must meet Facebook in the same browser it left. This section
says where that browser's fingerprint is recorded, how to export it into the
ERP slot, and what the fleet worker does with it. Observed read-only on
10.10.10.73 on 2026-10-26; nothing was restarted or logged in.

### Where the fingerprint Facebook saw is recorded

**The worker's own `identity.json`, plus the Chromium build in its image.**
The coordinator's `device_profiles` (`rsc identity list`) is not the source.

The monitor picks the device each time it opens a browser context
(`device_context_options` in the vendored monitor, the same code in the 0.13.12
and 0.13.17 images and in the fleet's 0.14.x). It reads only the worker's cached
`/data/identity.json` and the session sidecar `/data/fb_state.json.meta.json`.
On the VM that folder is the bind mount `configs/sessions/homelab-<name>/`.

- **With `identity.json` cached** (25 workers), the browser presents its
  viewport, screen, scale, locale and timezone. The user agent comes from the
  identity, else from the sidecar, with its Chrome version set to the
  browser's. When neither has one, Playwright passes none and Chromium
  presents its own. All 41 coordinator profiles say "the browser's own", and
  so does every cached identity. No sidecar names a device other than the
  cached one.
- **With no `identity.json`** (16 workers, 8 of them logged in), the browser
  presents Playwright's defaults: a 1280x720 viewport and screen at scale 1,
  the container's language (`LANG=C.UTF-8`, so `en-US`) and its clock (no
  `TZ`, so `UTC`). It presents the sidecar's user agent unchanged, or its own.
  The coordinator holds a generated profile for these accounts too, but the
  browser has not presented it yet. Seeding the slot from the coordinator
  would therefore change their fingerprint.
- **The browser's own user agent** comes from the image's Playwright build.
  Both homelab images and the fleet image (`playwright==1.64.1`, see
  `deploy/worker-constraints.txt`) carry chromium-1248, which is Chrome for
  Testing 156.0.8078.4. Headed on Linux with no override, it reports
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)
  Chrome/156.0.0.0 Safari/537.36`. That was checked in a throwaway
  `--network none` container from the 0.13.12 image, which also confirmed the
  1280x720 / UTC / en-US defaults. No worker's browser was touched.
- The login ledger cannot answer this. The monitor records the user agent it
  pinned, so a browser presenting its own UA leaves the column empty.

### Export command

`trackers/facebook/scripts/export-device-profile.py` replays that decision
read-only. It reads the bind-mounted session folder and `docker inspect`, and
reads the image's `browsers.json` with `docker exec cat` (`docker cp` for a
stopped container). It prints no cookie or token values; it only checks
whether a `datr` or `c_user` cookie name is present.

```bash
# once the tree is deployed
ssh jinhu@10.10.10.73 'cd ~/recycle_servers/facebook_tracker && python3 scripts/export-device-profile.py ca1'
# before that, pipe it in
ssh jinhu@10.10.10.73 'cd ~/recycle_servers/facebook_tracker && python3 - ca1' \
    < trackers/facebook/scripts/export-device-profile.py
# --sources wraps it with worker id, browser version, source, session, datr, flags
# --all (JSON lines) or --all --table for every worker
```

A worker can be named as `ca1`, `ca-1`, `homelab-ca1` or `rs-monitor-ca1`.
The output is the slot's `device`, ready for `fleet_slots.device`:

```json
{
  "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  "viewport": [1536, 731],
  "screen": [1536, 864],
  "device_scale_factor": 1.25,
  "timezone": "America/Los_Angeles",
  "locale": "en-US",
  "native": ["user_agent"]
}
```

`native` lists the fields the homelab browser decided for itself. The backend
still fills a default into every claim (`deviceOf` in
`apps/backend/src/fleet/claim.ts`), so the export writes the resolved value
too, but rs_worker leaves a `native` field unset and the fleet browser presents
its own. That matters for the user agent: pinning even the identical string
changes the client hints Chromium sends beside it. `screen`,
`device_scale_factor` and `native` reach the worker through `deviceOf`'s
spread of the stored object (CONTRACTS §5).

### What the fleet worker applies

rs_worker writes the claim's device into the monitor's `identity.json`, and
the monitor's `context_options` passes it to Playwright. Before this change it
set the screen equal to the viewport and dropped the scale, so ca-1
(1536x731 in a 1536x864 screen at 1.25) would have arrived as a 1536x731
screen at 1.0. It now applies `screen`, `device_scale_factor` and `native`
(tests in `rs_worker/tests/test_entry.py`, including one through the monitor's
own `context_options`).

Remaining differences:

- **Six workers pin a Mac user agent from the sidecar** (homelab-1, denver-1,
  mw-1, ne-1, sc-1, west-1), and on the homelab it says `Chrome/151`. A fleet
  worker always caches an identity, and the monitor then rewrites a pinned
  user agent to the browser's version, so they arrive as `Chrome/156`. To
  Facebook that reads as a browser update on the same IP and cookies. Keeping
  151 would take a change to the vendored monitor. The homelab browser already
  pairs that Mac string with Linux Chromium 156 underneath.
- **Things outside the device profile**: CPU count, memory and the WebGL
  renderer come from the host (10.10.60.14 instead of the VM). Fonts come from
  the image, which is the same aimm base on both.
- `FleetDevice` in `packages/shared/src/fleet.ts` still declares only the four
  original fields. The extra keys pass through at runtime. Typing them is an
  ERP change for a later PR.

### The 41 homelab workers (2026-10-26)

| Worker | UA (first 60) | Viewport / screen @ scale | Timezone | Locale | Source | Session, datr | Fleet rendering |
| --- | --- | --- | --- | --- | --- | --- | --- |
| homelab-1 | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA from sidecar | yes, yes | Chrome/151 becomes Chrome/156 |
| bos-1 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1366x645 / 1366x768 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| bos-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1600x789 / 1600x900 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| ca-1 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1536x731 / 1536x864 @ 1.25 | America/Los_Angeles | en-US | identity.json; UA browser's own | yes, yes | same |
| ca-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1920x969 / 1920x1080 @ 1 | America/Los_Angeles | en-US | identity.json; UA browser's own | yes, yes | same |
| ca-2 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1440x789 / 1440x900 @ 1 | America/Los_Angeles | en-US | identity.json; UA browser's own | yes, yes | same |
| ca-2b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1920x969 / 1920x1080 @ 1 | America/Los_Angeles | en-US | identity.json; UA browser's own | yes, yes | same |
| ca-3 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1920x947 / 1920x1080 @ 1 | America/Los_Angeles | en-US | identity.json; UA browser's own | yes, yes | same |
| ca-3b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1366x645 / 1366x768 @ 1 | America/Los_Angeles | en-US | identity.json; UA browser's own | yes, yes | same |
| ca-4 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1366x635 / 1366x768 @ 1 | America/Los_Angeles | en-US | identity.json; UA browser's own | yes, yes | same |
| ca-4b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1536x741 / 1536x864 @ 1.25 | America/Los_Angeles | en-US | identity.json; UA browser's own | yes, yes | same |
| denver-1 | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA from sidecar | yes, yes | Chrome/151 becomes Chrome/156 |
| denver-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | no, no | not movable: no session |
| homelab-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | no, no | not movable: no session |
| mw-1 | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA from sidecar | yes, yes | Chrome/151 becomes Chrome/156 |
| mw-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | no, no | not movable: no session |
| ne-1 | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA from sidecar | yes, yes | Chrome/151 becomes Chrome/156 |
| ne-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | no, no | not movable: no session |
| nj-1 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1536x731 / 1536x864 @ 1.25 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nj-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x689 / 1280x800 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nj-2 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1366x645 / 1366x768 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nj-2b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1366x657 / 1366x768 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nj-3 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1440x767 / 1440x900 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nj-3b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1440x789 / 1440x900 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nyc-1 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1536x731 / 1536x864 @ 1.25 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nyc-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1440x767 / 1440x900 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nyc-2 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1920x969 / 1920x1080 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nyc-2b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x667 / 1280x800 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nyc-3 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x667 / 1280x800 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| nyc-3b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1600x767 / 1600x900 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| phl-1 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | yes, yes | same |
| phl-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1600x777 / 1600x900 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| sc-1 | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA from sidecar | yes, yes | Chrome/151 becomes Chrome/156 |
| sc-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | no, no | not movable: no session |
| va-1 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | no, no | not movable: no session |
| va-2 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | yes, yes | same |
| va-2b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1366x635 / 1366x768 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| wc-1 | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | no, no | not movable: no session |
| wc-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x677 / 1280x800 @ 1 | America/New_York | en-US | identity.json; UA browser's own | yes, yes | same |
| west-1 | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA from sidecar | yes, yes | Chrome/151 becomes Chrome/156 |
| west-1b | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, l` | 1280x720 / 1280x720 @ 1 | UTC | en-US | no identity: Playwright defaults; UA browser's own | no, no | not movable: no session |

"same" means that, after this change, the fleet worker renders the export
exactly as the homelab browser presents it. Eight accounts have no logged-in
session (no `c_user`), so they have nothing to hand over: moving one is a
fresh login, which this plan rules out.
