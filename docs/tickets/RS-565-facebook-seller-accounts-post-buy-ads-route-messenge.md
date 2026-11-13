---
id: RS-565
title: Facebook seller accounts post buy ads, route Messenger to an ERP message center, and an agent negotiates
type: story
status: wont-do
priority: P2
created: 2026-11-07
reporter: jinhu
branch: JinhuW/fireworm
pr:
version:
related: [RS-394, RS-313, RS-314, RS-341]
---

## Ask

> The current facebook fleet can only track the listing item in the marketplace.
>
> I also would like to manage each facebook to post an item in the marketplace and route to the messaagers message to the message center or invite certain user to the group to process the next step.
>
> it will be great that an agent can help me screen some itital messages. price negonate, etc and ask human involve if agent feel we need to.

> ah. i see. it can. then let we route the message to a message center, we answer in the ERP system.

> 1. Manager control the draft of POST instead of hard code.
> 2. Auto limit - When it is about to deal, then let human involve in.
> 3. all configuration form DB and not static configuration file
> 4. I hope more flexiable for the agents part regarding the developments.

> For the image in the post, Manager can provide a source pool. Then the agent post pick random. Do not pcik any same.

> First. let we start an test. Post first post in the facebook marketpalce.

## Context

The ERP fleet (RS-394) runs one task kind that matters, `search`: workers
long-poll `POST /api/fleet/worker/next-task` and search a city for an item.
Nothing posts, reads an inbox or answers a seller.

The pieces that once did, `rs_poster`, `rs_messenger` and `rs_router`, are
parked. They were built for one homelab account, report to the Python
coordinator, and are not in the worker image (`deploy/Dockerfile.worker`). A
second browser on a fleet account is ruled out by the slot fencing
(`apps/backend/src/fleet/auth.ts`). So posting and messaging become new fleet
task kinds that run inside the claimed worker's own browser, and the ERP owns
everything else: ads, photo pools, threads, the agent and its configuration.

The owner's answers on 2026-11-07:

| Decision | Choice |
| --- | --- |
| What gets posted | "We buy" ads only, so the agent negotiates what we pay |
| Who drafts posts | Managers, in the ERP |
| Post photos | A manager-filled pool; random photos per post; no photo ever used twice |
| Routing | ERP message center; staff answer in the ERP. Group chats dropped |
| Agent | Sends on its own while screening and negotiating |
| When a person steps in | When a deal is about to close, plus the other hand-off rules |
| Configuration | All in the DB, edited in the ERP. Selectors and step timings stay in the worker code |
| Agent flexibility | Prompts, rules, skills and models in versioned profiles, tested in shadow and on replays |
| Accounts | Dedicated seller accounts, which stop searching |
| Who answers | Managers only |

The plan is split for parallel agents in
[docs/superpowers/plans/2026-11-07-fb-seller/](../superpowers/plans/2026-11-07-fb-seller/README.md).

## Acceptance criteria

- [ ] A manager marks an account as seller with no login, and it stops searching.
- [ ] A manager drafts an ad in the ERP and places it, and the seller account publishes it, renews it and removes it by listing ID.
- [ ] Managers fill photo pools. Each post and renewal draws random photos, and no photo is ever used twice or uploaded twice.
- [ ] Every setting is edited in the ERP, kept in the DB with history, and takes effect without a restart.
- [ ] Seller replies appear in Leads ▸ Facebook within one inbox check, and managers answer from the ERP.
- [ ] The agent screens and negotiates on its own, never above the code-computed ceiling, and never accepts a deal.
- [ ] As a deal is about to close, and on every other hand-off rule, the thread lands in Needs human with a worded reason, in-app and on Telegram.
- [ ] A manager can change the agent's prompts, rules, skills and models as a new profile version, test it in shadow and replay, promote it, and roll it back.
- [ ] Take over stops the agent. The kill switch stops all agent sends at once.
- [ ] A lost lease mid-send or mid-post never produces a duplicate.
- [ ] Search workers behave exactly as before.

## Out of scope

- Group chats and group invites (owner, 2026-11-07: answer in the ERP instead).
- Selling ERP inventory, and deal-to-PO automation.
- Reading seller photos: the inbox reader takes text only, and an image hands off.
- The `mautrix-meta` bridge.
- Selectors in the DB: the owner kept them in code, so a Facebook page change
  needs a worker release.
- Mobile pages, web push, purchaser access.
- Perceptual near-duplicate photo matching; uploads are deduped by exact file.

## Notes

- Live steps each need the owner's yes: the `main` release, the Telegram
  variable on Railway prod, the staged tracker image, and the one container
  recreate (one Facebook login) for the first seller account. The plan's
  WS-F lists them in order.
- F.live step 3 (v1.445.2): `FLEET_SELLER_MIN_WORKER_VERSION` is `0.18.0`, the
  tracker release that carries the seller kinds. The image is staged for new
  workers only, so the first seller is a fresh pool account whose new worker
  starts on it: one login, and no running worker replaced.
- The agent never sees the price ceiling. Offers come from code, from the
  Market page's max buy (`lib/market.ts`, `maxBuyFor`), and any reply carrying
  another dollar figure is refused.
- The agent tells a seller who asks that it is Recycle Servers' automated
  assistant and hands off. It never claims to be a person, the stance already
  written in `rs_coordinator/autoreply.py`.

- 2026-11-12: closed as won't do. The ERP side was removed in RS-581 (v1.454.0); the archive of its tables is in R2 at `recycle-db-backup/archive/fb-seller-archive-prod-20261112.sql.gz`.
