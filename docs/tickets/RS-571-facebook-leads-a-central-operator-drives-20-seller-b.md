---
id: RS-571
title: "Facebook Leads: a central operator drives 20 seller browsers with browser-use"
type: story
status: in-progress
priority: P2
created: 2026-11-08
reporter: jinhu
branch: JinhuW/margate-2
pr:
version:
related: [RS-565, RS-394, RS-554, RS-538]
---

## Ask

> let we ultrathink the feature plan for the facebook Leads.
>
> 1. I hope we have a centralized agent which can manage like 20 facebook account which is using the fringerprinter browser.
> The agent will use the brower use skill to operate the browser.
>
> A few feature of it.
> 1. POST we buy post in different locations.
> 2. router the message to our message center in the facebook leads.
> 3. Once we replied, it will also chat back to the sellers.
> 4. Each browser should have it own proxy, Browser fingerprint, etc.
> 5. It will have a dedicated facebook account pool for managing these service
> 6. User should also have the access to the controlled browser to wach or control the browser.

## Context

RS-565 (v1.445.2 on prod) already built the ERP side of most of this:

- ads, photo pools and placements by location;
- threads and the Leads ▸ Facebook message center;
- the negotiating agent, with its guards, versioned profiles, shadow and replay;
- pacing, the kill switch and Telegram alerts.

The fleet gives each slot a sealed sticky proxy (`fleet_slots.proxy_url`), a
device profile, and a CloakBrowser seed with a pinned first-launch record
(RS-554). Managers can watch a worker over the VNC relay
(`apps/backend/src/fleet/vnc.ts`), which stays view-only until Take control.
Nothing seller-side has touched Facebook yet. RS-565 F.live step 4 (the first
seller account, one login) still waits.

What RS-565 lacks is how the browsers are driven:

- **The driving code lives inside the browser container.** The four seller
  task kinds run in the account's Python fleet worker, so every code change is
  a container recreate, which is a Facebook login (root `AGENTS.md`, first
  rule).
- **The selectors are guesses.** They were never checked against real pages,
  and a Facebook page change needs a worker release.
- **No dedicated pool.** A seller is a `role` flag on a shared slot.
- **Take control is client-side only.** No process pauses while a manager
  types.

The plan, approved 2026-11-08, adds a **seller operator**: one TypeScript
process on a dedicated seller host.

- It drives about 20 long-lived CloakBrowser containers over CDP, so an
  operator update restarts no browser.
- Fixed TS skills read the inbox and send replies. 20 accounts check the inbox
  about 3,360 times a day, too many for a model call each.
- browser-use fills the ad composer and repairs steps that break.
- Only code presses Send, Publish or Delete.
- fbAgent reads seller text and has no browser tool. The browser agent takes
  tasks only from code.

The plan folder is
[docs/superpowers/plans/2026-11-08-fb-seller-operator/](../superpowers/plans/2026-11-08-fb-seller-operator/README.md).
The explainer page is `http://10.10.100.225:8800/fb-seller-operator-plan.html`.

## Acceptance criteria

- [ ] A manager adds an account to the seller pool. It never appears in search claims, Add to fleet or purchaser take.
- [ ] Each seller account has one metro, one static exit IP, one CloakBrowser seed and its own profile folder. No two seller browsers share an exit IP.
- [ ] Updating or restarting the operator leaves every browser container running, with no new launch record and no boot.
- [ ] Inbox reads and sends make no model call when the page matches.
- [ ] When a fixed skill fails, browser-use recovers within the step cap on Facebook domains only, and it never presses Send, Publish or Delete.
- [ ] A placement is posted only by the account whose metro covers its location.
- [ ] The Browsers tab shows every seller browser. A manager can watch one live, Take control pauses the operator at its next safe point, and Release resumes it.
- [ ] A login page, a checkpoint or a moved exit parks that account and alerts. Only a person logs in, and the operator never receives a password.
- [ ] Operator model spend stops at its daily cap.
- [ ] RS-565's guarantees still hold on the operator: no duplicate send or post, the kill switch, hand-off, and search workers unchanged.

## Out of scope

- Automatic login, and solving CAPTCHAs or checkpoints: a person does both, in the live view.
- Group chats, selling ERP inventory, and selectors kept in the DB (as in RS-565).
- Browser Use Cloud. It was considered as the browser provider; self-hosted CloakBrowser was recommended because the licence is paid and sessions stay on our machines.
- Removing the Python seller kinds from the tracker. That goes in a later tracker release, after the operator runs a clean week.

## Notes

- This is the next step of RS-565, which stays open. The plan recommends
  pausing its F.live step 4 so the first seller account starts on the
  operator rather than moving device later.
- The plan's recommended choices:
  - our own seller host;
  - browser-use as a Python sidecar;
  - one static ISP IP and one metro per account;
  - a persistent profile folder per account;
  - login only by a person.

  The choices that spend money get confirmed when the work reaches them:
  CloakBrowser seats, the proxies, the host and the model budget. The plan
  README tracks them.
- Cost and host-size figures in the plan are estimates.
