# CloakBrowser spikes S2 and S3

Run 2026-11-06 on worker image `aimm-recycle:0.17.0` (monitor `5ff8fc2`), on the Team key,
with no account and no Facebook page. Each run was a fresh container going through the
worker's own launch and preflight, then Fingerprint's public demo
(`demo.fingerprint.com/playground`).

This note sits outside `trackers/facebook/` because a change there would make `deploy.sh`
refuse the tagged release. The earlier spikes are in that tree's
`docs/debug-notes/2026-11-02-cloakbrowser-fingerprint-probe.md`.

**Inputs.** 50 profiles from the ERP's own rules for accounts #1001 to #1050
(`fleetCloakFor`, `fleetDeviceFor`): 50 seeds, both GPU families, all 6 screens. The
timezone was the host's own, so a mismatch wouldn't colour the VPN signal.

| Run | Host | Build | Demo readings |
| --- | --- | --- | --- |
| All 50 seeds | `development` | 155 | 46 |
| First 10 seeds again | `development` | 155 | 9 |
| First 10 seeds | `development` | 156 | 9 |
| All 50 seeds, hashes only | `development` | 156 | none |
| 6 seeds, alternating builds | `development` | 155 and 156 | 12 |
| The same 6 seeds | `oci-sg-1` | 155 | 6 |

Six early readings got a 429 from the demo. The paced controls, 30 s apart, got none.

## S2: do seeds flag as tampering?

**Yes, nearly all of them, and the seed isn't what decides it.**

| Signal | Build 155 | Build 156 |
| --- | --- | --- |
| `tampering` and `anti_detect_browser` | 61 of 61 on `development`, 5 of 6 on `oci-sg-1` | 15 of 15 |
| `bot` | **67 of 67 `chromium_automation`** | **0 of 15** |
| Suspect score | 27 to 39 | 25 to 33 |

- **No seeds to quarantine.** All 47 seeds read on `development` flagged, across both GPU
  families and all screens. The one miss was #1014 on `oci-sg-1`, and that seed flagged on
  `development`, so it's a property of the run rather than the seed.
- **The bot verdict follows the build.** The alternating control rules out run order: for
  all 6 seeds, 155 read as a bot and 156 didn't. But 156 has no window frame and fails our
  preflight on every profile (50 of 50), so it isn't an available fix as things stand.
- **Screens don't conflict with Xvfb.** All 50 profiles passed the preflight on 155, each
  showing its own screen with an 8 px frame.
- **Control, one run only.** Stock Playwright on one profile read `bot`, `developer_tools`
  and no tampering, suspect score 42. So on this demo cloak trades one flag for another. One
  run is not a comparison.

### Seeds don't separate devices on this detector

Fingerprint gave **6 visitor IDs across 82 readings of about 50 seeds**. The IDs aren't tied
to a seed, and some appeared on both hosts:

- Seed #1001 read as `eR4h` and later `C71a` on `development`, and `Ed9p` on `oci-sg-1`.
- `eR4h` and `R1u1` each appeared from both IP addresses.

Fingerprint's raw attributes show why. Across the 46 readings:

| Distinct values | Attributes |
| --- | --- |
| 1 | audio, fonts, font hash, font preferences, emoji, math, plugins, touch, colour depth, keyboard |
| 2 | canvas, WebGL extensions |
| 3 to 8 | device memory, screen, hardware concurrency |
| 28 | WebGL basics |

Our own probe's canvas differs more (43 values) because it draws a different test image.
Fingerprint's own test sees 2.

This fits the vendor's own statement in #553 that seeds behind one exit are often linked,
and goes further: IDs were shared across two different IPs here.

## S3: do hashes hold from 155 to 156?

**Mostly, but a build bump is still a device change.** 50 seeds on each build:

| Value | Same on both builds |
| --- | --- |
| Canvas, hardware concurrency, memory, fonts, screen, languages, platform, timezone | 50 of 50 |
| WebGL | **49 of 50.** #1031 moves from GTX 750 Ti to RTX 3060 Ti |
| User agent | 0 of 50, the Chrome version moves |

Repeats of one seed on 155 held every hash, 10 of 10, so this difference isn't noise. Visitor
IDs matched across builds in 8 of 8, then 4 of 6, but they also move between repeats of one
build, so they say little here.

## RS-554: does the launch fingerprint tell seeds apart?

**Yes, on the same saved runs.** The key RS-554 records is a hash of canvas, WebGL, hardware
concurrency, memory, screen, platform and languages. The worker's preflight draws what these
runs' probe drew, line for line.

| Build | Runs | Seeds | Repeated seeds | Repeats that moved | Distinct keys |
| --- | --- | --- | --- | --- | --- |
| 155 | 85 | 51 | 14 | 0 | 51 |
| 156 | 67 | 51 | 14 | 0 | 51 |

No single field would do: on build 155 the 51 seeds share 46 canvas hashes and 32 WebGL hashes,
so comparing canvas alone would have flagged look-alikes that aren't. A clash stays possible as
the fleet grows, which is what `redraw` is for. From S3 above, a build bump should leave most
keys alone but would move at least #1031's WebGL, so it parks that account for Accept.

This is our own hash. It doesn't change the finding above that Fingerprint links these seeds.

## Limits

- **This is Fingerprint's detector, not Facebook's.** Facebook's checks are unknown, so these
  are warnings, not predictions of account loss. Only the pilot measures that.
- **No proxy was used,** so the VPN `os_mismatch` seen on `development` (and not on
  `oci-sg-1`) says nothing about a Decodo exit.
- **Our own repeat visits raised some signals.** `high_activity_device` and some suspect
  scores rose as the run went on, so scores aren't comparable between early and late runs.
- **Fonts are still the Linux set,** pending decision G1, and #553 reports tampering even with
  full fonts. Whether Windows fonts change this wasn't tested.
- **What triggers the flags is unknown.** Launching through Playwright may be part of the
  bot signal, and these runs can't separate that from the binary.
