---
id: RS-539
title: Fleet: pilot cohort report
type: story
status: done
priority: P2
created: 2026-11-05
reporter: jinhu
branch: JinhuW/inconnu
pr: 1095
version: 1.423.0
related: []
---

## Ask

> Deep review the all feature of these https://cloakbrowser.dev/ and see how we can integrate with my current automation system and see how it can integrate with my proxy service.
>
> Long term goal, It will auto simulate the browser profile for each account.
>
> Create an detailed launch plan for it.

## Context

This implements workstream C (the cohort report) of the CloakBrowser launch plan,
`docs/superpowers/plans/2026-11-04-cloakbrowser-launch-plan.md`, following its
"Measurement, fixed before the first account" section. The fleet page had a loss
rate per engine (`GET /api/fleet/stats/engine-loss`, RS-506), but no first-claim
clocks, no assigned arms and no view by batch. The plan found batch to be the
largest visible driver of loss and needs one report for both the pilot and the
suppliers.

It reads the enrollment record (RS-537, `fleet_pilot_enrollments`) and the exit
change record (RS-538, `fleet_proxy_exit_changes`).

## Acceptance criteria

- [x] `GET /api/fleet/stats/cohorts?pilot=` answers per batch and arm, with a row per arm across batches and the pilot's accounts. Manager-only.
- [x] Reached HEALTHY, and lost within 24 h and within 7 d, on clocks starting at the enrollment's `first_claimed_at`.
- [x] "Lost" is a stint ended `retired` or `problem`, as the plan's 30-day figures were counted. A retired slot whose row is gone still counts, and so does an account whose pool row is gone.
- [x] Headline `failed` = lost + never_healthy + survived_in_loss_state, with `failed_pct` over decided, per window, with and without flagged accounts, shown first on the card with a caption. `lost` and `lost_pct` stay as they were and sit beside it. Accounts with no state history keep the stint rule alone.
- [x] Completed searches per account in a fixed 7 days from first claim. Stopped searches, probes and anything outside the 7 days don't count.
- [x] Failed starts stay in their assigned arm and in the denominator.
- [x] Enrolled but never claimed is shown separately, in no window. A first login held for a changed exit is one of these.
- [x] An account released or held by the owner before its clock ends is unknown, not a survivor. One whose clock is still running is neither.
- [x] Accounts touched by an exit change or licence outage are flagged, from first claim on, and results are shown with and without them.
- [x] Recovery boots per arm, labelled in the UI as an upper bound on logins.
- [x] Active CloakBrowser slots against the setting and the cap of 18, parked ones counted.
- [x] With no pilot, the same report is a supplier scorecard by batch and engine from existing history (`days`, default 30).
- [x] No verdict: no Go or Stop anywhere, and counts next to every percentage.
- [x] Read-only: no migration, and no write in the claim path.
- [x] The Analysis tab shows the report, in English and Chinese.

## Out of scope

The decision table itself, which stays the owner's to read. Any new write or
migration, including keeping `facebook_opened` or the time of a manager's park.

## Notes

**Why `failed` leads.** Review found the stint figure biased for the go or stop
reading. Retiring is a manual click, so an account checkpointed at hour 3 and retired
on day 3 is a 24-hour survivor under the stint rule. And `never_healthy` sat in the
denominator without counting against the arm, while the plan says failed starts count
against theirs. `failed` adds both. `lost` stays exactly the plan's definition, and is
the only figure comparable across history and suppliers.

**Limits of the data, left as they are.**

- *Recovery boots are an upper bound on logins.* A worker's `facebook_opened` lives
  in heartbeat detail only, and a claim clears it, so a retry that opened no page
  can't be told from a real login. A claim that died before its first heartbeat
  leaves no row and isn't counted.
- *A manager's park stores no time.* The worker's last heartbeat stands in for one,
  so a park after the clock ended can be reported as unknown, never as a survivor.
  A slot parked and later unparked leaves no trace.
- *A retire is always "lost".* The stint rule can't tell an owner retiring a working
  account from one retiring a dead account.
- *Scorecard health needs state history.* That history starts 2026-11-03 and homelab
  workers have none, so those accounts show as no state history, can't be failed
  starts, and stay out of searches per account. Finished tasks are purged after
  `retention_days` (90 by default), so a longer range under-counts searches.
