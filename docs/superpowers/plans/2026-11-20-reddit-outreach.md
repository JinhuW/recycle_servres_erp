# Reddit outreach after the API closes — implementation plan

**Date:** 2026-11-20 · **Ticket:** RS-602 · **Status:** A shipped in v1.473.0, B resolved by the redditapis.com webhook, C open

## Why

The owner wants purchasers to DM sellers from the swap subreddits
(r/homelabsales, r/hardwareswap) at scale. A review of Reddit's current
developer terms and API on 2026-11-20 found:

| Fact | Source |
| --- | --- |
| `POST /api/compose` (scope `privatemessages`; `to`, `subject`, `text`, `from_sr`) is still in the generated API docs. | reddit.com/dev/api |
| Using Reddit's services "by or on behalf of a business" needs Reddit's written approval. | Developer Terms §4.1, revised 2026-03-24 |
| The Data APIs must not be used "to spam, incentivize, or harass users". Commercial use needs a separate agreement. | Data API Terms §3, revised 2026-07-20 |
| New OAuth apps need manual approval (Responsible Builder Policy). New access requests closed 2026-10-31; unregistered apps lose access from 2027-01-12; public API access ends March 2027. | r/redditdev admin post of 2026-09-30, as reported by Unite.AI and PPC Land |
| Private messages became Reddit Chat (from March 2025); old PMs are a read-only archive. No official Chat API. | Reddit changelog, 2025-03-25 |
| Reddit withdrew logged-out RSS around 2026-11-16 (announced for 2026-11-13). `r/<sub>/new.rss` answers 404 for every subreddit; `.json` 403; `old.reddit.com` redirects to login; the HTML page is a `js_challenge` shell. | Probed 2026-11-20 and 2026-11-22 |
| Both swap subreddits expect a buyer to comment on a sale post before messaging the seller. | Seller posts and sub rules |

We hold no registered Reddit app. **Decision: the ERP never sends a Reddit
message itself.** A purchaser sends every message by hand from their own
account; the ERP writes the draft, enforces the guardrails, and keeps the
record. That is what RS-477 already does. This plan hardens it for volume.

## Workstream A: outreach guardrails in Leads ▸ Reddit (this PR)

### A1. Send through Reddit Chat

- `lib/redditLeads.ts`: `chatUrl(name)` → `https://chat.reddit.com/user/<name>`.
  Chat takes no pre-filled text, so the primary button copies the message
  and opens the chat. The old compose page stays as a secondary link,
  because it still pre-fills where Reddit keeps serving it.
- `LeadDrawer.tsx`: primary "Copy & open chat". The old message page and
  its subject field (chat has no subject) sit in a collapsed section under it.

### A2. A daily cap on first DMs per purchaser

- Shared constant `REDDIT_LEAD_DAILY_FIRST_DMS = 15`.
- A first DM is the caller's `dm` event on a seller they had not messaged
  before. The count is the caller's first DMs since local midnight
  (`REPORTING_TZ`), computed from `reddit_lead_events`, so it needs no new
  column, and a release followed by a re-claim can't reset it.
- Once the caller has hit the cap, `POST /:username/dm` for a seller they
  never messaged answers **429 `rlDailyCap`**. Follow-ups are not capped.
- `GET /api/leads/reddit` returns `firstDmsToday` and `firstDmCap`; the
  drawer shows "7 of 15 first messages today" and disables the send buttons
  at the cap.

Why: identical cold DMs in a burst are what Reddit's spam filter catches,
and a flagged account loses the trade history that makes sellers answer.

### A3. Do not contact

- New closing reason `optout` ("Asked not to be contacted") next to
  `nostock` and `lost`.
- Migration `0251_reddit_leads_opt_out.sql`: widen the `closed` and event
  `kind` CHECKs, and add `reddit_leads.opted_out_at TIMESTAMPTZ`.
- Closing as `optout` stamps `opted_out_at` and clears the follow-up.
  **Release and re-import never clear it.** A purchaser's claim answers **409
  `rlOptedOut`**, and so do `dm` and `stage` (a stage change would otherwise
  clear `closed`). The Pool and the Buyer network's Claim hide opted-out
  sellers.
- Only a manager can lift it: they may claim an opted-out seller, and their
  reopen clears the stamp and writes an `opt_in` event. A purchaser's reopen
  answers 403.

Why: today "Not interested" followed by Release puts the seller back in the
pool, and the next purchaser messages them again.

### A4. Comment first

When the lead has a `latestPostUrl`, the writer shows a step above the
draft: "Comment on their sale post first (sub rule)", linking the post.

### A5. Templates

- The first-contact templates (`bulk`, `item`) end with an opt-out line:
  "If you'd rather not hear from us, just say so and we won't message again."
- The chat flow pastes the body only.

### A6. Docs and release

- Ticket RS-602 (ask verbatim), `CHANGELOG.md`, `docs/FEATURES.md` (Leads ▸
  Reddit), `docs/DATABASE.md` (`reddit_leads.opted_out_at`, the new CHECK
  values, *As of* → 0251), and a minor version bump.
- Tests: `apps/backend/tests/reddit-leads.test.ts` covers the cap (15 pass,
  the 16th gets 429, a follow-up DM still passes) and opt-out (survives
  release, claim → 409, a purchaser's reopen → 403, a manager's reopen
  works). `apps/frontend/src/lib/redditLeads.test.ts` covers `chatUrl` and
  the opt-out line.

## Workstream B: the tracker's data source (resolved)

Reddit withdrew logged-out RSS around 2026-11-16, and every tracker poll
404'd. The owner chose option B1, a paid data provider: posts now arrive by
the [redditapis.com](https://www.redditapis.com) webhook (`poll_source =
webhook`, RS-600, #1232). See `trackers/reddit/README.md` *Post source* and
`trackers/reddit/docs/debug-notes/reddit-new-rss-404.md`.

The options that were weighed:

| Option | Cost | Risk |
| --- | --- | --- |
| **B1. Paid data provider** (chosen) | Monthly fee | Low for our accounts; rests on the vendor's own licence |
| B2. Logged-in browser on the fleet VMs | VM time; one Reddit account per IP | Reddit rule 8 / "scraping without an agreement"; accounts can be banned |
| B3. Data licence with Reddit | Unknown, likely high | None |
| B4. Pause the tracker | None | Alerts stop |

## Workstream C: `reddit_marketing` (not in this repo)

Its `docs/PLAN.md` step 5 sends DMs through `/api/compose`. That path is
closed to us for the same reasons, so its DECISIONS log should record that,
and its DM step should become a human-sent draft. It is a separate repo, so
it gets its own change.

## Order

1. A1–A5 code, then tests (backend integration + frontend unit), typecheck.
2. A6 docs, version bump, PR to `dev`, squash-merge (standing authorization).
3. B was settled separately (RS-600, #1232).
