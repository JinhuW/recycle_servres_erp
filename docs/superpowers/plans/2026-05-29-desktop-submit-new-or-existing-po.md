# Desktop submit: new PO vs. add to existing PO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a desktop purchaser, on clicking Submit Order, choose between creating a new PO (today's behavior) and appending the current lines to one of their existing same-category Draft POs.

**Architecture:** Frontend-only. `OrderForm` (in `DesktopSubmit.tsx`) fetches the purchaser's other eligible Draft POs on mount. If any exist, Submit opens a choice modal; "add to existing" appends all local lines to the chosen draft via `PATCH /api/orders/:id {addLines}`, then deletes the throwaway draft. Target meta (warehouse/payment/notes) is inherited untouched. Eligibility filtering is extracted into a pure, unit-tested module.

**Tech Stack:** React + TypeScript (Vite), `lib/api.ts` (CSRF-aware fetch), `lib/i18n.tsx`, vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-05-29-desktop-submit-new-or-existing-po-design.md`

---

## File Structure

- **Create** `apps/frontend/src/pages/desktop/submit/eligibleTargets.ts` — pure helper `eligibleDraftTargets`. Standalone module (mirrors the `pages/desktop/marketStaleness.ts` pure-helper pattern) so the test doesn't import the React component.
- **Create** `apps/frontend/src/pages/desktop/submit/eligibleTargets.test.ts` — unit test for the helper.
- **Modify** `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` — target fetch, choice modal, merge action.
- **Modify** `apps/frontend/src/lib/i18n.tsx` — new EN + ZH keys.

---

## Task 1: Pure eligibility helper + test

**Files:**
- Create: `apps/frontend/src/pages/desktop/submit/eligibleTargets.ts`
- Test: `apps/frontend/src/pages/desktop/submit/eligibleTargets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/pages/desktop/submit/eligibleTargets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eligibleDraftTargets } from './eligibleTargets';
import type { OrderSummary } from '../../../lib/types';

const base: OrderSummary = {
  id: 'PO-1', userId: 'me', userName: 'Me', userInitials: 'ME',
  commissionRate: null, category: 'RAM', payment: 'company', notes: null,
  lifecycle: 'draft', archivedAt: null, createdAt: '2026-05-29T00:00:00Z',
  totalCost: 100, warehouse: null, qty: 0, revenue: 0, profit: 0,
  lineCount: 2, status: 'Draft',
};
const mk = (over: Partial<OrderSummary>): OrderSummary => ({ ...base, ...over });

describe('eligibleDraftTargets', () => {
  const opts = { category: 'RAM' as const, meId: 'me', excludeId: 'PO-current' };

  it('returns own same-category drafts, excluding the throwaway draft', () => {
    const orders = [
      mk({ id: 'PO-1' }),
      mk({ id: 'PO-current' }),               // the throwaway draft — excluded
      mk({ id: 'PO-2' }),
    ];
    expect(eligibleDraftTargets(orders, opts).map(o => o.id)).toEqual(['PO-1', 'PO-2']);
  });

  it('excludes other users, other categories, and non-draft lifecycles', () => {
    const orders = [
      mk({ id: 'OTHER-USER', userId: 'someone' }),
      mk({ id: 'WRONG-CAT', category: 'SSD' }),
      mk({ id: 'IN-TRANSIT', lifecycle: 'in_transit' }),
      mk({ id: 'KEEP' }),
    ];
    expect(eligibleDraftTargets(orders, opts).map(o => o.id)).toEqual(['KEEP']);
  });

  it('returns [] for empty input', () => {
    expect(eligibleDraftTargets([], opts)).toEqual([]);
  });

  it('returns [] when meId is undefined', () => {
    expect(eligibleDraftTargets([mk({})], { ...opts, meId: undefined })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/frontend && npx vitest run src/pages/desktop/submit/eligibleTargets.test.ts`
Expected: FAIL — cannot resolve `./eligibleTargets` / `eligibleDraftTargets is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/frontend/src/pages/desktop/submit/eligibleTargets.ts`:

```ts
import type { Category, OrderSummary } from '../../../lib/types';

// Draft POs the current purchaser may append the in-progress submit lines to:
// their own, same category, and never the throwaway draft this submit session
// created on mount (passed as excludeId).
export function eligibleDraftTargets(
  orders: ReadonlyArray<OrderSummary>,
  opts: { category: Category; meId: string | undefined; excludeId: string | null },
): OrderSummary[] {
  const { category, meId, excludeId } = opts;
  if (!meId) return [];
  return orders.filter(o =>
    o.lifecycle === 'draft' &&
    o.category === category &&
    o.userId === meId &&
    o.id !== excludeId,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/frontend && npx vitest run src/pages/desktop/submit/eligibleTargets.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/submit/eligibleTargets.ts apps/frontend/src/pages/desktop/submit/eligibleTargets.test.ts
git commit -m "feat(submit): pure eligibleDraftTargets helper for merge-target filtering

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: i18n keys (EN + ZH)

**Files:**
- Modify: `apps/frontend/src/lib/i18n.tsx`

- [ ] **Step 1: Add EN keys**

In the EN dictionary, immediately after the `subSubmitFailed: 'Submit failed',` line (currently `lib/i18n.tsx:889`), insert:

```ts
    subSubmitChoiceTitle: 'Submit this order',
    subSubmitChoiceSub: 'Create a new PO, or add these lines to a draft you already started.',
    subChoiceNewPo: 'Create a new PO',
    subChoiceNewPoSub: 'Submit these lines as a brand-new purchase order.',
    subChoiceExistingPo: 'Add to an existing draft PO',
    subChoiceExistingPoSub: 'Append these lines to a {cat} draft you already started.',
    subChoicePickTarget: 'Pick a draft to add to',
    subTargetMeta: '{n} lines · {cost}',
    subLinesAddedToPo: 'Lines added to {id}',
```

- [ ] **Step 2: Add ZH keys**

In the ZH dictionary, immediately after the `subSubmitFailed: '提交失败',` line (currently `lib/i18n.tsx:1933`), insert:

```ts
    subSubmitChoiceTitle: '提交此订单',
    subSubmitChoiceSub: '创建新采购单，或将这些明细加入你已开始的草稿。',
    subChoiceNewPo: '创建新采购单',
    subChoiceNewPoSub: '将这些明细作为全新采购单提交。',
    subChoiceExistingPo: '加入已有草稿采购单',
    subChoiceExistingPoSub: '将这些明细追加到你已开始的 {cat} 草稿中。',
    subChoicePickTarget: '选择要加入的草稿',
    subTargetMeta: '{n} 项明细 · {cost}',
    subLinesAddedToPo: '明细已加入 {id}',
```

- [ ] **Step 3: Verify typecheck (key parity)**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: PASS. (The i18n dicts are typed; a key present in one language but not the other would error here.)

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/i18n.tsx
git commit -m "i18n(submit): keys for new-vs-existing PO submit choice (EN+ZH)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Choice modal + target fetch + merge action

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSubmit.tsx`

All edits are inside the `OrderForm` function and its imports.

- [ ] **Step 1: Add imports**

At the top of `DesktopSubmit.tsx`, extend the existing imports.

Change the format import (currently `import { fmtUSD } from '../../lib/format';`) to:

```ts
import { fmtUSD, fmtDateShort } from '../../lib/format';
```

Add after the `import { LineDrawer } from './submit/LineDrawer';` line:

```ts
import { eligibleDraftTargets } from './submit/eligibleTargets';
import { useAuth } from '../../lib/auth';
import type { OrderSummary } from '../../lib/types';
```

Also extend the existing api import. Change `import { api, createDraftOrder } from '../../lib/api';` to:

```ts
import { api, createDraftOrder, deleteOrder } from '../../lib/api';
```

- [ ] **Step 2: Add target-fetch state and effect**

Inside `OrderForm`, just after the existing `const { t, lang } = useT();` line, add:

```ts
  const { user } = useAuth();
```

Then, immediately after the `draftId` creation effect (the `useEffect` that calls `createDraftOrder(category)`, ending around `}, [category]);`), add:

```ts
  // Existing same-category Draft POs the user can append to instead of creating
  // a fresh PO. Fetched once; re-filtered when draftId resolves so the throwaway
  // draft this form just created never appears as its own merge target.
  const [allDrafts, setAllDrafts] = useState<OrderSummary[]>([]);
  useEffect(() => {
    let alive = true;
    api.get<{ orders: OrderSummary[] }>(`/api/orders?category=${category}&status=Draft`)
      .then(r => { if (alive) setAllDrafts(r.orders); })
      .catch(() => { /* non-fatal: just means no "add to existing" option */ });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  const targets = useMemo(
    () => eligibleDraftTargets(allDrafts, { category, meId: user?.id, excludeId: draftId }),
    [allDrafts, category, user?.id, draftId],
  );
```

- [ ] **Step 3: Add choice-modal state and the merge action**

Inside `OrderForm`, add this state next to the existing `const [dupConfirm, setDupConfirm] = useState<...>(null);`:

```ts
  const [choice, setChoice] = useState<{ selectedId: string | null } | null>(null);
```

Then add the merge action just after the `doSubmit` function definition (after its closing `};` around line 418):

```ts
  // Append all local lines to an existing Draft PO, then remove the throwaway
  // draft this session created. Target meta (warehouse/payment/notes) is
  // inherited — we send only lines + a refreshed total.
  const doSubmitToExisting = async (target: OrderSummary) => {
    if (!draftId) { setAiError(t('subNoDraftErr')); return; }
    setSubmitting(true);
    try {
      await api.patch('/api/orders/' + target.id, {
        addLines: lines.map(toWireLine),
        totalCost: (target.totalCost ?? 0) + totals.cost,
      });
      // Best-effort cleanup of the now-empty throwaway draft — the merge already
      // succeeded, so a failure here must not fail the submit.
      try { await deleteOrder(draftId); } catch { /* leaves an empty draft; harmless */ }
      onDone({ msg: t('subLinesAddedToPo', { id: target.id }), kind: 'success' });
    } catch (e) {
      setAiError(e instanceof Error ? e.message : t('subSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  };
```

- [ ] **Step 4: Route the Submit button through the choice modal**

Find the Submit button's `onClick` (currently around line 656):

```tsx
                onClick={() => {
                  if (dupGroups.length > 0) {
                    setDupConfirm(dupGroups);
                    return;
                  }
                  void doSubmit();
                }}
```

Replace it with:

```tsx
                onClick={() => {
                  if (targets.length > 0) {
                    setChoice({ selectedId: null });
                    return;
                  }
                  if (dupGroups.length > 0) {
                    setDupConfirm(dupGroups);
                    return;
                  }
                  void doSubmit();
                }}
```

- [ ] **Step 5: Render the choice modal**

Immediately before the `{dupConfirm && (` block (around line 690), add the choice modal. It defers to the existing dup-part flow: choosing an action first runs the dup check, then performs the create-new or merge write.

```tsx
      {choice && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !submitting) setChoice(null); }}>
          <div className="modal-shell" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div className="modal-title">{t('subSubmitChoiceTitle')}</div>
                <div className="modal-sub">{t('subSubmitChoiceSub')}</div>
              </div>
            </div>
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              {/* Create new PO */}
              <button
                className="card"
                disabled={submitting}
                style={{
                  padding: 14, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg-elev)',
                }}
                onClick={() => {
                  setChoice(null);
                  if (dupGroups.length > 0) { setDupConfirm(dupGroups); return; }
                  void doSubmit();
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t('subChoiceNewPo')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>{t('subChoiceNewPoSub')}</div>
              </button>

              {/* Add to an existing draft */}
              <div className="card" style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t('subChoiceExistingPo')}</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2, marginBottom: 10 }}>
                  {t('subChoiceExistingPoSub', { cat: category })}
                </div>
                <div style={{ display: 'grid', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                  {targets.map(o => {
                    const sel = choice.selectedId === o.id;
                    return (
                      <button
                        key={o.id}
                        disabled={submitting}
                        onClick={() => setChoice({ selectedId: o.id })}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                          padding: '8px 10px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                          borderRadius: 8, background: sel ? 'var(--accent-soft)' : 'transparent',
                          border: '1px solid ' + (sel ? 'var(--accent)' : 'var(--border)'),
                        }}
                      >
                        <span className="mono" style={{ fontWeight: sel ? 600 : 500, color: sel ? 'var(--accent-strong)' : undefined }}>{o.id}</span>
                        <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                          {(o.warehouse?.short ?? '—') + ' · ' + t('subTargetMeta', { n: o.lineCount, cost: fmtUSD(o.totalCost ?? 0, locale) }) + ' · ' + fmtDateShort(o.createdAt, locale)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setChoice(null)} disabled={submitting}>{t('cancel')}</button>
              <button
                className="btn accent"
                disabled={submitting || !choice.selectedId}
                onClick={() => {
                  const target = targets.find(o => o.id === choice.selectedId);
                  if (!target) return;
                  setChoice(null);
                  if (dupGroups.length > 0) { setDupConfirm(dupGroups); return; }
                  void doSubmitToExisting(target);
                }}
              >
                {submitting ? '…' : t('subChoicePickTarget')}
              </button>
            </div>
          </div>
        </div>
      )}
```

Note: when the user has unresolved duplicate part numbers AND picks "add to existing", the dup modal's "Submit anyway" currently calls `doSubmit` (create-new). That would silently change their choice. Handle this in Step 6.

- [ ] **Step 6: Make the dup modal honor a pending merge target**

The dup-part modal's confirm currently always calls `doSubmit`. When the user reached it via the "add to existing" path, it must instead merge. Thread the pending target through `dupConfirm`'s flow using a ref-free approach: store the chosen target id on the dup-confirm trigger.

Replace the `dupConfirm` state declaration:

```ts
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);
```

with:

```ts
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);
  // When the dup-part warning is reached via "add to existing", remember which
  // target to merge into so confirming the warning doesn't fall back to new-PO.
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
```

In Step 5's "Create new PO" button onClick, before `setDupConfirm(dupGroups)`, add `setPendingTargetId(null);`. In Step 5's footer confirm onClick (the merge one), before `setDupConfirm(dupGroups)`, add `setPendingTargetId(target.id);`.

So those two blocks become:

```tsx
                // Create new PO button:
                onClick={() => {
                  setChoice(null);
                  if (dupGroups.length > 0) { setPendingTargetId(null); setDupConfirm(dupGroups); return; }
                  void doSubmit();
                }}
```

```tsx
                // Footer confirm (merge):
                onClick={() => {
                  const target = targets.find(o => o.id === choice.selectedId);
                  if (!target) return;
                  setChoice(null);
                  if (dupGroups.length > 0) { setPendingTargetId(target.id); setDupConfirm(dupGroups); return; }
                  void doSubmitToExisting(target);
                }}
```

Then update the dup modal's "Submit anyway" button (currently `onClick={async () => { setDupConfirm(null); await doSubmit(); }}`) to:

```tsx
                onClick={async () => {
                  setDupConfirm(null);
                  const target = pendingTargetId ? targets.find(o => o.id === pendingTargetId) : null;
                  setPendingTargetId(null);
                  if (target) await doSubmitToExisting(target);
                  else await doSubmit();
                }}
```

- [ ] **Step 7: Typecheck**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 8: Build**

Run: `cd apps/frontend && npx vite build`
Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSubmit.tsx
git commit -m "feat(submit): desktop choice to add lines to an existing draft PO

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the new unit test + full frontend test suite**

Run: `cd apps/frontend && npx vitest run`
Expected: all tests pass, including `eligibleTargets.test.ts`.

- [ ] **Step 2: Repo-wide typecheck**

Run: `pnpm typecheck`
Expected: PASS across the workspace.

- [ ] **Step 3: Manual verification checklist (record results)**

Start dev (`pnpm dev`), open desktop submit, and confirm:
- With **no** other same-category drafts: Submit Order submits directly (no modal) — unchanged behavior.
- With ≥1 same-category draft: Submit Order opens the choice modal.
- "Create a new PO" finalizes the current draft as today.
- "Add to an existing draft PO" → pick a target → confirm: the target PO now shows the appended lines and its prior warehouse/payment unchanged; the throwaway draft is gone from the orders list; toast reads "Lines added to PO-…".
- Duplicate part numbers across local lines still trigger the dup warning in BOTH paths, and confirming it routes to the right action (new vs. merge).
- Switching language to ZH shows translated modal copy.
