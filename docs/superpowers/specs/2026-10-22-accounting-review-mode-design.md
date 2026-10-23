# Accounting review mode — design

**Ticket:** RS-350 · **Date:** 2026-10-22 ·
**Status:** built, v1.315.0 ·
**Mock:** [Accounting Review Mode canvas](https://claude.ai/artifact/9b32uvkTkhiE3gaeKGpira)
(five artboards: Review mode, the entry drawer, the book, the review states,
and the log)

## The ask

> Pls design an UI UX for review mode which for mangers to review all payments in the accouning page.
> Something that we can sign off by any other manager, can we can mark it as reviewed.

## The problem

The Accounting book (v1.310.0) is the managers' record of RMB that went
through their own hands. Each entry is written by one manager, and nobody else
ever has to look at it. Payments has a bank feed to reconcile against. The book
has none, so the only check it can have is a second person. The sell order
already works this way: it can't reach Done without the managers' sign-off
(v1.226.0). The book has nothing like that, and since RS-349 (v1.314.0) it
also holds about 41 entries that a migration wrote and no one has looked at.

## The shape this takes

- **One sign-off per entry, by any manager who didn't write it.** This is the
  four-eyes rule. The sell order asks *every* manager. With two managers that
  comes to the same thing; with three it would triple the work on a record
  that changes nothing else in the system.
- **Review mode is a page of its own**, `#/accounting/review`. It is
  full-width and has no sidebar, like the PO's Review mode (`DesktopBoxCheck`):
  - the same head: back, title, keys legend
  - the same two-half tally card with meters
  - the same list beside a sticky side panel
  - checked rows sink below a divider with Undo
  - the same keyboard: ↑↓ / j k, Space, `q`, `e`, `u`, Esc

  It is named *Review mode* (审核模式, the string `bcTitle` already uses).
- **The book carries the result.** Each row gets a reviewer's tick in a new
  last column, set off past the balance by a dashed rule, where a checker
  ticks a ledger. The identity band gets a *Reviewed* strip under *Held by*.
  A period whose strip reads all-reviewed is the period signed off, so there
  is no separate period sign-off to keep in step.
- **The log is the Activity page.** A *Log* button on the Accounting page and
  in Review mode opens Activity at `#/activity?area=acct`. Activity gains
  `accounting_entry_events` as a fifth ledger, so every recorded, changed,
  voided and reviewed entry sits in the one register the managers already
  use. A second log page would have to repeat its filters, paging and
  "can't be edited" guarantee.
- **Desktop only.** Like the PO's Review mode, nothing of this goes on the
  phone. The rules live in the API, so a phone edit still clears a review.

## Words

- **Author**: the person who wrote the version on the book. That is whoever
  recorded the entry, or whoever last changed a field the review covers
  (below). An entry the RS-349 backfill wrote has no author.
- **Reviewer**: the manager who signed off the current version.
- **Query**: a reviewer's question to the author when they can't sign it off.

## States

| Mark | State | zh | Means | Moves on by |
| --- | --- | --- | --- | --- |
| hollow ring | To review | 待审核 | Nobody has signed this version off. | *Mark reviewed* → Reviewed. *Query…* → Queried. |
| teal ✓ | Reviewed | 已审核 | One manager signed off this version. The tick names who and when. | An edit to a covered field → Changed. *Withdraw* (reviewer only) → To review. |
| amber ↻ | Changed since review | 审核后有改动 | Edited after it was signed off. The old review no longer counts. The change shows as was → now. | *Review again* by anyone but the editor → Reviewed. |
| blue ? | Queried | 有疑问 | A reviewer asked the author a question. | The author's *Answer* or a covered-field edit → To review. The asker's *Withdraw question* → To review. *Mark reviewed* also closes it. |
| dashed ring | Waiting on ‹name› | 等待他人审核 | To review, as the entry's own author sees it. | Another manager's review. |

A voided entry has no review state. It leaves the queue, and its review
history stays in its history.

## Rules

1. **Who can review.** Any active manager except the author. The real role
   counts, like the other 403s: a manager previewing as purchaser gets no
   Review mode. The entry's manager (whose money it was) *can* review an
   entry someone else wrote in their name; that's them confirming it.
2. **What a review covers.** Every field except the note: direction, kind,
   record, amount, currency, rate, method, date, manager, counterparty and
   reference. The note explains the entry and changes nothing on it, the same
   reasoning that keeps notes from voiding a sell-order sign-off.
3. **An edit to a covered field clears the review.** The state goes to
   Changed since review, the editor becomes the author, and the history line
   says the review was cleared. A note-only edit leaves the review and the
   author alone.
4. **Void and restore.** A void takes the entry out of review. A restore
   brings it back To review, because the restore is a decision of its own.
5. **Withdraw.** Only the reviewer, and only while the entry is still reviewed.
6. **Query.** It needs a question of up to 280 characters, and the author is
   notified.
   - A queried entry leaves the reviewer's *For you* list and sits under
     *Queried*.
   - The author's answer (text) or a covered-field edit puts it back To
     review, and the question and answer stay visible to the next reviewer.
   - An entry with no author (a backfilled one) puts its question to the
     manager whose money it was. A manager can't put a question to
     themselves; the API tells them to edit the entry instead.
   - An edit that answers a question leaves it on the entry, marked as
     answered by that edit.
7. **A stale page can't sign off something else.** The review POST carries
   the `version` the page showed (`updated_at` as text, exact to the
   microsecond). If the entry changed since, it answers 409 with
   `code: 'changed'` and the page re-reads it. This is the sell order's
   fingerprint rule. A sign-off, a question and an answer leave `updated_at`
   alone: they say something about the entry without making a new version.
8. **Bulk.** *Mark n reviewed* covers only To review entries that have no
   warning. A confirm dialog lists each entry and the total. The server
   re-checks every entry and returns the ones it skipped, with the reason.
9. **Entries already on the book** all start To review. Each one recorded by
   hand takes its recorder (`created_by`) as author. Backfilled ones have no
   author, so any manager reviews them. They are booked from the record's own
   figure, so they pass the record check and qualify for the bulk sign-off.
10. **One active manager.** Nobody can review. The strip reads *Needs a second
    manager* and Review mode says why.

## Checks

These are hints for the reviewer, shown on each row and in the side panel.
They never block a sign-off; they only keep an entry out of the bulk one.

- **Against the record.** What the book has against the record, compared with
  the record's own figure. Both already exist: `targetFacts` and
  `recordedFrag` in `routes/accounting.ts`. Within 1% or ¥10 reads
  *Matches the record*. Anything else reads *¥n over* or *¥n short*.
- **Rate.** On a dollar entry, the rate it was booked at compared with the FX
  ledger's rate for its date. More than 2% apart warns.
- **Possible duplicate.** Another live entry with the same direction, amount,
  method and record (or the same counterparty when there is no record), within
  7 days.
- **No record.** An *Other* entry has nothing to compare.

The thresholds are constants in `packages/shared/src/accounting.ts`, so the
row chip and the server's bulk re-check agree.

## Surfaces

### Review mode (desktop, artboard *Review mode*)

- **Head.** *Back to Accounting*, *Review mode*, *Reviewing as ‹you›*,
  *Log*, and the keys legend.
- **Tally.** The left half counts entries: *n / m entries reviewed*, with a
  meter and legend chips (Reviewed · Changed · Queried · To review). The
  right half weighs money: *¥ reviewed of ¥ in the queue*, with *Left to
  review: received ¥… · paid ¥…*, and the bulk button. Weighting by money
  matters: one ¥86,400 receipt carries more risk than ten small fees.
- **Tabs.** *For you* · *Queried* · *Waiting on others* · *Reviewed* (last 30
  days), plus a manager filter. Review mode is not scoped by the book's
  period: a backlog must not hide behind *This month*. The list runs oldest
  first, grouped by day.
- **Row.** The mark button (a click marks it reviewed), the date (once a
  day), the entry id with *by ‹author›*, *For* (kind, record link,
  counterparty, then method and note), Received / Paid in the book's own
  columns, and a check chip. A row reviewed in this visit sinks below
  *Reviewed in this visit* with Undo.
- **Side panel.**
  - The entry: hero, facts, and who recorded or changed it.
  - *Checks*.
  - *Changed since ‹name› reviewed it*, as was → now, when changed.
  - *Question*, when queried.
  - The actions: *Open entry*, *Query…*, and *Mark reviewed* (*Review
    again* on a changed entry). On your own entry these give way to *You
    recorded this. ‹name› reviews it.*
- A toast with Undo after every action.

### The book (artboard *The book*)

- The page head reads *Log* · *Review mode* (with the count for you) ·
  *Record entry*.
- The **Reviewed strip** in the band: a meter, *n of m entries*, *¥ reviewed
  of ¥ moved*, *n for you · n queried · n waiting on ‹name›*, and *Open review
  mode →*. It follows the band's scope (period and manager).
- A **Review** filter: Any · To review · Changed since review · Queried ·
  Reviewed.
- The **Review** column, past Balance. A reviewed tick carries the
  reviewer's first name, and its tooltip gives the full name and time.
- The sidebar's Accounting item shows a count badge of entries waiting on
  you.

### The entry drawer (artboard *Entry drawer*)

- A **Review** card between the facts and History, shaped like the sell
  order's Sign-off card with one signer. It shows the state, who and when,
  the change or the question, and the viewer's own action: *Mark reviewed*,
  *Query…*, *Withdraw*, *Answer…* or *Withdraw question*. The tweak on the
  artboard walks through each state.
- New history lines: *marked it reviewed*, *withdrew their review*,
  *changed ‹fields›: review cleared*, *asked a question*, *answered*,
  *withdrew their question*.

### The log (artboard *Log*)

- *Log* opens Activity with the **Accounting** area picked. Accounting is a
  sixth pill after Pricing, with its own stripe: book ink,
  `oklch(0.4 0.03 250)`, darker than the other four so it differs in
  lightness as well as hue. Activity now reads its area from the URL, so the
  link lands filtered, and *Clear filters* still widens it to everything.
- Each row is one `accounting_entry_events` row:
  - *Record* is the entry id, and *Open entry* opens `#/accounting/AC-n`.
  - *Person* is the actor. Backfilled entries read *Not attributed*, with
    *Backfilled from the PO's Paid by* in the change lane.
  - *Change* shows the diff (*Amount ¥1,800.00 → ¥1,880.00 · Sofia Reyes's
    review cleared*), the question's text, or *Marked reviewed · signed off
    ¥n*.
- The kinds map onto the shared action vocabulary, which gains **Reviewed**
  and **Query**:

  | kind | action |
  | --- | --- |
  | `created` | Created |
  | `edited`, `unlinked` | Edited |
  | `voided`, `restored` | Status |
  | `reviewed`, `unreviewed` | Reviewed |
  | `queried`, `answered`, `query_withdrawn` | Query |

- Search matches the entry id, the record it names, its counterparty and
  the question text.
- The subtitle names accounting with the other areas, and the legend gets
  its fifth swatch.

### Notifications

- A query notifies the author. An answer notifies whoever asked.
- Recording an entry notifies nobody, since that would be noise. The sidebar
  count carries the waiting work instead.

## Data model

Migration `0197_accounting_review.sql`. As built, it also has
`answer_by` / `answer_text` / `answer_at` beside the `query_*` columns, so a
question and its answer stay on the entry until the next sign-off. It has
one-sided checks that survive a reviewer's SET NULL, and an index on each
new FK. The sketch it started from:

```sql
ALTER TABLE accounting_entries
  -- Whose version is on the book: the recorder, then whoever last changed a
  -- field the review covers. NULL for the RS-349 backfill.
  ADD COLUMN author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  -- Set when an edit clears a review; it is what "Changed since review" reads.
  ADD COLUMN review_cleared_at TIMESTAMPTZ,
  ADD COLUMN query_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN query_text TEXT,
  ADD COLUMN query_at TIMESTAMPTZ;
UPDATE accounting_entries SET author_id = created_by;
-- events.kind gains 'reviewed', 'unreviewed', 'queried', 'answered', 'query_withdrawn'.
CREATE INDEX accounting_entries_review_queue_idx
  ON accounting_entries (occurred_on, created_at, id)
  WHERE voided_at IS NULL AND reviewed_at IS NULL;
-- A sign-off is only worth its record. The other four ledgers are append-only
-- by trigger (0012, 0037, 0050, cascade-tolerant since 0038); this one wasn't,
-- and Activity says "Entries can't be edited or deleted" of every row it shows.
CREATE FUNCTION accounting_entry_events_lock() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'accounting_entry_events is append-only — UPDATE/DELETE not allowed';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER accounting_entry_events_no_update BEFORE UPDATE ON accounting_entry_events
  FOR EACH ROW EXECUTE FUNCTION accounting_entry_events_lock();
CREATE TRIGGER accounting_entry_events_no_delete BEFORE DELETE ON accounting_entry_events
  FOR EACH ROW EXECUTE FUNCTION accounting_entry_events_lock();
-- Activity's keyset walk, as 0079 gives the other ledgers.
CREATE INDEX accounting_entry_events_feed_idx ON accounting_entry_events (created_at DESC, id DESC);
```

The state is derived, in this order: voided → none; `reviewed_at` →
Reviewed; `query_at` without `answer_at` → Queried; `review_cleared_at` →
Changed since review; otherwise To review. A review clears `query_*` and `review_cleared_at`. A
covered-field edit clears `reviewed_*` and `query_*` and stamps
`review_cleared_at` only if a review existed.

## API

All of it sits behind `requireManager`, and the reviewer rules check the real
role.

- `GET /api/accounting/review?tab=mine|queried|others|reviewed&managerId=`
  returns the rows (the entry shape plus `review` and `checks`) and the
  count for each tab.
- `POST /api/accounting/entries/:id/review` `{ version }` answers:
  - 403 for the author
  - 409 when the page is stale (`code: 'changed'`), the entry is voided or
    it is already reviewed
  - `DELETE` on the same path withdraws (the reviewer only)
- `POST /api/accounting/entries/:id/query` `{ text }`, and `DELETE` to
  withdraw (the asker only). `POST /api/accounting/entries/:id/answer`
  `{ text }` is for the author only (the manager, where there is no author).
- `POST /api/accounting/review/bulk` `{ entries: [{ id, version }] }`
  returns `{ reviewed: [id], skipped: [{ id, reason }] }`.
- `GET /api/accounting/summary` gains a `review` block: entries, reviewed,
  moved ¥, reviewed ¥, for you, queried, and waiting on others. It follows
  the band's scope.
- `GET /api/accounting/entries` rows gain `review: { state, by, at }`, and the
  endpoint takes a `review=` filter.
- `GET /api/accounting/review/count` returns `{ forMe, asked }` for the
  sidebar badge. It is fetched on shell load and after any write to the book.
- `GET /api/activity` adds a fifth branch to its union,
  `accounting_entry_events` joined to its entry, as `area: 'acct'`.
  `ACTIVITY_AREAS` gains `acct`, `ACTIVITY_ACTIONS` gains `reviewed` and
  `queried`, and `ACTIVITY_KIND_MAP.acct` holds the mapping above. The
  route is already manager-only on the real role. `activityRecordHref('acct',
  id)` returns `#/accounting/<id>`.

## Strings

| Key idea | en | zh |
| --- | --- | --- |
| page | Review mode | 审核模式 |
| tab | For you · Queried · Waiting on others · Reviewed | 待我审核 · 有疑问 · 等待他人 · 已审核 |
| action | Mark reviewed · Review again · Withdraw | 标记为已审核 · 重新审核 · 撤回 |
| action | Query… · Send question · Answer… · Withdraw question | 提问… · 发送问题 · 回答… · 撤回问题 |
| own entry | You recorded this. ‹name› reviews it. | 这笔由你记录，需由‹name›审核。 |
| changed | Changed since ‹name› reviewed it | ‹name›审核后有改动 |
| strip | Reviewed · n of m entries · n for you | 已审核 · m 笔中 n 笔 · 待我审核 n 笔 |
| bulk | Mark n reviewed · Only entries with no warning | 标记 n 笔为已审核 · 仅限无警示的条目 |
| button | Log | 操作记录 |
| Activity area / actions | Accounting · Reviewed · Query | 账务 · 审核 · 提问 |

## Acceptance criteria

- [ ] `#/accounting/review` opens Review mode for a manager; a purchaser, or a
      manager previewing as one, is bounced.
- [ ] *For you* lists every live entry the viewer didn't write that is To
      review or Changed since review, oldest first; the viewer's own entries
      are under *Waiting on others* and offer no sign-off.
- [ ] Mark reviewed (button, the row's mark, or Space) records the viewer and
      time, moves the row below *Reviewed in this visit* with Undo, and
      selects the next entry.
- [ ] The API refuses a review by the entry's author (403) and one sent for a
      version that has since changed (409).
- [ ] Editing any field but the note on a reviewed entry clears the review;
      the entry reads Changed since review with was → now, and its editor
      can't review it.
- [ ] Editing only the note keeps the review.
- [ ] Query needs text, notifies the author and moves the entry to *Queried*;
      the author's answer or edit returns it to review with the question kept.
- [ ] Each row and the side panel show the record, rate and duplicate checks;
      *Mark n reviewed* signs off only To review entries without a warning,
      after a confirm that lists them.
- [ ] The book shows a Review column and filter, and the band a Reviewed strip
      for its scope; the header's Review mode button and the sidebar badge
      show the count for you.
- [ ] The entry drawer carries the Review card, and its history logs every
      review, withdrawal, clear, question and answer.
- [ ] *Log* on the Accounting page and in Review mode opens Activity with the
      Accounting area picked; its rows are the book's history (recorded,
      edited, voided, restored, reviewed, queried, answered, backfilled), each
      opening its entry.
- [ ] Activity's action filter offers Reviewed and Query, and its search
      finds an entry by id, record or counterparty.
- [ ] `accounting_entry_events` refuses UPDATE and a direct DELETE.
- [ ] Every string has its zh translation.

## Out of scope

- **The phone.** No Review screen, no ticks and no log button there. Review
  is a desk job, like the PO's Review mode.
- **A log page of Accounting's own.** Activity is the log; see *The log*.
- **Locking a reviewed entry or period.** Edits stay allowed; they reopen the
  review, which is the record of it.
- **Every manager signing.** One other manager is the control asked for.
- **Receipts on an entry.** An upload box for the proof would help a reviewer
  most of all. It is its own ticket, since the book has no attachments today.
- **Bank Payments rows.** They have their own reconciliation.
- **Reviewing a void.** A voided entry leaves review.

## Decisions to confirm

These were decided in the design so it could go ahead without a meeting. Each
one can flip without reshaping the rest.

1. One other manager signs, not all of them.
2. Query is in. Without it a reviewer who disagrees has nowhere to go but an
   edit of someone else's money.
3. Bulk sign-off is in, behind its guard. It is mainly for the ~41 backfilled
   entries.
4. Backfilled entries start To review, rather than being treated as already
   reviewed.

## Ticket draft

```markdown
---
id: RS-nnn
title: Accounting review mode: another manager signs off each entry
type: story
status: backlog
priority: P2
---
## Ask
> Pls design an UI UX for review mode which for mangers to review all payments in the accouning page.
> Something that we can sign off by any other manager, can we can mark it as reviewed.

## Context
The Accounting book (v1.310.0, routes/accounting.ts, DesktopAccounting.tsx)
is written by one manager per entry and checked by nobody. The sell order
already needs the managers' sign-off before Done (v1.226.0); RS-349
(v1.314.0) added ~41 backfilled entries nobody has looked at. Design:
docs/superpowers/specs/2026-10-22-accounting-review-mode-design.md.

## Acceptance criteria
(as in the spec)

## Out of scope
(as in the spec)
```
