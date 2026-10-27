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
  151 used to require a change to the vendored monitor. Since worker 0.14.10
  (RS-421), the export marks these sidecar-pinned profiles with
  `preserve_user_agent: true`, and the entrypoint and monitor retain their
  exact header. The homelab browser already pairs that Mac string with Linux
  Chromium 156 underneath; the move preserves that existing combination.
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

## ca-3 pilot: complete session handover (2026-10-27 UTC)

RS-419 / PR #940 fixed the cookies-only handover before this move: ERP
v1.367.1 and worker 0.14.8, monitor `7ee3acb`. The owner approved the fix,
then migration of ca-3 only. This is a **dev fleet pilot**, with alerts still
off under the earlier owner decision; it is not a production fleet release.

- The current healthy legacy ca-3 was pool **#55**, not the locked #22 from
  the earlier attempt. Its original proxy remains Decodo `isp.decodo.com:10016`
  (the same exit), with the browser's native user agent, Chromium
  156.0.8078.4, viewport 1920x947, screen 1920x1080 at scale 1, en-US and
  America/Los_Angeles. No proxy check or extra Facebook navigation was used.
- A protected pre-copy on worker-60-14 was followed by an offline smoke test
  of the released image with **network none**: the entrypoint wrote the whole
  state unchanged, and Chromium restored all 3 origins and 21 IndexedDB
  databases. Backend 2,798 tests, frontend 1,212, worker 66 and the monitor
  and tracker release suites passed before the live move.
- The host agent was briefly set observe-only. Its capacity stayed 4 and
  the existing worker's container was untouched. ca-3 was unenrolled from
  the legacy queue, then stopped cleanly at **04:59:21** (exit 0, 3.7 s).
- The final saved state (11 cookies, 3 origins, 21 databases), sidecar,
  identity and complete monitor home (including the 270-entry listing cache)
  were copied to `~/fleet-handover/ca-3-final-20261027T045926Z/` on
  worker-60-14, mode 700 / files 600. Every checksum matched and SQLite's
  quick_check returned ok. No secret is in this repository.
- The full state was resealed under dev's key into #55 and checked after
  reading it back. The slot kept its exact presented device and original
  proxy. Password, TOTP and access-token fallback were omitted on dev for
  this pilot, so a failed restore waits for an operator.
- `worker-60-14-3` was created with the normal agent labels and a fresh
  single-use claim ticket. Its complete monitor cache was copied in **before
  its first start**, at **05:00:40**, on worker image
  `ghcr.io/jinhuw/aimm-recycle:0.14.8@sha256:52b0a58a30416be5c35d81f9836f5ed1ac0eb357ec6dff223021833aba9ad1c3`.
- It claimed #55, epoch 3, and logged **Session restored, skipping login**
  at **05:00:50**. Coordinator login #561 is its single `boot`, outcome
  `restored`; the legacy worker's last login stays #556. The fleet heartbeat
  is HEALTHY, and its saved session still contains all 21 databases.
- Normal host management was restored. The production pool's #55 was
  corrected from Available to Fleet / worker-60-14-3, with an assignment
  event and the same proxy, so the active account cannot be assigned again.
  Production credentials and application deployment were unchanged.
- One manual Reno / server_ram task (#19) was queued at 05:03:25 to check
  the actual queue path. It completed at **05:10:11**: 120 cards, 15 opened,
  45 reviewed, 394 seconds, no stop/wall. The worker then took the next due
  task normally.

### Legacy launch paths

The stopped `rs-monitor-ca3` container was removed. Its launch config,
worker-specific environment file and compose file were moved to
`~/recycle_servers/archive/migrated-ca3-2026-10-27/facebook_tracker/` on the
VM. The original `configs/sessions/homelab-ca3/` and Docker cache volume are
preserved. The coordinator's legacy row is retired. The repo removes its
compose/config and console entries so a future deploy cannot recreate it;
the console itself was not restarted.

Rollback requires an operator decision: stop and fence the ERP slot first,
restore the archived launch files, then explicitly start the legacy worker.
That would be another browser boot; never run both copies together.

## west-1 and wc-1b handover (2026-10-27 UTC)

The owner requested the same process for these two workers (RS-421).
PR #944 / worker **0.14.10**, monitor `f4d4fdf`, preserves a sidecar-pinned
legacy user agent verbatim. The new image is pinned to
`ghcr.io/jinhuw/aimm-recycle:0.14.10@sha256:b211950a591d8948b03e346bb60c4486e4362731cb0df38de569d3e10cc315f1`.
Existing workers kept their image and container id; only the new starts
use 0.14.10. This remains a dev fleet pilot, with alerts off.

| Source | Pool | Target | Cookies / origins / IndexedDB | Listing cache | Outcome |
| --- | --- | --- | --- | --- | --- |
| west-1 | #15 | worker-60-14-4 | 10 / 1 / 22 | 8,493 entries | Staged; parked because original proxy returns 503 |
| wc-1b | #30 | worker-60-14-1 | 9 / 1 / 20 | 2 entries | HEALTHY; one boot restored the session |

Before stopping either source, an offline headed-Chromium test with
**network none** restored the entire snapshot and checked the exact user
agent, timezone and viewport. 74 worker/export tests, 611 monitor tests and
all tracker release gates/component suites passed. The host agent was
briefly observe-only; its capacity stayed 4. It was restored afterwards.

**west-1:** the Mac Chrome/151 header, 1280x720 viewport/screen, scale 1,
native en-US/UTC defaults and original Decodo port **10004** were preserved.
It stopped cleanly at 05:27:57. The final checksummed state, sidecar and
monitor home are in `~/fleet-handover/west-final-20261027T052800Z/` on
worker-60-14 (private directories/files); no identity file existed on the
source, and none was invented from the coordinator's generated profile.
The full state was resealed under dev's key, and the cache copied before
the new container started at **05:28:23**. At **05:29:06**, Chromium reported
`ERR_TUNNEL_CONNECTION_FAILED`; the guard parked #15 at epoch 2 and stopped
the container. It never reached Facebook login: the coordinator's login
ledger for worker-60-14-4 is empty. Its rendered proxy server, username and
password match the source exactly. An independent non-Facebook request
through port 10004 returned **503 Service Unavailable from both hosts**.
No new proxy/IP was selected and no browser was retried. Activation waits
for original-proxy recovery or an owner's decision to change its IP.

**wc-1b:** native Linux Chromium 156.0.8078.4, viewport 1280x677, screen
1280x800, scale 1, en-US / America/New_York and Decodo **10009** were
preserved. Non-Facebook checks from both hosts returned the same original
exit IP, **45.58.221.17**. It stopped cleanly at **05:33:47**, and the final
checksummed state, sidecar, identity and monitor home are in
`~/fleet-handover/wc1b-final-20261027T053351Z/` on worker-60-14. Its new
container started at **05:33:57**, over five minutes after west-1's start,
claimed #30 epoch 1 and reported HEALTHY at **05:34:09**. Login #562 is one
`boot`, outcome `restored`; the worker logged **Session restored, skipping
login**. All 20 databases remain in its saved state. The production pool
now names worker-60-14-1 as holder, with an assignment event and the same
proxy; production credentials and deployment were unchanged.

The two old containers were removed only after clean stops. Their launch
configs, worker-specific environment files and compose files were archived
at `~/recycle_servers/archive/migrated-west-wc1b-2026-10-27/facebook_tracker/`
on the VM, mode 700. The original session folders and Docker cache volumes
are preserved. Legacy coordinator rows are retired and queue enrollment
removed. The repo and the host's console compose remove their launch/mount
references; the console was not restarted. This cleanup does not activate
west-1: its new slot stays parked. Rollback still requires stopping and
fencing the ERP slot before restoring any legacy launch file.

When west-1's original proxy recovers (or an owner approves a replacement),
verify the proxy without Facebook first. Temporarily make the host observe-only,
create a fresh worker with a new claim ticket, and restore its monitor home
from the protected `west-final-20261027T052800Z/monitor-home.tar` **before**
unparking #15 and starting it. Do not simply unpark it under the agent: the
failed container has been removed, and an ordinary new container would lose
its listing cache. Check one restored boot and HEALTHY before resuming the
host. The account, full encrypted storage state and presented-device metadata
already remain in its parked slot.

## Random-worker handover: denver-1 (2026-10-27 UTC)

The owner requested another random worker (RS-422). The first health-only
candidate was left untouched because its pool account was Retired. A new
random draw among eight healthy workers with matching active pool assignments,
known proxy exits and no active legacy proxy partner selected **denver-1**.
No retired account was reactivated.

- Source: `rs-monitor-denver`, account **#10**; original Decodo endpoint
  `isp.decodo.com:10006`. Non-Facebook checks from the old and new host
  both returned **72.1.143.239** before the stop. No IP change was made.
- Browser: native Chromium 156.0.8078.4 underneath the already-pinned Mac
  Chrome/151 header, viewport/screen 1280x720 at scale 1, native en-US/UTC
  defaults. `preserve_user_agent: true` retains that header. No cached
  identity existed on the source, and no coordinator-generated profile
  replaced its observed device.
- An offline headed-browser test with **network none** restored the full
  snapshot and checked the exact user agent, timezone and viewport. The
  host agent was briefly observe-only; existing workers kept running.
- The source was rechecked HEALTHY with the expected account and stopped
  cleanly at **09:58:50** (exit 0). The final checksummed state and sidecar
  (10 cookies, 1 origin, **21 IndexedDB databases**) and complete monitor
  home were copied to `~/fleet-handover/denver-final-20261027T095854Z/` on
  worker-60-14, in private directories/files. SQLite quick_check returned ok;
  the listing cache contained **28,524 entries** and was copied in before boot.
- Dev #10 received the whole state resealed under dev's key and the exact
  device, proxy and 18 home cities. Password, TOTP and access-token fallback
  were omitted, so a failed restore would park instead of logging in again.
- A fresh single-use claim ticket started **worker-60-14-4** at
  **09:59:37** on worker **0.14.10** (monitor `f4d4fdf`, image digest
  `b211950a591d8948b03e346bb60c4486e4362731cb0df38de569d3e10cc315f1`).
  It claimed #10 epoch 1, logged **Session restored, skipping login**, and
  reported HEALTHY at **10:00:01**. Login **#563** is one `boot`, outcome
  `restored`. Its saved state retains all 21 databases and its cached device
  retains the exact Mac Chrome/151 header. The login table does not store a
  user-agent column; header preservation was verified through the offline
  browser test and the rendered identity, not inferred from that ledger.
- Production pool #10 now names worker-60-14-4, with an assignment event and
  the same proxy. Production credentials and application deployment were
  unchanged. Host management resumed with capacity still **4**. Existing
  workers 1, 2 and 3 kept their container ids and StartedAt values.
- The source container was removed only after the new worker was HEALTHY.
  Its launch config, worker-specific environment file and compose file were
  archived at `~/recycle_servers/archive/migrated-denver-2026-10-27/facebook_tracker/`
  on the VM. The original session folder and Docker cache volume remain.
  Legacy queue enrollment is removed and its coordinator row retired. The
  console compose loses its references without restarting the console.
- Tracker **0.14.12** versions the launch-file cleanup. The running worker
  stays **0.14.10**; no worker roll was requested. The static denver-1 entry
  in fleet.toml remains for generated region coverage and is not deployed.

This is still a **dev fleet pilot with alerts off**. west-1's #15 slot
remains parked on its original failing proxy. Worker id **worker-60-14-4 now
belongs to denver-1**, so a future west-1 activation must choose a free worker
id and sufficient host capacity, restore the protected cache before boot,
and never replace denver-1 to reuse that id. For a rollback, stop and fence
#10 before restoring any archived legacy launch path; a new browser boot
requires an operator decision.

## Five-worker random batch (RS-423, 2026-10-27 UTC)

The owner requested five more random migrations using the same full-session
procedure. Selection without replacement from seven healthy legacy workers
with matching active production-pool assignments and separate proxy exits
chose the five below. No retired account was revived.

| Source / account | New dev worker | Boot UTC | IndexedDB databases | Cache entries before boot | Restored login |
| --- | --- | --- | ---: | ---: | --- |
| nyc-1 / #16 | worker-60-14-5 | 10:30:08 | 21 | 1,832 | #564 |
| sc-1 / #12 | worker-60-14-6 | 10:33:10 | 21 | 45,503 | #565 |
| homelab-1 / #9 | worker-60-14-7 | 10:36:12 | 21 | 66,740 | #566 |
| ca-4b / #36 | worker-60-14-8 | 10:39:14 | 20 | 226 | #567 |
| nj-2b / #33 | worker-60-14-9 | 10:42:16 | 20 | 2 | #568 |

Each worker passed a non-Facebook proxy check from both hosts, returning its
existing exit IP, and an offline headed Chromium 156.0.8078.4 restoration test
with network none. Original proxies, user agents, geometry, locale and
timezone were preserved from the source's actual presented device. sc-1 and
homelab-1 retain their pinned Mac Chrome/151 header and native en-US/UTC
settings; cached native Linux profiles remain native on the other workers.

Sources were rechecked HEALTHY with the expected account, unenrolled from the
legacy queue and stopped cleanly (exit 0). Final state, sidecars, any cached
identity and complete monitor homes were copied privately with matching SHA256
checksums. SQLite quick_check returned ok for all five listing caches, which
were copied into the new containers before their first start. The full states
were resealed under the dev key with password, TOTP and access-token fallback
omitted. Original sessions and Docker cache volumes remain on the source.

Each target started exactly once, at least three minutes after the previous
browser start, using a fresh single-use claim ticket. Each recorded one boot
with outcome restored, retained its complete state and reported HEALTHY.
No Facebook checkpoint or password login was observed. Runtime is the tested
0.14.10 / monitor f4d4fdf image pinned to digest
`b211950a591d8948b03e346bb60c4486e4362731cb0df38de569d3e10cc315f1`.

Protected final backups on worker-60-14:

- nyc-1: `~/fleet-handover/nyc-1-final-20261027T102938Z/`.
- sc-1: `~/fleet-handover/sc-1-final-20261027T103045Z/`.
- homelab-1: `~/fleet-handover/homelab-1-final-20261027T103346Z/`.
- ca-4b: `~/fleet-handover/ca-4b-final-20261027T103649Z/`.
- nj-2b: `~/fleet-handover/nj-2b-final-20261027T103942Z/`.

The existing shared Cloudflare edge environment was preserved and its
per-worker coordinator-token map extended from slots 1–8 to 1–9. An
idempotent repeat of an existing claim verified the map without starting a
browser or changing its epoch. The host was observe-only during handovers;
its live capacity was already 13 on preflight and was retained when normal
management resumed. Slots beyond the nine usable assignments are not started.
Existing fleet containers 1–4 retain their container ids and original start
times; worker 2 remains SESSION_EXPIRED and was not restarted. west-1's #15
remains parked at epoch 2 on its original failed proxy, with no IP change.

Production pool holder names and proxy records now reflect the new worker ids;
production credentials and application deployment were unchanged. Source
containers were removed only after their targets were verified HEALTHY. Their
launch/config/env files were archived under
`~/recycle_servers/archive/migrated-five-workers-2026-10-27/facebook_tracker/`
on the old VM, with private permissions. The shared secrets.env stays in place.
The generated homelab.toml remains a template for the existing generation
workflow; its archived copy is retained and its old compose launch is removed.
The generated template remains mounted for the console filter-prompt view;
its retired worker is removed from editable config and VNC targets. The
console compose was validated and saved without recreating the console.
Static region templates remain for generated coverage.

Tracker 0.14.13 versions only the legacy launch cleanup; no fleet release or
worker roll was performed. This is still the dev pilot with alerts off.
Rollback requires stopping and fencing the matching ERP slot before restoring
an archived source launch. Do not boot both copies of an account.

## Remaining legacy workers → homelab fleet (RS-426, 2026-10-27 UTC)

The owner installed the ERP fleet agent on homelab and expanded the request
to every remaining legacy worker. Seven running legacy containers remained.
Four accounts were eligible for activation; three transferred parked,
preserving their pool status and original proxy. All stayed on the same host.

| Source / account | New dev worker | Boot UTC | IndexedDB databases | Cache before boot | Restored-boot evidence |
| --- | --- | --- | ---: | ---: | --- |
| nj-3b / #47 | homelab-1 | 15:28:06 | 20 | 2 | container log; ledger unreachable at boot |
| ne-1 / #11 | homelab-2 | 15:34:39 | 22 | 18,102 | #569 |
| va-2 / #1 | homelab-3 | 15:37:41 | 21 | 3,117 | #570 |
| va-2b / #45 | homelab-4 | 15:40:44 | 20 | 2 | #571 |

| Parked source / account | Reason, no browser started | IndexedDB databases | Cache entries |
| --- | --- | ---: | ---: |
| mw-1 / #14 | original proxy :10003 returns 503 | 22 | 32,687 |
| phl-1 / #4 | pool status retired | 21 | 2,766 |
| ca-2b / #52 | pool status problem | 22 | 0 |

Every source passed full-state restoration offline in headed Chromium
156.0.8078.4 with network disabled. Original user agents, geometry, scale,
timezone and locale were retained; ne-1 keeps its pinned Mac Chrome/151 header.
Active proxy probes matched existing exits. va-2/va-2b keep their shared
:10010 endpoint and 45.58.216.8 exit, with starts at least three minutes apart.
mw-1's :10003 returned 503 before any Facebook boot; no replacement IP or
browser retry was attempted. phl-1 stays Retired and ca-2b stays Problem.

Sources were rechecked HEALTHY with the expected account, unenrolled and
stopped cleanly. Final sessions, sidecars, cached identities where present,
and complete monitor homes were transferred with matching SHA256 checksums.
Every SQLite cache passed quick_check. Full states were resealed under dev's
pool key, with dev password/TOTP/token fallback omitted. Fresh single-use
claim tickets started the tested 0.14.10 / monitor f4d4fdf image, digest
`b211950a591d8948b03e346bb60c4486e4362731cb0df38de569d3e10cc315f1`.
Each active container started once, reported HEALTHY and has zero restarts.
No checkpoint or password login was observed. Parked accounts received no
target container and no new Facebook boot.

The first new id, homelab-1, reuses a retired legacy name. Its retired vault
worker binding was detached before boot while preserving encrypted account
data and history. All four new names have no legacy vault binding, preventing
access to another account's credentials. Prior binding metadata is private at
`~/fleet-handover/retired-homelab-1-binding-before-20261027.json`. Existing
shared edge secrets were preserved, adding coordinator tokens for homelab-1
through -4. Loopback VNC ports 5991–5994 avoid the former workers' ports.

**Coordinator routing correction:** the first canary restored, but the old
socat relay admitted only 10.10.60.14 and rejected local Docker hairpin
traffic from 172.24.0.1. Its initial login audit could not reach the coordinator.
Verification checked the unchanged start, zero restarts, one claim and one
“Session restored, skipping login” line, correct full state and HEALTHY.
No ledger record was fabricated and no browser restarted to repair the audit.

Only the LAN relay was replaced: pinned HAProxy admits 10.10.60.14/32 and
172.24.0.1/32. Both worker hosts reach the coordinator, the VM itself remains
rejected, and a new token is refused access to another worker's session.
The old relay remains stopped as `rs-coordinator-lan-socat-rollback-20261027`.
The coordinator, console and worker containers retain their ids and start
times. The pre-existing expired #64 became parked and self-exited 75 during
this work. Its exact stopped container received a durable operator hold;
only the worker-60-14 agent was stopped/started to load that hold. No worker
browser was restarted. See HOSTS.md for the tracked relay and its restrictions.

Protected full backups on homelab:

- nj-3b: `~/fleet-handover/nj-3b-final-20261027T152759Z/`.
- ne-1: `~/fleet-handover/ne-1-final-20261027T153432Z/`.
- va-2: `~/fleet-handover/va-2-final-20261027T153514Z/`.
- va-2b: `~/fleet-handover/va-2b-final-20261027T153816Z/`.
- mw-1: `~/fleet-handover/mw-1-final-20261027T154115Z/`.
- phl-1: `~/fleet-handover/phl-1-final-20261027T154135Z/`.
- ca-2b: `~/fleet-handover/ca-2b-final-20261027T154150Z/`.

Device metadata, migration context and SHA256SUMS accompany the backups.
Original session directories and Docker cache volumes remain. All seven old
containers and dedicated launch/config/env files were retired after transfer.
Private archives are under
`~/recycle_servers/archive/migrated-remaining-homelab-2026-10-27/facebook_tracker/`.
No rs-monitor container remains running. Console compose retains the shared
prompt template, with no legacy worker/VNC targets, and was validated without
restarting the console. Static region templates remain for generated coverage.

Both agents were observe-only during handovers to avoid a competing claim.
Normal management resumed at homelab capacity 4 and unchanged worker-60-14
capacity 13. Production holder names for the four healthy accounts reflect
their new ids; production credentials and parked statuses were retained.
Existing SESSION_EXPIRED workers were not restarted. west-1 remains parked
at epoch 2 on its original failed proxy.

Tracker 0.14.14 versions the relay correction and final legacy cleanup.
Runtime stays 0.14.10; no fleet-wide release or roll occurred. Dev alerts stay
off. Parked activation requires an operator decision and working proxy, with
the protected cache restored before boot. Before restoring a source launch,
stop and fence its ERP slot; never boot both copies.
