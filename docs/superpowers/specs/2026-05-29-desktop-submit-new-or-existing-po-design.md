# Desktop submit: create new PO vs. add to an existing PO

Date: 2026-05-29
Status: Approved (design)

## Problem

On desktop, clicking **Submit Order** in `DesktopSubmit.tsx` always finalizes a
brand-new purchase order. A purchaser who is still building up one logical PO
across several sittings has no way to append the lines they just entered to a PO
they already started — they end up with multiple small POs that must be merged
by hand later. The submit flow should let them choose, at submit time, between
creating a new PO and adding the current lines to an existing one.

## Scope

Frontend only.

- `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` — choice modal, eligible-
  target fetch, merge action.
- `apps/frontend/src/lib/i18n.tsx` — new EN + ZH keys.
- One small pure helper (`eligibleDraftTargets`) + a focused unit test.

No backend route, no migration, mobile flow unchanged. The required backend
endpoints already exist:

- `GET /api/orders?category={cat}&status=Draft` — lists the purchaser's own
  Draft POs (purchasers are scoped to their own; the row carries `user_id`,
  `warehouse_short`, `line_count`, `total_cost`, `created_at`).
- `PATCH /api/orders/:id { addLines }` — appends line rows to an order.
- `DELETE /api/orders/:id` — owner-only, Draft-only hard delete.

## Decisions (locked during brainstorming)

1. **Eligible merge targets:** the purchaser's *own* **Draft** POs of the **same
   category** as the current submit session, excluding the throwaway draft the
   form created on mount. (Not In-Transit POs, not other users' POs.)
2. **Order metadata on merge:** the target PO's warehouse / payment / notes are
   **inherited untouched** — the merge does not send those fields. The current
   form's meta selectors do not apply to a merge.
3. **Ask only when useful:** if there are zero eligible targets, clicking Submit
   behaves exactly as today (no modal). The modal appears only when at least one
   eligible target exists.

## Flow

`OrderForm` already creates a throwaway Draft on mount (`draftId`) and autosaves
confirmed lines to it.

### Eligible-target fetch

On mount (in parallel with the existing draft creation), fetch
`GET /api/orders?category={category}&status=Draft`. Filter the result with the
pure helper:

```
eligibleDraftTargets(orders, { category, meId, excludeId })
```

which returns rows where `category === category`, `user_id === meId`, and
`id !== excludeId` (the throwaway draft). `meId` is `useAuth().user?.id` (from
`lib/auth.tsx`, already the session user source on desktop); `excludeId` is
`draftId`. The result is held in component state (`targets`).

Re-run the filter once `draftId` resolves so the throwaway draft is excluded
even if the list returned before the draft id was known.

### Submit click

```
onClick Submit Order:
  if targets.length === 0:        -> existing behavior (dup check -> doSubmit)
  else:                           -> open choice modal
```

### Choice modal

- **Create new PO** (default / focused button): runs the existing dup-part check,
  then `doSubmit` (finalize the throwaway draft) — unchanged behavior.
- **Add to an existing PO**: reveals a compact selectable list of `targets`. Each
  row renders `PO-{id} · {warehouse} · {N} lines · {$total} · {created date}`.
  Selecting a row enables the confirm button; confirming runs the existing
  dup-part check on the local lines, then the merge action below.

The dup-part-number confirmation (`findDuplicatePartNumbers`) is preserved and
runs on the local lines in **both** paths before the final write.

### Merge action

Given a chosen `target`:

1. `PATCH /api/orders/{target.id}` with:
   - `addLines: lines.map(toWireLine)` — all local lines (confirmed lines were
     saved to the throwaway draft, not the target, so they must be re-added
     here).
   - `totalCost: target.total_cost + sum(local lines unitCost*qty)` — keeps the
     target's stored total consistent after the append. (If the target's total
     was a manual override, the new lines' auto-sum is added on top; acceptable
     edge case.)
   - **No** `warehouseId` / `payment` / `notes` — target meta inherited untouched.
2. `DELETE /api/orders/{draftId}` — remove the now-empty throwaway draft.
3. `onDone({ msg: t('subLinesAddedToPo', { id: target.id }), kind: 'success' })`.

On PATCH failure: surface via the existing `aiError` banner and do **not** delete
the throwaway draft (the user's work stays recoverable in it). On DELETE failure
after a successful PATCH: the merge already succeeded, so still call `onDone`
with success — a stray empty draft is harmless and the user's lines are safely on
the target. (Don't block the success path on best-effort cleanup.)

## Components / state additions in `OrderForm`

- `targets: OrderListRow[]` — eligible merge targets (filtered).
- `submitChoice: { open: boolean; selectedId: string | null } | null` — choice
  modal visibility + current selection. Reuses the existing `.modal-backdrop /
  .modal-shell` markup pattern already used by the dup-part modal.
- `doSubmitToExisting(target)` — the merge action.

The category-picker step and the per-line drawer are unchanged.

## Pure helper + test

`eligibleDraftTargets(orders, { category, meId, excludeId })` — pure, no I/O.
Lives next to the form (exported, like `findDuplicatePartNumbers`). Unit test
covers: same-category filtering, owner filtering, throwaway-draft exclusion, and
empty input.

## i18n keys (EN + ZH)

- `subSubmitChoiceTitle` — modal title (e.g. "Submit this order")
- `subSubmitChoiceSub` — modal subtitle
- `subChoiceNewPo` — "Create a new PO"
- `subChoiceNewPoSub` — helper line
- `subChoiceExistingPo` — "Add to an existing PO"
- `subChoiceExistingPoSub` — helper line
- `subChoicePickTarget` — picker section label / empty hint
- `subTargetRow` — row format with `{id} {warehouse} {n} {total} {date}` slots
  (or assembled from existing atoms if cleaner)
- `subLinesAddedToPo` — success toast with `{id}`

## Testing

- Unit: `eligibleDraftTargets` (new test file alongside the existing
  `*.test.ts` frontend tests).
- Manual: visit desktop submit with and without pre-existing same-category
  drafts; verify (a) no modal when none exist, (b) modal + create-new path,
  (c) modal + add-to-existing path leaves lines on the target and removes the
  throwaway draft, (d) dup-part check still fires in both paths.

## Out of scope

- Mobile submit flow.
- Adding to In-Transit / submitted POs.
- Merging against another user's PO (manager scope).
- Dedup of local lines against the *target's* existing lines.
