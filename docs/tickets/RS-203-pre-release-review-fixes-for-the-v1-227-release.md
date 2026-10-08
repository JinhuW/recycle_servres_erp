---
id: RS-203
title: Pre-release review fixes for the v1.227 release
type: bug
status: in-progress
priority: P1
created: 2026-10-08
reporter: jinhu
branch: fix/prerelease-rs203
pr:
version:
related: [RS-200, RS-202, RS-197, RS-198, RS-167, RS-199]
---

## Ask

> /code-review high dev to prod, then deploy to prod

## Context

`/code-review high` of dev against main (v1.221.0 → v1.227.0, main 74177d42 vs
dev bc219f22) reported ten findings, none verified. Each was checked against the
code before anything was fixed. One is a defect:

| # | Finding | Verdict |
|---|---|---|
| 2 | The PO page's approve confirm (RS-200) reads `linkedPaid` as the page loaded it, but the same Save can link or unlink a bank payment: a PayPal txn id saved there is reconciled inside the PATCH, and a flip to Cash unlinks the old one. A $70 PO approved together with a newly typed id for a $2,415 payment went to Ready to Pay with no question; correcting a wrong id raised a false one | **Fixed** |
| 1 | Enter in the scan box ticks on a fragment of any length | Kept: RS-197 asked for "any position and length", and Enter ticks when the text names one part number |
| 9 | A 6+ prefix of one part that also sits inside another ticks the prefix match instead of reporting it ambiguous | Kept: RS-197 ranks "the 6+ prefix still comes first" above the ambiguity rule |
| 3 | `linkedPaidFrag` doesn't filter `currency = 'USD'` | Cannot happen: every link path is USD-only, and prod holds no other currency |
| 4 | The sell-order Done check reads sign-offs as the page loaded them | Low: the server's 409 is the gate, and only edits that don't void a sign-off can ride along with Done |
| 5 | Re-signing re-notifies the managers still missing | Low: a handful of managers, on a deliberate click |
| 6 | The sign-off fingerprint field list exists in SQL and in TypeScript | Not a defect: the server decides, the client copy only drives a hint |
| 7 | `/login/` with a trailing slash gets the 404 page | Nothing produces such a URL |
| 8 | Pack mode assumes a product's lots are adjacent and in one warehouse | Guaranteed by the server's numbering and line order |
| 10 | `sell_order_signoffs.user_id` cascades on a user delete | Nothing hard-deletes users, and older tables cascade the same way |

RS-202 (#547, v1.227.1) landed on dev during the review and was reviewed
separately before the release.

## Acceptance criteria

- [ ] On the desktop PO page, a manager's Save that edits the payment section
      (paid by, method or PayPal id) and approves (into Ready to Pay or Done)
      asks *Continue anyway?* against what the bank paid **after** the edit:
      a newly linked payment that doesn't match the total asks; a corrected id
      that now matches does not.
- [ ] Cancel there keeps the saved edits and leaves the stage where it was;
      the page reloads with the payment-mismatch banner, and the toast says
      when a payment was linked. Every other approve still asks before
      anything is written, and Cancel there writes nothing.
- [ ] dev is released to main, and prod health reports the new version.

## Out of scope

- The nine findings kept above.
- The phone PO page: it already makes a PayPal id be saved before Ready to
  Pay, and has no payment confirm (RS-200 left the phone out).

## Notes

- Plan: `~/.claude/plans/playful-fluttering-wozniak.md`, reviewed by a Plan
  subagent. The review caught that the detail route wraps the order
  (`{ order }`), and that a PayPal→Cash flip unlinks without touching the id
  field, so the gate is the whole payment section.
- An exception to RS-200's "Cancel writes nothing": the paid side of the
  question can only be known after the PATCH, so on this path the edits stand
  and only the move is dropped. The gap question also comes after the
  take-over question here.
