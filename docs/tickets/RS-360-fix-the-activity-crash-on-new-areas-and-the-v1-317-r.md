---
id: RS-360
title: Fix the Activity crash on new areas and the v1.317 review cleanups
type: task
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/polyp
pr: 839
version: 1.318.1
related: [RS-350, RS-353, RS-355, RS-358, RS-359, RS-362]
---

## Ask

> fix them :
> - Activity crash: browser tabs opened before v1.317 could crash on an Accounting row in Activity. That stopped once the release was out, so there was nothing to fix.
> - Code cleanups: the review's refactoring suggestions are left for later, since correctness came first.
>
> Then merge to prod.

## Context

RS-359 left two things out of scope from the `/code-review max` of the v1.317
release:

- **The Activity crash.** v1.317 added the `acct` area to the feed. A tab
  still running an older bundle got those rows, and opening one ran
  `AREAS.find(…)!.tKey` on an area it didn't know, which threw. That release
  is past, but the page still works the same way. The next area a release
  adds will crash every tab left open on today's bundle, because the server
  sends every area to a caller that can't draw them.
- **The cleanups.** Five of the review's finders (reuse, simplification,
  altitude, efficiency, conventions) listed about thirty items. RS-358 and
  RS-359 fixed the ones that were also bugs. The rest are the same rule
  written in two or more places (TS and SQL, client and server, page and
  page), work done and thrown away, dead code, and pure helpers without
  tests.

## Acceptance criteria

Activity:

- [x] **A tab only gets the areas it can draw.** `GET /api/activity` takes
      `areas`, the areas the caller knows, and leaves every other area out of
      the rows and the counts. The desktop page sends its list. An area added
      later never reaches a tab running this bundle.
- [x] **No row can crash the detail panel.** The area label is read from a
      table, with no non-null assertion.
- [x] **Accounting rows read as the drawer reads them.** The *who* column of
      a row the PO moved or the backfill wrote says so (*Paid by followed the
      PO*, *brought in line with the PO*), from the same rule as the entry's
      history. Names in an Accounting diff include deactivated members.

Review rules in one place:

- [x] **The review state is worked out once, in SQL.** The TS copy is gone.
      `/summary`, `/review/count` and the queue tabs share one predicate per
      tab, and the open tabs say `reviewed_at IS NULL` so 0197's partial
      index can serve them.
- [x] **One rule decides what the viewer may do, on both sides.** Who may
      sign off, withdraw, ask, answer or withdraw a question is one function
      in `packages/shared`. The API's guards refuse with it and the pages
      offer buttons with it.
- [x] **One refusal shape.** The five review routes share a wrapper (lock,
      404, refusal, ok), and clearing a question is one SQL fragment.
- [x] **"Changed since review" is worked out once, on the server.**
      `GET /entries/:id` returns the same `cleared` block as Review mode rows
      (who signed, what changed, whether the PO moved it). The drawer reads
      it, and the client's re-fold is gone. The fold itself sits in
      `packages/shared`, unit-tested.
- [x] **Bulk sign-off is two statements.** One UPDATE and one INSERT sign
      the whole batch, the same path as a single sign-off. Review facts are
      read only for the entries that can be signed.
- [x] **Review rows carry what pages read.** The unread `facts` and the
      duplicate `target` go.

SQL and money rules:

- [x] **A commission the Business Account paid is one SQL function**, which
      both the payer-sync trigger and the routes call (0203).
- [x] **The rate for a day is one helper** in `lib/fx.ts`, backed by an
      index on `effective_date`. The duplicate check is a range the book's
      date index can serve.
- [x] **PO PATCH asks "does this change the payer?" once.** The closed-book
      freeze and the material-field check both compare what `paidByAfter`
      will write.
- [x] **The dev scrub nulls every sealed column it finds**, so a new
      `*_enc` column on any table is cleared without a hand edit, and the
      test checks the whole schema.

Members and payers:

- [x] **Pickers read `/api/members/names`, never `/api/members`.** The
      names list takes `includeInactive` (managers only) and carries
      `active`. `useManagerOptions`, `useMemberNames` and a new `useMembers`
      read it through one module-level cache. The four hand-written fetches
      (hand-off, PO pages, Submit) and Activity use the hooks.
- [x] **One builder for the Paid by options.** The entry form uses
      `payerChoices`, like the PO pages.
- [x] **The PO pages share one payer helper** for whether the payer changed,
      who the cost is reimbursed to, and its label.
- [x] **The sidebar and the RMB Flow page share one review-count request.**

Pages:

- [x] **Review mode does less work per key.** Formatters are cached per
      locale, the key handler is registered once, *For you* isn't re-read on
      a tab switch, the counts come from one request, and the row lists are
      worked out once per change.
- [x] **Desktop-only Review UI lives under `pages/desktop/`** (`ReviewMark`).
- [x] **`t()` knows a count of one.** With `n: 1` it reads `<key>One` when
      that key exists, and the hand-written `n === 1 ?` ternaries for `…One`
      keys go.
- [x] **WeChat's search finds every term anywhere**, highlighted, as the
      Facebook and Reddit pages do, and its view tabs are links that keep the
      view in the URL.
- [x] **The Orders list sorts the Payment column by what it shows**, the
      payer's name.

Dead code:

- [x] Unused keys (`payCompany`, `payCompanyShort`, `acctTickNext`) and the
      Undo keys that repeat `undo` are gone. `PAY_BUSINESS` uses
      `BUSINESS_ACCOUNT`. Exports nothing imports are gone. The Review-mode
      meter reuses `.bc-meter`. `activityRecordHref` uses
      `accountingEntryPath`. `nameHandoffByChange` is named for what it does
      now.

## Out of scope

- **One `BEFORE UPDATE` trigger for "a covered field clears the sign-off"**
  (altitude). It would redesign how every writer versions an entry. 0202
  already covers the failures the review named, so it is a redesign, not a
  cleanup.
- **Which wins when a guessed PO payer meets a booked entry** (altitude). That
  is a product rule, not a duplicate, and the review itself filed the 0199
  catch-up as intended.
- **Review mode applying a sign-off locally instead of re-reading.** It needs
  a local copy of the server's queue and counts, which is the kind of client
  copy the done-row finding warns about. The re-read stays, made cheaper as
  above.
- **The restorer signing off their own restore.** That is still a product
  decision.

## Notes

- Mostly internal, so the version is a patch. RS-361 took 1.317.5 and RS-362
  1.318.0 while this was built, so it ships as 1.318.1. The WeChat search
  and tabs were merged onto RS-362's rework of the same board: the new
  brand and DDR columns highlight the search terms too.
- `t()` picks `<key>One` only by `n`. `acctStripEntries`'s singular turns on
  the total, so it is `acctStripEntriesOfOne` and stays a ternary. Keys named
  `…Many` (`historyLineCountMany`, `bcRemainingMany`) keep theirs.
- Warehouses settings keeps `/api/members`: it shows the manager's phone and
  email, which the names list doesn't carry.
- The PO-page, Orders, WeChat and PO PATCH items were built by a parallel
  agent with a fixed file list, then reviewed here.
- Verified on a private clone of the local DB, with 0196–0203 applied. A
  scripted browser run passed every check: the Activity areas and an
  Accounting row, the drawer's *Changed since review*, Review mode's
  one-tab read and *1 entry* wording, one count request, the strip meter,
  WeChat search and `?view=groups`, and the PO Paid by list.
