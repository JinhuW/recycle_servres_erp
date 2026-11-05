# CloakBrowser launch plan: a browser profile for every fleet account

**Status:** updated 2026-11-05. Phase 0, the code for Phase 1 and the fixes from the 2026-11-05 review (RS-542 to RS-547, v1.424.2 to v1.425.1) are merged to `dev`. Nothing here has reached `main`, a fleet release or a live worker, and none of the worker code has run in the real CloakBrowser binary yet.

**Tracking:** `[x]` means merged to `dev` or finished, and `[ ]` means not yet. `[owner]` marks an item only the owner can do. The coordinating session is the only editor of this file, so parallel workers don't conflict on it.

## Progress

- [x] Review CloakBrowser against the fleet and proxy service
- [x] Write the plan to a file
- [x] Check the six review gaps against code and prod data (all six confirmed)
- [x] Phase 0: ERP groundwork. Released to `main` as v1.426.0 on 2026-11-05
- [ ] Phase 1: worker and agent build, spikes. Code merged (RS-529, RS-535); agent swapped 2026-11-05; spikes and image still to do
- [ ] Decision G1 `[owner]`
- [ ] Phase 2: controlled pilot
- [ ] Phase 3: automatic profile for new accounts (only on Go)
- [ ] Phase 4: long-term work

## Context

The goal is an automatic browser profile per account, integrated with the fleet and the proxy service. Figures were measured 2026-11-04, read-only, from prod and the code.

This builds on the 2026-11-02 plan (`review-current-fb-fleet-cozy-bunny.md`) and replaces its R2 onward. The engine switch, the image and the state history already exist.

**Recommendation: don't roll it out yet.** Fix the gaps below, then run a controlled pilot. CloakBrowser fixes real faults in the browser, but the data doesn't yet show the browser is what kills accounts.

## What the live data says

| Finding | Evidence | What it means |
| --- | --- | --- |
| Most accounts die fast | Of 131 accounts first claimed in 30 days: 108 lost, 72 of them within 24 h, 23 within 1 h. 20 still held, 3 lost after more than 7 days | Each loss wastes a purchase and a login |
| Batch looks like the biggest driver | Order 2822048: 43 of 50 retired, median 7.5 h. "Added by hand" live stints: median about 200 h | Supplier quality may outweigh any browser change |
| Cloak is unproven | 2 attempts (#76, #130), neither reached HEALTHY, both from poor batches. #76's seller cookie was invalid. No cloak slots exist today | Too few to say anything, in either direction |
| **Ports don't keep their IPs** | 2026-11-04 10:47–10:51 UTC: 14 of 20 ports changed exit IP, mostly IPs moving between ports. 7 live slots moved mid-session; #1, #45, #47, #129 are HEALTHY now, #16, #55, #92 DEAD (link to the move not established). Proxy 24's geo also changed with the IP unchanged. Cause unknown: the owner may have changed something at Decodo, not yet confirmed | A port isn't an identity. Key on the measured exit and re-verify it |
| Bad timezones don't predict death | 15 of 21 slots disagree with their exit, measured after the remap: 3 (#45, #55, #78) caused by it, 12 already wrong. Yet 7 of the 9 HEALTHY accounts are among them | Survivorship applies, but a coherent profile alone may not save accounts |
| Stored proxy geo goes stale | Some labels (Leesburg, Boston) were right until the remap | A typed `fleet_proxies.timezone` can't feed a profile |
| IPs are shared | At the snapshot: 20 Decodo IPs, 6 carrying 2 accounts, 9 carrying 1, 5 carrying none. The five free ports were 10006, 10009, 10014, 10016, 10017; re-measure before use | Solo IPs must be reserved by exit, not port |
| Stock's 24 h loss is about 59% | Report on the prod copy of 2026-11-04: 71 of 120 decided stock accounts lost within 24 h (59.2%), 73 failed (60.8%). The earlier 55% counted accounts still inside their first day | The pilot's bar and the power table below assume 55%; re-read them against the stock arm's actual figure |
| The baseline is young | State history starts 2026-11-03 18:10 UTC | Stock vs cloak needs a cohort test, not the existing rate |

## CloakBrowser review

**What it is:** a closed-source patched Chromium with an MIT wrapper (Python, JS, .NET). Wrapper 0.7.0, Chromium 156. We bake 155.0.8059.39.2. The publisher names no legal entity or country.

| Feature | Use it? | Why |
| --- | --- | --- |
| `--fingerprint=<seed>`, platform, GPU | **Yes**, already wired | Same seed gave the same hashes across containers and architectures |
| Timezone and locale flags | **Yes** | Fed from the ERP's measured exit |
| `--fingerprint-webrtc-ip` | **Yes, new** | Nothing tests WebRTC today. Must pass an explicit IP: `auto` only works inside the wrapper's `launch*` |
| Real Windows fonts | **Needs your decision** | Vendor calls a missing set a common cause of blocks. We show 13 fonts with Linux tells, identical on every account |
| `--license-route=direct` | **Yes** | Licence calls never use a Decodo IP |
| `geoip=True` | No | Adds a lookup and a 70 MB download per container; a failure aborts launch. The ERP already probes every 5 min |
| `humanize=True` | Not yet (Phase 4) | Doesn't touch scrolling or `goto`. Can put a typo in a text-type 2FA field, may truncate descriptions, and would confound the pilot |
| `launch_persistent_context`, `.cloakbrowser-seed` | No | Containers have no volume and hosts are interchangeable; sessions stay sealed in the ERP |
| Manager, `cloakserve` | No | Manager is "early alpha". Our agent and claim already do this job |
| SOCKS5 | No | Decodo is HTTP and the monitor refuses SOCKS |

**Weak points**
- **Independent evidence is thin.** I found no independent Facebook result. Benchmarks place it mid-pack against Cloudflare, and one hands-on test crashed on CreepJS.
- **Open issues matter here.**
  - [#553](https://github.com/CloakHQ/CloakBrowser/issues/553): some seeds still flag as tampering on build 155 with full fonts, so check seeds rather than trust them.
  - [#598](https://github.com/CloakHQ/CloakBrowser/issues/598): a user reports detection by Facebook at registration, and the vendor declined to help.
- **Seeds alone don't separate accounts.** The vendor says in #553: "Several seeds behind one exit IP will often be linked, whatever the browser does."
- **Licence dependency.**
  - Every launch needs the licence server; the binary exits 78 if it's unreachable ([#621](https://github.com/CloakHQ/CloakBrowser/issues/621)).
  - The licence check runs in the background, so `launch` can return first and the browser can die afterwards (same issue).
  - The vendor told one customer a running browser tolerates up to 30 minutes offline; other plans aren't documented.
  - Reverting a proven account to stock is a device change and the ERP refuses it (`cloak_proven`), so a revoked key strands the cloak accounts.

**Terms risk: read before paying.**
- The vendor allows "your own accounts, your own data, and public sites". The pool is purchased accounts, which may fall outside that.
- It can suspend without notice (§10), and fees are non-refundable. Bill monthly and treat the key as revocable.
- Automating Marketplace also breaks Facebook's terms, as your README says. This plan doesn't remove that risk.

**Cost** (promo prices; the listed regular prices are higher)

| Plan | Price | Seats | Fit |
| --- | --- | --- | --- |
| Free | $0 | 1 | Spikes only |
| Team | $49/mo | 20 | Pilot, capped at 18 active cloak accounts |
| Business | $199/mo | 200 | Full fleet: host capacity is already 23 |

Parked workers keep their browser open, so they hold seats too.

## How it connects

```
Decodo port ─► ERP 5-min probe (exit IP, zone) ─┐
                                                ├─► Add to fleet: enroll + bind in one transaction ─► claim answer
account no ─► seed + GPU (unique) ──────────────┘                                                         │
                                                                                                          ▼
                  park, no login ◄─ fail ─ preflight (no Facebook) ◄─ cloak launch + per-context proxy
                                               │ pass
                                               ▼
                                     Facebook, session sealed in ERP
```

**Proxy rules**
1. The proxy stays per context, because a wrapper-level proxy sends `context.request` out from the real IP.
2. The profile's zone comes from the exit, not from a typed value.
3. **Identity is the measured exit IP, never the port.** One pilot account per exit IP, across stock, cloak and compose workers.
4. A new assignment is refused when the exit measurement is stale or failing.
5. When an exit changes, the ERP alerts and blocks first logins on that exit. It doesn't rewrite the profile's timezone automatically.
6. A profile's proxy is pinned. Changing it warns that it counts as a new device.
7. Live accounts are never rewritten.

## Launch phases

Dates are estimates. Accounts come only from batches you assign, per your 2026-11-04 decision.

### Phase 0: ERP groundwork. No worker touched, no logins

**Exit identity (workstream A)**
- [x] Keep the exit's zone: new column on `fleet_proxy_checks`, read from the lookup in `proxyProbe.ts` (RS-538)
- [ ] Confirm one real lookup through a Decodo port returns a zone. Only a direct ipinfo call was checked; a port with no zone refuses enrollment with `exit_zone_unknown`
- [x] Record each exit change per proxy: old and new IP, geo, time, and the slots bound then
- [x] Alert when an exit changes under a bound slot
- [x] Proxies tab flags zone mismatch, stale measurement and a recent exit change. Report only; live devices stay as they are
- [x] Proxies tab flags ports crowding one exit IP (RS-527, RS-528, v1.419.1)
- [x] Enrollment takes its zone from the measured exit, on both arms (RS-538)
- [x] Hold a pilot account's first login while its exit differs from the one recorded at enrollment; re-adding or Change proxy re-records it, and only before first claim (RS-538)

**Enrollment and profile (workstream B)**
- [x] Store the profile on `fb_pool_accounts`, since `fleet_slots.device` is deleted with the slot and remove-then-re-add loses the `cloak_seeded` guard
- [x] Durable enrollment record (account, batch, pilot, arm, seed, measured exit, enrolled and first-claim time) that outlives slot deletion
- [x] Atomic enrollment: `POST /slots` takes engine and arm, and writes enrollment, profile, proxy and slot in one transaction, so no worker can claim a half-set slot
- [x] Reserve by measured exit IP across stock and cloak, and refuse a stale measurement (15 minutes). A plain add or Change proxy onto a pilot's exit is refused too (RS-537)
- [x] Enforce seed uniqueness; `fleetCloakFor` in `packages/shared/src/fleet.ts` doesn't today
- [x] Stop proxy edits in `proxies.ts` rewriting a pinned profile's timezone
- [x] Claim answer carries the expected exit IP and WebRTC IP for cloak slots
- [x] Test: with `cloak_enabled=false`, existing cloak accounts still claim and still receive the licence; only new enrollment stops
- [x] Update `CONTRACTS.md`, which never mentions cloak

**Cohort report (workstream C, after B)**
- [x] Per batch and arm: reached HEALTHY, 24 h and 7 d survival from first claim, searches in the fixed window, failed starts, recovery logins
- [x] Flag accounts touched by an exit change or licence outage, and show results with and without them
- [x] Active cloak count against seats, so the 18 cap and the survivors stay visible
- [x] Also serves as a **supplier scorecard**, which has value even if the pilot fails

**Gate**
- [x] Tests pass and the report matches prod numbers: on the prod copy of 2026-11-04 it gave 130 accounts, 72 lost within 24 h and 108 within 7 days, the same as an independent count
- [ ] Your yes for the `main` release `[owner]`

### Phase 1: Worker and agent build. No Facebook

**Fleet agent (workstream D).** Must reach hosts before worker 0.17.0: an older agent reads the new exit code as a crash and holds the worker after 5 restarts. An agent swap isn't a login.
- [x] New worker exit code **74, licence outage**, distinct from the existing 78 "left for an operator"
- [x] One worker per host probes with jitter, backoff from 5 min to about hourly with no limit, after any other start. The rest follow once a probe stays up for 15 min (RS-544; owner chose hourly over a hold, 2026-11-05)
- [x] Report the hold and retries to the ERP
- [x] Agent swap on hosts: both on 1.426.0 since 2026-11-05 18:42 UTC, no worker restarted

**Worker 0.17.0 (workstream E).** In `browser_engine.py`, `monitor.py`, `entry.py` and `fingerprint-probe.py`:
- [x] Close the browser explicitly on stop. A killed browser can hold its seat for 4–30 min; the replacement exits 76 and parks
- [x] Licence outage (binary exit 78, before or after launch returns): worker exits 74. Exits 76, 77 and 79 stay parked as `license_denied`
- [x] Parked-state exit mapping in `entry.py` must not turn 74 into 78
- [x] Before any Facebook page, a retry costs no login. After a live session, the replacement container restores the session from the ERP and counts as a logged boot login
- [x] Pass `--fingerprint-webrtc-ip` from the claim; add `--license-route=direct`
- [x] **Preflight before any Facebook page:** exit IP matches the expected one on both paths, WebRTC candidates, zone, language, `webdriver`, platform, fonts, window. Failure parks `profile_preflight`, costing no login
- [x] Report session upload failures. A 413 over the 1 MiB cap silently leaves the pool copy stale
- [x] Wrap `build_launch_env` and guard errors as a park. Today they crash-loop
- [ ] Cloak-only fonts through `FONTCONFIG_FILE`, waiting on decision 1. Adding fonts image-wide would change every **stock** account's fingerprint at its next start, which is a device change

**Spikes on worker-60-14**, using the free key's one seat, one run at a time. They need the owner to provide the key at run time, and no Facebook page is opened.
- [x] **S1:** Done 2026-11-05: no leak, check passes. Original question: does WebRTC expose the host IP without the flag? Also run the new preflight check: it requires `webrtc_ip` among the candidates, so a binary that offers only mDNS would falsely park every cloak worker
- [ ] **S2:** run about 50 seeds against FingerprintJS's public demo. Do some flag as tampering (#553)? Does the seed's screen conflict with Xvfb? Quarantine bad seeds
- [ ] **S3:** do hashes hold from 155 to 156? If not, a binary bump is a device change
- [x] **S4:** Done 2026-11-05: dies about 16 min after launch; a fresh launch cannot stay up; seat question inconclusive. Original question: does a browser survive a blocked licence server beyond 30 min, and does `playwright.stop()` free the seat? Also: can a fresh launch stay up 15 min during an outage? If so, a probe would falsely end the outage
- [x] **S5:** **Failed 2026-11-05: blocked before launch is right, blocked after launch reads as `browser_failed`.** Original question: block the licence server before and after `launch` returns; both must end in exit 74, and a retry must recover. The after-launch path relies on the binary writing its denial file

**Gate**
- [ ] All spikes written up in the probe note (S1, S4, S5 written up; S2 and S3 not run)
- [ ] Before tagging 0.17.0: classify a live browser's licence death as an outage, and pin the binary to 155 or fix the frame on 156
- [ ] **Staged** image only, so running workers aren't replaced `[owner]`

### Decision G1 (end of Phase 1): you

- [ ] Read the terms risk, then buy Team ($49, one month) `[owner]`
- [ ] Decide fonts and extra IPs (below) `[owner]`

### Phase 2: Controlled pilot

The earlier canaries can't separate engine from batch, so this test splits each batch.

**Setup**
- [ ] **Arms:** each new batch is split at random in pairs, and the arm is stored at enrollment. Exclude Order 2822048
- [ ] **Same conditions:** both arms use solo exit IPs, and no IP gets two first logins in a day (RS-334)
- [ ] **Seats:** at most 18 active cloak accounts on Team, in waves. Retired accounts free seats, so 20 cumulative fits; parked ones don't free seats. Set `cloak_max_slots` to 18 at most. Buy Business before going past that
- [ ] **First wave:** 5 accounts on 5 re-measured free exits (3 cloak, 2 stock)
- [ ] **Further waves:** need more distinct exits, not just ports (decision 3)

**Measurement, fixed before the first account**
- **Primary outcome:** failed within 24 h of first claim. Failed means retired or problem, never reached HEALTHY, or sitting in a lost session state when the window closes, so it doesn't depend on how fast someone clicks Retire. Secondary: the same within 7 days. The report shows the stint-only lost figure beside it for comparing suppliers.
- **Search yield:** completed searches per account in a fixed 7-day window from first claim, so a long-lived account doesn't get an open-ended count.
- **Everyone stays in:** accounts count in their assigned arm, and failed starts count as failed. An account can't be dropped for doing badly.
- **Incomplete follow-up:** an account released or held by the owner before its clock ends is reported as unknown, not as a survivor.
- **Infrastructure events:** a licence outage, proxy remap or manual Release flags the affected accounts. Results are shown with and without them; the "with" figures decide.
- **No early verdict:** only the pause conditions below act before an arm completes.

**How much 20 per arm can prove.** It's exploratory, not proof. Calculated at two-sided 5%, 80% power, stock at 55%:

| True cloak 24 h loss | Accounts needed per arm | Chance of passing the loss test at 20 per arm |
| --- | --- | --- |
| 55% (no effect) | n/a | 2% |
| 45% | n/a | 11% |
| 35% | 96 | 35% |
| 30% | 61 | not calculated |
| 15% | 22 | 94% |

96 per arm is 192 accounts, about 44 days of purchases at the recent 4.4 a day, and needs far more solo exits.

| Result at 20 per arm | Decision |
| --- | --- |
| Cloak 24 h failure ≤ 30%, at least 20 points under stock, and at least 1.5× searches per account | **Go** to Phase 3, keeping a stock holdout of 1 in 5 new accounts until the combined result is significant or the arms reach 96 |
| Failure clears that bar, but searches under 1.5× | **Hold.** No new enrollment until the cause is known; then your call. Survival without searches doesn't pay for the licence |
| Gap of 10–20 points | **Inconclusive.** Extend to 96 per arm only if you accept the cost above; otherwise treat as Stop |
| Gap under 10 points | **Stop** |

**Stop means stop enrolling, not cancel.**
- [ ] Set `cloak_enabled=false`, which blocks only new switches. Cloak accounts keep running and can't go back to stock
- [ ] Keep enough seats until the last cloak account retires or you decide to abandon the survivors
- [ ] Downsize the plan as they retire; cancel only after that point
- [ ] Put effort into suppliers

**Pause new enrollment if:** the host IP leaks once; two `license_denied` parks in a week from anything but an outage; a preflight pass is followed by a sub-minute wall on 3 accounts in a row; or an exit changes under an enrolled account (resume after re-measuring).

### Phase 3: Automatic profile for new accounts (only on Go)

- [ ] Add to fleet creates the profile with no manual step: engine, unique vetted seed, GPU, zone from the exit, screen, solo exit
- [ ] Keep the stock holdout from the Go decision
- [ ] Live stock accounts stay stock and convert only after losing their session. There is no mass switch, so no extra logins
- [ ] The worker ships in the next planned release, per the first rule
- [ ] Move to Business before active cloak accounts pass 18

### Phase 4: Long term (Q1 2027, each measured separately)

- [ ] **Upkeep:** profile health view (preflight history, exit drift). Binary upgrades gated on `--compare`, shipped with planned releases
- [ ] **Variety:** a macOS persona only if real Mac fonts are obtainable, so the fleet isn't all Windows
- [ ] **Behaviour:** humanize as its own A/B, login flow first, after fixing the 2FA typo risk and description timeouts
- [ ] **Cleanup:** remove the stock path once no stock accounts remain

## Licence outage design

| Moment of failure | What the worker does | Cost |
| --- | --- | --- |
| Binary exits 78 before any Facebook page | Exits 74. Agent retries with backoff and jitter | No login |
| Licence check fails after `launch` returned, before any Facebook page | Target closes; the guard turns that into the licence error; exits 74 | No login |
| Browser dies with a live session | Exits 74. Replacement container restores the session from the ERP | One boot login, logged and counted in the report |
| Exit 76, 77 or 79 | The worker parks `license_denied` | Operator acts |

Retrying through the agent instead of inside the container keeps the existing start stagger. One worker per host probes, after any other start, so a stock restart never queues behind an outage and only one account per host can spend a login on a retry. Simulated with 18 cloak workers and a 4-hour outage: a stock restart at +11 minutes, 6 boots from one worker, and the last worker back 104 minutes after the outage ended.

**The handoff sets the real pace, not the lease.** The agent's retry goes through `/stopped`, which hands the slot straight to the replacement, so every retry is a real boot of the same account. The outage heartbeat keeps the lease for 24 hours, so slotless workers can't take the slot and the host's count holds. It says `operator: true`, so the account can't be retired for an outage. If spike S5 shows a probe can reach Facebook after launch, hourly probing costs logins and a hold becomes the right choice again.

**A network failure during preflight isn't a bad profile.** If the exit can't be measured, the worker parks `connect_failed`, which auto-resumes and re-runs the preflight. The claim always names the last exit seen, so a stale measurement is checked rather than skipped. If only the expected exit fails, the port moved: before any Facebook page the worker exits 75 for a fresh claim at no login cost, and after one it parks `exit_moved` until a manager clicks Restart, which is one boot login. Any other mismatch parks `profile_preflight` for an operator.

## Decisions for you

| # | Decision | My recommendation |
| --- | --- | --- |
| 1 | Windows fonts: vendor says copy from a real Windows PC. That raises a Microsoft licence question, so it's your call | Pilot **with** them only if you're comfortable with the licence. Otherwise pilot without and accept a weaker test |
| 2 | Vendor terms vs purchased accounts | Read §7 and §10 yourself before G1 |
| 3 | More Decodo IPs for the pilot, confirmed distinct by measured exit | Buy only after the first wave clears the pause conditions |
| 4 | Which batch feeds the pilot | A fresh one, split as above |
| 5 | Did a Decodo account change cause the 2026-11-04 10:47 UTC remap? You said maybe | Check Decodo's activity log or ask their support. It decides how often the plan must expect a remap |

**Worth testing alongside:** logged-out Marketplace search. The city slug check already works without a login. Any search that also works logged out needs no purchased account and no login risk. I haven't verified that search does, and it would be a separate ticket.

## Out of scope

Account creation or warm-up, captcha solving, the poster and messenger, and rewriting live sessions or timezones. Homelab compose workers stay stock. On 2026-11-05 no compose workers were running on the homelab VM (only `rs-fleet-homelab-*`, which are ERP fleet workers), though old config files still name ports 10001–10020. If any come back, the reservation counts them through the coordinator's check rows.

## Tickets

Each carries this Ask verbatim:

> Deep review the all feature of these https://cloakbrowser.dev/ and see how we can integrate with my current automation system and see how it can integrate with my proxy service.
>
> Long term goal, It will auto simulate the browser profile for each account.
>
> Create an detailed launch plan for it.

| Workstream | Ticket | Acceptance |
| --- | --- | --- |
| A, RS-538 | Fleet: track each proxy's measured exit | Exit changes are recorded and alerted; tab flags mismatches; no live device changes |
| B, RS-537 | Fleet: atomic account enrollment and browser profile | No claim can see a half-enrolled slot; record survives slot deletion; seeds unique; reservation by exit IP |
| C, RS-539 | Fleet: pilot cohort report | Follows the measurement rules above, per batch and arm |
| D, RS-529 | Fleet agent: licence outage exit | Exit 74 retries are bounded, staggered and jittered, then held |
| E, RS-535 | Fleet worker 0.17.0: preflight, WebRTC, seats, outage exit | Failed preflight parks before any Facebook page; outage exits 74 |
| later | Fleet: automatic profile on Add to fleet (Phase 3) | Add to fleet creates a profile unaided |

## Verification

- **Tests:** `pnpm --filter recycle-erp-backend test` (`fleet-*`), frontend tests, fleet-agent tests, `deploy/cloudflare/worker.test.mjs`, monitor pytest, `rs_worker` tests, and `scripts/release.sh --dry-run`.
- **Contract:** `fake_fleet.py` serves a claim with the new fields, and `entry.py` carries them to the launch args.
- **No Facebook:** extended `fingerprint-probe.py --compare` on worker-60-14, including forced preflight failures (wrong exit, blocked WebRTC) that must park.
- **Local UI:** the fleet page recipe for flags, the profile and the report.
- **Pilot:** the cohort report is the record. Check `rsc vault logins` and worker state events for unexpected logins.

## Standing constraints

- Never restart, recreate or re-login a worker to advance this; each is a login. Ask first.
- Never fill idle workers unasked.
- `dev` merges are authorised. `main`, fleet releases, agent swaps on hosts, buying a plan and changing Worker secrets need your yes.
- The licence key stays out of the repo, tickets, images and memory.
