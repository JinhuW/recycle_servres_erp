---
id: RS-477
title: Leads ▸ Reddit: a seller pool purchasers claim, DM and work to a deal
type: story
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: feat/leads-reddit
pr: 1022
version: 1.392.0
related: []
---

## Ask

> I would like to create a new page to share these information with purchasers and ask them to DM to these sellers.
> It should have a customer pool and each purchaser can claim the potential seller.
> Also add a check if they already contacted and a note for the resposne from the sellers.
> When purcahser claim a seller, it will show claimed.
>
> A new desktop nav side bar called Leads and a sub nav for reddits.

Follow-ups during design review:

> i more prefer this tab with title design
> The tab can help purchaser better manage the seller.

> user can see a tree view by select certain buyers. for example. i select frank. it will show all subnode he has trade before.
>
> enhance the UI UX for how to DM / manage the workflow to manage the clients

> You are an expertise in the Sale team management. Pls design the UIUX to better faceiliate the team to better manage the potential leads.

> My lead with replies should in a same tab. which is a part of sale lifecycle.

> purcahser does not need to care about the team data

> only manage need have the access of team data.

> Polish the UI and start the implement in the ERP system

## Context

Reddit's swap subreddits keep public trade records: u/LabB0T on r/homelabsales
and u/hwsbot on r/hardwareswap log every confirmed sale and buy. A one-off
harvest (2026-10-31) read 60 monthly confirmed-trade threads (~28.7k trades)
and joined them with the Reddit tracker's alerted sellers. That gave 2,174
sellers with at least one confirmed sale, plus the top 50 buyers and every
seller each one bought from. The owner wants purchasers to re-contact those
sellers for more inventory, without two people messaging the same seller.

Nothing in the ERP stores Reddit sellers today. The Reddit tracker has its own
database and only proxies through `/api/tracker/*` for managers. The page
reuses the Facebook fleet's layout (`DesktopCoordinator.tsx`): `page-head`,
`tabs fp-view-tabs` with count chips, and a `fleet-lede` per tab. The claim
mechanics follow the Facebook account pool (`routes/facebookPool.ts`):
`FOR NO KEY UPDATE`, 409 with a code, and an append-only event ledger.

The design was reviewed as a static preview before any code
(`http://10.10.100.225:8800/leads-reddit-preview.html`).

## Acceptance criteria

- [x] The sidebar has a **Leads** group with a **Reddit** sub-item for managers and purchasers, opening `#/leads/reddit`. Its badge counts my leads that need a first DM or a due follow-up.
- [x] **Pool** lists unclaimed sellers by confirmed sales with the deal record (`289 Sale | 4 Buy`), last deal, items sold lately and **Claim**. Claiming one someone else just took returns 409 `rlTakenElsewhere` and warns.
- [x] **My leads** holds every seller I claimed through the lifecycle Claimed → DM sent → Replied → Negotiating → Deal made, or closed as No stock now / Not interested. Urgent first: due follow-ups, then sellers waiting for a first DM. List and Board views.
- [x] The lead panel shows the stage bar and the next step. Its DM writer has templates and opens Reddit's compose page pre-filled; confirming "sent" marks the DM sent and sets a follow-up in 3 days. Replies are logged with text, follow-ups are set (quick picks or a date), and leads are closed, reopened and released. History lists every event with who and when.
- [x] **Buyer network**: pick a top buyer and see a tree of every seller they bought from, each with their trades (date, item, confirmation link), status, and Claim. Includes an "Only unclaimed" filter and "Claim the top 5 unclaimed".
- [x] Purchasers never see team data: for a seller someone else holds, the API returns only `claimed: true`, with no holder, stage, follow-up or history. **Team** (per-purchaser board: claimed, stale, follow-ups due, DM sent, replied, negotiating, deals, plus every claim with release) and **Import** are manager-only, in the UI and the API.
- [x] A manager **Import** loads the harvest (sellers, top buyers, trades). Re-importing updates counts and keeps claims, stages and history.
- [x] Every claim, release, DM, reply, stage change, follow-up, close, reopen and import goes to an append-only ledger.

## Out of scope

- Re-harvesting Reddit automatically. The harvest stays a script run by hand, and its CSV/JSON goes through Import.
- Sending DMs from the ERP. Reddit's compose page opens pre-filled; the purchaser presses Send there.
- A mobile view, and claim limits (owner: no limit).

## Notes

- Owner decisions: no claim limit. The pool starts with sellers that have a deal record. Notes and replies are visible only to the holder and managers.
- A stale claim is one more than 48 h old with no DM. Managers release stale claims from Team.
