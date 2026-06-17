# PO submit-time optional attachment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a purchaser optionally attach files (e.g. a payment receipt) when submitting a Purchase Order on desktop, with the same upload/preview UX as the existing "Done" evidence; viewable and editable later on the order page.

**Architecture:** Reuse the existing `order_status_attachments` table with a new meta key `'Submission'` (attachments-only; the note reuses the order-level "Order notes" field). Widen the CHECK constraint (migration 0069), relax the attachment endpoints so the order **owner may write while the order is a Draft** (Done stays manager-only). The submit form buffers files locally and uploads them to the **final** order id after submit (so the submit-to-existing merge path works); the order page reuses the live-save endpoints for edit-later.

**Tech Stack:** Hono + postgres.js backend (Node 24), React frontend, vitest integration tests against real Postgres.

**Spec:** `docs/superpowers/specs/2026-06-17-po-submit-attachment-design.md`

---

## File Structure

- **Create:** `apps/backend/migrations/0069_status_meta_submission.sql` — widen the status CHECK on both meta tables to include `'Submission'`.
- **Modify:** `apps/backend/src/routes/orders.ts` — add `'Submission'` to `PO_META_STATUSES`, add a `canWriteMeta` helper, and rewire the three `status-meta` endpoints to authorize per-status (owner-while-draft for Submission).
- **Modify:** `apps/backend/tests/order-status-meta.test.ts` — add a `describe` block for Submission evidence (reuses the file's existing helpers).
- **Modify:** `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` — buffered attachment section + upload-after-submit.
- **Modify:** `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` — Submission attachments view + edit-later block.
- **Modify:** `apps/frontend/src/lib/i18n.tsx` — new EN + ZH strings.

---

## Task 1: Backend — `Submission` meta key, migration + authorization

**Files:**
- Create: `apps/backend/migrations/0069_status_meta_submission.sql`
- Modify: `apps/backend/src/routes/orders.ts` (`PO_META_STATUSES` at :1155; PUT :1158-1196; POST :1199-1264; DELETE :1267-1310)
- Test: `apps/backend/tests/order-status-meta.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to the end of `apps/backend/tests/order-status-meta.test.ts` (it reuses the existing `createOrder`, `getStatusMeta`, `PNG`, `loginAs`, `ALEX`, `MARCUS`). Also add `PRIYA` (a second purchaser) to the existing `import { loginAs, ALEX, MARCUS } from './helpers/auth';` line → `import { loginAs, ALEX, MARCUS, PRIYA } from './helpers/auth';`:

```ts
describe('PO status-meta — Submission (owner-editable while Draft)', () => {
  beforeEach(async () => { await resetDb(); });

  it('owner can upload + delete a Submission attachment on their own Draft', async () => {
    const { token: purchaser } = await loginAs(MARCUS);
    const id = await createOrder(purchaser, { advance: false }); // stays Draft

    const up = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`,
      { file: PNG() }, { token: purchaser });
    expect(up.status).toBe(200);
    const att = (up.body as { attachment: { id: string } }).attachment;

    const meta = await getStatusMeta(purchaser, id);
    expect(meta.Submission.attachments).toHaveLength(1);
    expect(meta.Submission.note).toBeNull();

    const del = await api('DELETE',
      `/api/orders/${id}/status-meta/Submission/attachments/${att.id}`, { token: purchaser });
    expect(del.status).toBe(200);
  });

  it('a non-owner purchaser is forbidden; a manager is allowed', async () => {
    const { token: owner } = await loginAs(MARCUS);
    const { token: stranger } = await loginAs(PRIYA); // another purchaser, not the owner
    const { token: mgr } = await loginAs(ALEX);
    const id = await createOrder(owner, { advance: false });

    const strangerUp = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`,
      { file: PNG() }, { token: stranger });
    expect(strangerUp.status).toBe(403);

    const mgrUp = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`,
      { file: PNG() }, { token: mgr });
    expect(mgrUp.status).toBe(200);
  });

  it('after the order leaves Draft, the owner is locked out but a manager is not', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const { token: owner } = await loginAs(MARCUS);
    const id = await createOrder(owner); // advances out of Draft

    const ownerUp = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`,
      { file: PNG() }, { token: owner });
    expect(ownerUp.status).toBe(403);

    const mgrUp = await multipart(`/api/orders/${id}/status-meta/Submission/attachments`,
      { file: PNG() }, { token: mgr });
    expect(mgrUp.status).toBe(200);
  });

  it('regression: Done evidence stays manager-only (owner purchaser forbidden)', async () => {
    const { token: owner } = await loginAs(MARCUS);
    const id = await createOrder(owner, { advance: false });
    const up = await multipart(`/api/orders/${id}/status-meta/Done/attachments`,
      { file: PNG() }, { token: owner });
    expect(up.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && npx vitest run tests/order-status-meta.test.ts`
Expected: the new Submission tests FAIL — uploads return **400** ("invalid status") because `PO_META_STATUSES` does not yet contain `'Submission'`.

- [ ] **Step 3: Create the migration**

Create `apps/backend/migrations/0069_status_meta_submission.sql`:

```sql
-- Widen status-meta to a second key, 'Submission' — optional attachments a
-- purchaser leaves when submitting a PO. Attachments-only: the note reuses the
-- order-level notes field, so no order_status_meta row is required. The inline
-- CHECK from 0068 is auto-named <table>_status_check.

ALTER TABLE order_status_meta
  DROP CONSTRAINT order_status_meta_status_check,
  ADD  CONSTRAINT order_status_meta_status_check CHECK (status IN ('Submission', 'Done'));

ALTER TABLE order_status_attachments
  DROP CONSTRAINT order_status_attachments_status_check,
  ADD  CONSTRAINT order_status_attachments_status_check CHECK (status IN ('Submission', 'Done'));
```

Note: if `DROP CONSTRAINT` fails on a real DB because Postgres named the constraint differently, find the real name with `\d order_status_meta` (or query `pg_constraint`) and substitute it. The test harness rebuilds the template from scratch, so the convention name above is what 0068's inline CHECK produces.

- [ ] **Step 4: Add `'Submission'` to `PO_META_STATUSES` and the `canWriteMeta` helper**

In `apps/backend/src/routes/orders.ts`, change line 1155:

```ts
const PO_META_STATUSES = new Set(['Submission', 'Done']);

// Submission evidence (receipts attached at submit time) is owner-editable: the
// purchaser who owns the order may add/remove files while it is still a Draft.
// Every other meta status (Done) remains manager-only.
function canWriteMeta(u: User, status: string, order: { user_id: string; lifecycle: string }): boolean {
  if (effectiveRole(u) === 'manager') return true;
  return status === 'Submission' && order.user_id === u.id && order.lifecycle === 'draft';
}
```

- [ ] **Step 5: Rewire the three endpoints to authorize per-status**

For **each** of PUT (`:1158`), POST (`:1199`), DELETE (`:1267`): (a) delete the early `if (effectiveRole(u) !== 'manager') return c.json({ error: 'Forbidden' }, 403);` line, (b) change the order lookup to also select `user_id`, and (c) authorize with `canWriteMeta` right after the 404 check. The status `PO_META_STATUSES` check stays where it is (before the lookup, so unknown statuses still 400 before 404).

In all three handlers, replace the existing lookup block:

```ts
  const existing = (await sql`SELECT lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { lifecycle: string } | undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);
```

with:

```ts
  const existing = (await sql`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { user_id: string; lifecycle: string } | undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (!canWriteMeta(u, status, existing)) return c.json({ error: 'Forbidden' }, 403);
```

Then remove the now-redundant manager-only guard line near the top of each handler (PUT line ~1160, POST line ~1201, DELETE line ~1269). The `auditable` line (`existing.lifecycle !== 'draft'`) stays and still works (`existing` now also has `user_id`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/backend && npx vitest run tests/order-status-meta.test.ts`
Expected: PASS — all prior Done tests plus the four new Submission tests.

- [ ] **Step 7: Run the full backend suite (no regressions)**

Run: `cd apps/backend && npx vitest run`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/migrations/0069_status_meta_submission.sql apps/backend/src/routes/orders.ts apps/backend/tests/order-status-meta.test.ts
git commit -m "feat(submit): backend Submission meta key, owner-editable on Draft

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Frontend — i18n strings + buffered attachment section on submit

Per CLAUDE.md, frontend UI is validated by visiting it (tests are sparse); there is no pure helper worth isolating here, so this task is implement + manual verify.

**Files:**
- Modify: `apps/frontend/src/lib/i18n.tsx` (EN map near :702; ZH map near :1979)
- Modify: `apps/frontend/src/pages/desktop/DesktopSubmit.tsx`

- [ ] **Step 1: Add i18n strings (EN + ZH)**

In `apps/frontend/src/lib/i18n.tsx`, add to the **EN** map (next to the existing upload keys around line 702):

```ts
    poSubmitAttachLabel: 'Attachment',
    poSubmitAttachHint: 'Receipt or proof (PDF / JPG / PNG) — optional',
    poSubmitUploadWarning: 'Order submitted, but the file could not be attached. You can add it from the order page.',
    poSubmissionEvidenceTitle: 'Submission attachments',
```

Add the matching keys to the **ZH** map (next to the existing upload keys around line 1979):

```ts
    poSubmitAttachLabel: '附件',
    poSubmitAttachHint: '收据或凭证（PDF / JPG / PNG）— 可选',
    poSubmitUploadWarning: '订单已提交，但文件未能上传。您可以在订单页面添加。',
    poSubmissionEvidenceTitle: '提交附件',
```

- [ ] **Step 2: Add buffered-file state and helpers in `OrderForm`**

In `apps/frontend/src/pages/desktop/DesktopSubmit.tsx`, ensure these imports exist at the top (add what's missing):

```ts
import { useMemo, useEffect, useRef } from 'react';
import { AttachmentChip } from '../../components/AttachmentChip';
```

Inside the `OrderForm` component (near the other `useState` calls, around line 244), add:

```ts
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [evidenceDragOver, setEvidenceDragOver] = useState(false);
  const evidenceInputRef = useRef<HTMLInputElement | null>(null);

  // Object URLs for local preview; revoked when the file set changes / unmounts.
  const evidencePreviews = useMemo(
    () => evidenceFiles.map(f => ({ file: f, url: URL.createObjectURL(f) })),
    [evidenceFiles],
  );
  useEffect(
    () => () => { evidencePreviews.forEach(p => URL.revokeObjectURL(p.url)); },
    [evidencePreviews],
  );

  const addEvidenceFiles = (fl: FileList | null) => {
    const picked = Array.from(fl || []).filter(f => {
      if (f.size > 10 * 1024 * 1024) { setAiError(t('fileTooLarge', { name: f.name })); return false; }
      return true;
    });
    if (picked.length) setEvidenceFiles(prev => [...prev, ...picked]);
  };

  // Upload buffered evidence to the FINAL order id (the new draft, or the merge
  // target). Returns true if every file uploaded. Non-fatal: a false result
  // surfaces a warning but the order is already submitted.
  const uploadEvidence = async (finalId: string): Promise<boolean> => {
    let ok = true;
    for (const f of evidenceFiles) {
      try {
        const form = new FormData();
        form.append('file', f);
        await api.upload(`/api/orders/${finalId}/status-meta/Submission/attachments`, form);
      } catch { ok = false; }
    }
    return ok;
  };
```

- [ ] **Step 3: Render the attachment section**

In `apps/frontend/src/pages/desktop/DesktopSubmit.tsx`, insert this block immediately after the order-details grid section closes — i.e. after the `</div>` on line 710 (the close of the warehouse/payment/total/notes section) and before the totals/submit footer `<div style={{ padding: 16, ...`):

```tsx
        <div style={{ padding: '0 16px 16px' }}>
          <label className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{t('poSubmitAttachLabel')}</span>
            <span style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400 }}>{t('poSubmitAttachHint')}</span>
          </label>
          <div
            onDragOver={e => { e.preventDefault(); setEvidenceDragOver(true); }}
            onDragLeave={() => setEvidenceDragOver(false)}
            onDrop={e => { e.preventDefault(); setEvidenceDragOver(false); addEvidenceFiles(e.dataTransfer.files); }}
            onClick={() => evidenceInputRef.current?.click()}
            style={{
              border: '1.5px dashed ' + (evidenceDragOver ? 'var(--accent)' : 'var(--border-strong)'),
              background: evidenceDragOver ? 'var(--accent-soft)' : 'var(--bg-soft)',
              borderRadius: 10, padding: '16px', textAlign: 'center', cursor: 'pointer',
              transition: 'border-color 120ms, background 120ms',
            }}
          >
            <Icon name="upload" size={18} style={{ color: 'var(--fg-subtle)' }} />
            <div style={{ marginTop: 6, fontSize: 13 }}>
              <strong style={{ color: 'var(--accent-strong)' }}>{t('clickToUpload')}</strong> {t('orDragDrop')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{t('uploadHint')}</div>
            <input
              ref={evidenceInputRef}
              type="file"
              multiple
              accept=".pdf,.png,.jpg,.jpeg,image/*,application/pdf"
              style={{ display: 'none' }}
              onChange={e => { addEvidenceFiles(e.target.files); e.target.value = ''; }}
            />
          </div>
          {evidencePreviews.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {evidencePreviews.map((p, i) => (
                <AttachmentChip
                  key={i}
                  a={{ id: String(i), filename: p.file.name, size: p.file.size, mime: p.file.type, url: p.url }}
                  onRemove={() => setEvidenceFiles(prev => prev.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}
        </div>
```

- [ ] **Step 4: Upload evidence after submit (both submit paths)**

In `doSubmit` (around line 446), replace the success line `onDone({ msg: t('orderSubmitted'), kind: 'success' });` with:

```ts
      if (evidenceFiles.length > 0) {
        const ok = await uploadEvidence(draftId);
        onDone(ok
          ? { msg: t('orderSubmitted'), kind: 'success' }
          : { msg: t('poSubmitUploadWarning'), kind: 'error' });
        return;
      }
      onDone({ msg: t('orderSubmitted'), kind: 'success' });
```

In `doSubmitToExisting` (around line 468), after the `api.patch('/api/orders/' + target.id, …)` await succeeds and **before** the throwaway-draft cleanup, upload to the merge target, then keep the existing cleanup + success toast. Replace the body between the patch and `onDone(...)` so it reads:

```ts
      await api.patch('/api/orders/' + target.id, {
        addLines: submitLines.map(toWireLine),
        totalCost: (target.totalCost ?? 0) + totals.cost,
      });
      const evidenceOk = evidenceFiles.length === 0 || await uploadEvidence(target.id);
      // Best-effort cleanup of the now-empty throwaway draft.
      try { await deleteOrder(draftId); } catch { /* leaves an empty draft; harmless */ }
      onDone(evidenceOk
        ? { msg: t('subLinesAddedToPo', { id: target.id }), kind: 'success' }
        : { msg: t('poSubmitUploadWarning'), kind: 'error' });
```

- [ ] **Step 5: Typecheck**

Run: `cd /srv/data/recycle_erp && pnpm --filter recycle-erp-frontend typecheck` (or `pnpm typecheck`)
Expected: no type errors. If `AttachmentChip`'s prop type isn't exported as inline-compatible, import its `ChipAttachment` type and annotate the `a` object.

- [ ] **Step 6: Manual verification**

Run `pnpm dev`, open the desktop submit form, add a line, attach a PNG, confirm the chip preview (image opens in a lightbox), submit, then open the order's edit page and confirm the file shows under "Submission attachments" (Task 3 renders it; if doing tasks in order, verify after Task 3). Verify submitting with **no** attachment still works unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/lib/i18n.tsx apps/frontend/src/pages/desktop/DesktopSubmit.tsx
git commit -m "feat(submit): optional attachment on PO submit (buffered upload)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend — view + edit-later block on the order page

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx`

- [ ] **Step 1: Add Submission attachment state + live-save handlers**

In `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx`, near the existing `doneAttachments` state (line ~80), add:

```ts
  const [submissionAtts, setSubmissionAtts] = useState<StatusAttachment[]>(
    order.statusMeta?.['Submission']?.attachments ?? [],
  );
  const [submissionUploading, setSubmissionUploading] = useState(false);
  // Owner may edit while Draft; managers always. Mirrors the backend gate.
  const canEditSubmission = !isPurchaser || (order.userId === user?.id && effectiveStatus === 'Draft');

  const addSubmissionFiles = async (fl: FileList | null) => {
    const files = Array.from(fl || []);
    if (!files.length) return;
    setSubmissionUploading(true);
    try {
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) continue;
        const form = new FormData();
        form.append('file', f);
        const r = await api.upload<{ attachment: StatusAttachment }>(
          `/api/orders/${order.id}/status-meta/Submission/attachments`, form);
        setSubmissionAtts(prev => [...prev, r.attachment]);
      }
    } finally {
      setSubmissionUploading(false);
    }
  };

  const removeSubmissionAtt = async (att: StatusAttachment) => {
    await api.delete(`/api/orders/${order.id}/status-meta/Submission/attachments/${att.id}`);
    setSubmissionAtts(prev => prev.filter(a => a.id !== att.id));
  };
```

(`StatusAttachment` is already imported on line 16; `AttachmentChip` on line 17; `useAuth`'s `user` on line 59.)

- [ ] **Step 2: Render the block**

Immediately after the Done evidence block (after its closing `)}` on line ~775), add:

```tsx
          {(submissionAtts.length > 0 || canEditSubmission) && (
            <div style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 8,
              background: 'var(--bg-soft)', border: '1px solid var(--border)',
              display: 'grid', gap: 8,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
                textTransform: 'uppercase', letterSpacing: '0.06em',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <Icon name="paperclip" size={11} /> {t('poSubmissionEvidenceTitle')}
              </div>
              {submissionAtts.map(a => (
                <AttachmentChip
                  key={a.id}
                  a={a}
                  onRemove={canEditSubmission ? () => removeSubmissionAtt(a) : undefined}
                />
              ))}
              {canEditSubmission && (
                <label className="btn sm" style={{ justifySelf: 'start', cursor: 'pointer' }}>
                  <Icon name="upload" size={12} /> {submissionUploading ? t('uploadingLabel') : t('clickToUpload')}
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.png,.jpg,.jpeg,image/*,application/pdf"
                    style={{ display: 'none' }}
                    onChange={e => { addSubmissionFiles(e.target.files); e.target.value = ''; }}
                  />
                </label>
              )}
            </div>
          )}
```

- [ ] **Step 3: Typecheck**

Run: `cd /srv/data/recycle_erp && pnpm --filter recycle-erp-frontend typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

`pnpm dev`: as the purchaser owner, open a Draft PO you submitted with an attachment → confirm it shows, you can add another and remove one. Advance it out of Draft → confirm the add/remove controls disappear (view-only) for the purchaser. As a manager, confirm you can always edit.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopEditOrder.tsx
git commit -m "feat(submit): view & edit submission attachments on the order page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Release

- [ ] **Step 1: Confirm a clean tree owning only these files**

Run: `git status` — confirm only the files from Tasks 1-3 are staged/committed and no unrelated WIP is present (per the release dirty-tree hazard).

- [ ] **Step 2: Cut the release**

This is a feature → minor bump (1.9.0 → 1.10.0).
Run: `./scripts/release.sh minor` (use the repo's documented invocation; it bumps `package.json`, regenerates `CHANGELOG.md`, tags, and builds versioned images).
Expected: version bumped to 1.10.0, CHANGELOG updated, tag created.

- [ ] **Step 3: Push**

Run: `git push origin main --follow-tags`
Expected: pre-push changelog gate + audit pass; pushed to origin/main.

---

## Self-Review notes

- **Spec coverage:** §1 storage → Task 1 Step 3; §2 auth → Task 1 Steps 4-5; §3 buffered submit → Task 2; §4 view/edit-later → Task 3; §5 i18n → Task 2 Step 1 + Task 3; testing → Task 1 Steps 1/6/7; rollout → Task 4. All covered.
- **Note reuse:** no separate evidence note anywhere; `statusMeta.Submission.note` is asserted `null` in Task 1 Step 1. Consistent.
- **Type consistency:** `canWriteMeta(u, status, {user_id, lifecycle})` matches the rewired `existing` shape (Task 1 Step 5). `StatusAttachment` reused on both frontend surfaces. `uploadEvidence(finalId)` called in both submit paths with the resolved id.
