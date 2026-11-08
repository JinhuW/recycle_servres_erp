# Seller operator: one agent drives 20 Facebook seller browsers

**Ticket:** [RS-571](../../../tickets/RS-571-facebook-leads-a-central-operator-drives-20-seller-b.md) · **Owner:** jinhu · **Started:** 2026-11-08 · **Builds on:** [RS-565](../2026-11-07-fb-seller/README.md)

Read this file, then [`CONTRACTS.md`](CONTRACTS.md), then your workstream
file. The explainer page is
`http://10.10.100.225:8800/fb-seller-operator-plan.html`.

## What we are building

RS-565 built the brain in the ERP: ads, photo pools, placements, threads, the
Leads ▸ Facebook message center and the negotiating agent. This plan replaces
the hands, which today are the four seller task kinds that run inside an
account's Python fleet worker.

- A **seller pool**: accounts with `purpose = 'seller'`. Search claims,
  Add to fleet and purchaser take never see them. Each one has a metro, one
  static exit IP, a CloakBrowser seed and a persistent profile folder.
- A **seller host**: a machine with `fleet_hosts.kind = 'seller'`. It runs one
  long-lived browser container per seller account and one **seller operator**
  (`apps/seller-operator`, TypeScript).
- The **operator** claims each account through the existing worker routes. It
  drives each browser over CDP on a private network:
  - fixed TS skills for inbox reads, sends, deletes and the publish step;
  - a **browser-use** sidecar that fills the ad composer and repairs a failed
    step.

  Only code presses Send, Publish or Delete. Updating the operator restarts no
  browser.
- **Watch and control** in Leads ▸ Facebook ▸ Browsers:
  - a tile per browser;
  - a live view over the existing VNC relay;
  - a Take control that holds the operator in the ERP until Release.

```
ERP: queue, threads, fbAgent, VNC relay, control lock, run log
  ▲ worker routes (one identity per browser)      ▲ VNC dial-in per browser
seller-operator ── CDP (private network) ──► browser-01 … browser-20 ──► own proxy ──► Facebook
  ├ fixed skills (no model)
  └ browser-use sidecar (navigate, read, fill; never commit)
```

Two agents stay apart:

- **fbAgent** reads seller text and writes reply text. It has no browser tool.
- **The browser agent** gets its instructions only from code, and sees seller
  text only as page content.

## Owner decisions

The owner approved the plan on 2026-11-08 with these recommendations. The ones
marked *confirm* spend money or touch live accounts, so they are asked again
when the work reaches them.

| # | Decision | Choice | State |
| --- | --- | --- | --- |
| D1 | RS-565 F.live step 4 | Pause it, so the first seller starts on the operator | confirm before Phase 4 |
| D2 | Where browsers run | Our own seller host with CloakBrowser, not Browser Use Cloud | approved |
| D3 | Repair agent | browser-use as a Python sidecar (Stagehand is the TS fallback if S2 fails) | approved, S2 decides |
| D4 | CloakBrowser seats | Buy seats for the seller browsers; `cloak_max_slots` (20) belongs to search today | confirm |
| D5 | Proxies | One static ISP IP per account, in its metro | confirm (orders) |
| D6 | Profile folder | Kept per seller account, with an encrypted backup | approved |
| D7 | Login | A person in the live view only; the operator never receives a password | approved |
| D8 | Locations | One metro per account; a placement goes to the account that covers it | approved |
| D9 | Host | A dedicated machine, about 32 GB RAM and 8 cores (estimate) | confirm (which one) |
| D10 | browser-use model and daily cap | `fb_seller_settings.operator.model` stays null until a manager sets it | confirm |

## Phases and workstreams

Nothing touches Facebook before Phase 4.

| Phase | WS | File | Scope | Needs |
| --- | --- | --- | --- | --- |
| 0 | S | [WS-0-spikes.md](WS-0-spikes.md) | S1 browser container and CDP; S2 browser-use guard; S3 leak test | host `development`, licence key at run time, a model key for S2 |
| 1 | A | [WS-A-erp.md](WS-A-erp.md) | Migration, claim filters, seller pool, control and hold, run log, tiles, settings | CONTRACTS frozen |
| 2 | B | WS-B-operator.md (written when S1 passes) | Operator core: keeper, claims, CDP, control, VNC dial-in, tiles, run log | A, S1 |
| 2 | C | WS-C-browser-image.md (when S1 passes) | Browser image: CloakBrowser, Xvfb, x11vnc, forwarder, egress lock, launcher | S1, S3 |
| 2 | D | WS-D-skills.md (when S1 passes) | Fixed skills ported from the Python seller tasks, with fixtures | contract only |
| 3 | E | WS-E-agent-sidecar.md (when S2 passes) | browser-use sidecar with guarded tools, caps and traces | S2 |
| 2 | F | WS-F-ui.md (when A's routes merge) | Accounts and Browsers tabs, live view with the server lock, run log | A |
| 3 | R | WS-R-review.md | Independent review of the merged code, then fixes | B–F |
| 4–5 | G | WS-G-rollout.md | Local walk against fake Facebook pages, then live, one step per owner yes | R |

```
S ─┬─► C ─┐
   ├─► E ─┤
A ─┼─► B ─┼─► R ─► G.local ─► [owner yes per step] ─► G.live
   ├─► F ─┤
D ─┘──────┘
```

## Rules for every agent

1. **Contracts first.** `CONTRACTS.md` is the one source for tables, routes,
   payloads, container and sidecar interfaces. Once frozen, a change goes
   through the orchestrator in one PR.
2. **Never touch the live fleet.** Don't start, stop, restart or recreate a
   container on `10.10.10.73`, `10.10.60.14` or `oci-sg-1`, and don't edit
   files there. Don't re-login, create a fleet release or set a Railway
   variable. Don't push to `main`, and take no live Facebook action. Spikes on
   `development` (`dev@10.10.60.10`) use no Facebook account and don't touch
   its fleet containers.
3. **No secret in a commit, fixture, log, trace or PR body.** This covers
   `fb_pool_accounts` secrets, `FB_POOL_KEY`, proxy credentials, the
   CloakBrowser licence key and session cookies. The owner gives the licence
   key at run time over ssh stdin, never on a command line.
4. **One worktree, one branch** off `origin/dev`, PR to `dev`, squash-merge.
   Rebase right before merging and re-check the migration number, the root
   version and the CHANGELOG heading.
5. **Versions.** `apps/seller-operator` is ERP code under the root
   `package.json`: bump the minor and add a CHANGELOG section in the same PR.
6. **Tests before the PR**:
   - `pnpm typecheck`;
   - the backend suite (one file: `cd apps/backend && npx vitest run tests/foo.test.ts`);
   - the operator's vitest;
   - the sidecar's pytest.
7. **Local servers on your own ports.** Never `pkill` a dev server.
8. **Report back here.** Tick your exit criteria and update the Status table
   in the same PR.

## Status

| WS | State | PR | Version | Notes |
| --- | --- | --- | --- | --- |
| plan | PR open | — | — | ticket RS-571, this folder, CONTRACTS draft |
| S | waiting | | | needs host `development`, the licence key and a model key |
| A | waiting | | | starts once CONTRACTS is frozen |
