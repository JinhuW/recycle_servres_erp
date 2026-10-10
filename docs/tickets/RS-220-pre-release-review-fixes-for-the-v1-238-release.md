---
id: RS-220
title: Pre-release review fixes for the v1.238 release
type: bug
status: done
priority: P1
created: 2026-10-09
reporter: jinhu
branch: fix/prerelease-rs220
pr: 582
version: 1.238.1
related: [RS-209, RS-210, RS-213, RS-215, RS-217, RS-218]
---

## Ask

> /code-review high, dev to prod. release it after fixing all identified issue.

> clean up all stale worktree once you release to prod.

## Context

`/code-review high` ran over dev against main, which was v1.230.0 → v1.237.1 (RS-207 to RS-217 plus RS-215's
fixes). While the findings were being checked, RS-215's session released v1.237.1 to prod (#579) and RS-218
(#578, v1.238.0) reached dev. So these fixes ship in the next release, together with RS-218, which got its own
`/code-review high 578`.

Each finding was checked against the code. The one about data was also checked read-only against prod.

**dev against main (v1.230.0 → v1.237.1)**: seven findings:

| # | Finding | Verdict |
|---|---|---|
| 1 | `POST /api/orders` named a refused line by its part # or description and called `.trim()` on the value without a type check. A non-string `partNumber`, the very value just refused, threw. `partNumber: 123` came back as a 500 instead of a 400, and so did `lines: [null]` | **Fixed** |
| 3 | Inventory select-all: a lot that `/api/inventory/rows` no longer returns (sold, archived or emptied since the list loaded) stayed in the select-all set. The checkbox stuck at "some", every click re-fetched and added nothing, and it couldn't clear | **Fixed**: such a lot leaves the select-all set |
| 6 | A line whose brand turned Micron without its Chip # being resent kept the full marking (`8KE75 D9VPP`), not the die code (`VPP`). The inventory edit page sends only the fields that moved, and `PATCH /api/inventory/:id` never wrote `chip_number`, so a user could hit this there | **Fixed** on the inventory PATCH, with an audit event. Fixed on the PO PATCH too, so the two routes agree; the PO editors always resend the chip, so only a raw API call reached it there |
| 2 | Form/device pairs refuse an ECC SODIMM as Server and a workstation RDIMM as Desktop | Kept: Jinhu ruled on exactly these pairings in RS-217, "forget about these special case" |
| 4 | The sell-order PATCH deletes and re-inserts every line, so a line's # is recovered by row id, then lot, then text | Kept: the only client sends every line's row id, and the text key only serves a tab from before 0170. Updating rows in place is a refactor, not a release fix |
| 5 | 0171's `ON CONFLICT … SET active = TRUE` would re-enable a hidden SSD form | Kept: no effect on prod (checked 2026-10-09: `M.2 2230` active, `3.5"` absent), and 0171 is applied on dev, so it can't change |
| 7 | A sell-order save reads its lines about five times | Kept: one transaction over at most ~150 rows, which isn't measurable at prod's size |

**PR #578 (RS-218, held shipped products)**: ten findings:

| # | Finding | Verdict |
|---|---|---|
| 1 | The PO PATCH looked a line up by the id the client sent, against maps keyed by the lower-case ids the database returns. An upper-case id still matched its row in the UPDATE, but skipped the snapshot diff: no audit event, and no held-line refusal (a held lot's cost was rewritten with 200). The purchaser's back-to-Draft check reads the same map | **Fixed**: line ids and `removeLineIds` are lower-cased at the boundary |
| 2 | The inventory edit page locks qty and unit cost from `order_closed_book`, which ignores held lots, so it offered an edit the server always refuses | **Fixed**: `GET /api/inventory/:id` sends `line_held` (from `heldLines`), and the page locks on it with its own hint. The closed-book hint says "move it back to Reviewing", which is wrong advice for a PO already there |
| 3 | Review mode's `+`/`=`/`-` keys call `setCount`, which had no held check | **Fixed** |
| 4 | The Finish card counted and listed every absent line as about to be zeroed, while Approve skips held ones | **Fixed**: it lists what Approve zeroes, then the absent lines it leaves |
| 6 | `heldBackLineIds` ran on every move into Reviewing, forward ones included: it locked every line `FOR UPDATE` and ran a claims join that can find nothing | **Fixed**: only a PO coming back from a closed-book stage |
| 5 | A purchaser gets no `shippedOn`, so a held line looks editable to them and the save 409s | Kept: RS-218's acceptance criteria give `shippedOn` to managers only, after RS-107 (sell orders are a manager's). The 409 says the lot is on a shipped sell order |
| 7 | `heldLines` writes out the committed-claim join a third time | Kept: it is a claim filter with each line's sell orders, not the `SUM(sol.qty)` the one-implementation rule is about. The status set comes from the shared `committedSellStatuses()` |
| 8 | The detail GET reads held lines after the fan-out | Kept: the line ids come out of that fan-out. One query, for managers on a Reviewing PO only |
| 9 | Altitude: a per-line closed-book predicate instead of call-site checks | Kept: a refactor. The one writer that was missing (the inventory GET flag) now reads the same `heldLines` |
| 10 | The lock chip markup appears three times | Kept: three short call sites with no behaviour difference |

## Acceptance criteria

- [x] `POST /api/orders` with a non-string `partNumber` or `description`, or a `null` line, returns 400
      naming `new product n`, not 500.
- [x] When `/rows` drops a lot, Select all still ends at "all", and the next click clears it.
- [x] Changing only the brand to Micron, on the inventory edit page or through the PO PATCH, stores the die
      code. The inventory route logs a `chipNumber` event for it. A line with no chip stays without one.
- [x] An upper-case line id gets the same held-line refusal as a lower-case one.
- [x] The inventory edit page locks qty and unit cost on a held lot before any save.
- [x] In Review mode, the keys can't change a held line's count, and the Finish card's zero list matches what
      Approve zeroes.
- [x] A forward move into Reviewing doesn't lock the PO's lines.

## Out of scope

The kept findings above.

## Notes

Plan: `~/.claude/plans/expressive-wishing-newell.md`.
