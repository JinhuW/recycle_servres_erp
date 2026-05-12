# Mobile Design Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the phone view of Recycle Servers ERP to parity with the Claude Design reference bundle (8 phone screens), unify line-edit UI, add deep-linkable order URLs (mobile + desktop), and fix navigation/i18n gaps.

**Architecture:** Frontend-only changes to `apps/frontend/src/`. No new dependencies. Hash-based deep-linking via a small `lib/route.ts`. Shared `PhCategoryFields` component eliminates duplicate RAM/SSD/Other field markup. `CaptureState` discriminated union gains `editingLineIdx` and `returnTo` fields so SubmitForm doubles as a line-edit page and back-buttons return to the right surface.

**Tech Stack:** React 18, TypeScript, Vite, Hono (backend, untouched by this plan). i18n via existing `lib/i18n.tsx` (`en` + `zh`).

**Reference spec:** `docs/superpowers/specs/2026-05-12-mobile-design-parity-design.md`.

**Verification across all groups:**
- `pnpm --filter=frontend typecheck` (or `pnpm --filter=frontend exec tsc --noEmit`) — clean after every group.
- `pnpm --filter=frontend build` — clean at the end.
- Manual: render each affected screen in the dev server, compare side-by-side with the reference bundle files in `/tmp/claude-design/recycle-servers-inventory-management/project/` (specifically `phone-app.jsx` and `phone-styles.css`). Don't render the prototype in a browser; read the source.

---

## Group 1: Cross-cutting infrastructure (CC-1..CC-7)

This group is the foundation — every other group depends on it. One commit at the end.

### Task 1.1: Add missing `.cam-hint` CSS

**Files:**
- Modify: `apps/frontend/src/styles/phone.css`

- [ ] **Step 1: Append the rule after the `.ph-cam-pill` block**

Find this block (around line 236-247):

```css
.ph-cam-pill {
  background: rgba(0,0,0,0.45);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
```

Immediately after it, insert:

```css
.cam-hint {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 11.5px;
  font-weight: 500;
  color: rgba(255,255,255,0.9);
  white-space: nowrap;
}
```

### Task 1.2: Add `.ph-info-banner` variant CSS (used by S6 Inventory)

**Files:**
- Modify: `apps/frontend/src/styles/phone.css`

- [ ] **Step 1: Append the info-banner variant after `.ph-ai-banner`**

Find the `.ph-ai-banner` block (around line 297-314). After the `.ph-ai-banner .pill-ai` block, insert:

```css
.ph-info-banner {
  padding: 10px 14px;
  background: var(--info-soft);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: oklch(0.45 0.13 250);
  border: 1px solid color-mix(in oklch, var(--info) 25%, transparent);
  border-radius: 12px;
}
```

### Task 1.3: New file — `lib/usePhScrolled.ts` (scroll-shadow hook)

**Files:**
- Create: `apps/frontend/src/lib/usePhScrolled.ts`

- [ ] **Step 1: Write the hook**

```ts
import { useEffect, useState, type RefObject } from 'react';

/**
 * Returns true once the scroll container has been scrolled past `threshold`px.
 * Used by mobile page headers to toggle the `.ph-header.scrolled` treatment.
 */
export function usePhScrolled(ref: RefObject<HTMLElement | null>, threshold = 4): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > threshold);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { el.removeEventListener('scroll', onScroll); };
  }, [ref, threshold]);
  return scrolled;
}
```

### Task 1.4: New file — `lib/route.ts` (hash routing)

**Files:**
- Create: `apps/frontend/src/lib/route.ts`

- [ ] **Step 1: Write the route helpers**

```ts
import { useEffect, useState } from 'react';

/**
 * Tiny hash-based router. No external deps. The app's "URL" is the part after
 * `#`, e.g. `#/orders/SO-1289` → path `/orders/SO-1289`. Both mobile and
 * desktop shells subscribe to this and react to changes.
 */

function readPath(): string {
  if (typeof window === 'undefined') return '/';
  const h = window.location.hash || '';
  return h.startsWith('#') ? h.slice(1) || '/' : '/';
}

export function navigate(path: string): void {
  const target = path.startsWith('/') ? path : '/' + path;
  // Avoid setting the same hash twice — that would emit a redundant
  // hashchange event and cause downstream effects to fire pointlessly.
  if (window.location.hash === '#' + target) return;
  window.location.hash = target;
}

export function useRoute(): { path: string } {
  const [path, setPath] = useState<string>(readPath);
  useEffect(() => {
    const onChange = () => setPath(readPath());
    window.addEventListener('hashchange', onChange);
    return () => { window.removeEventListener('hashchange', onChange); };
  }, []);
  return { path };
}

/**
 * Returns the params object if `template` (e.g. `/orders/:id`) matches `path`,
 * or null otherwise. Trailing segments in `path` are not allowed unless the
 * template's last segment is a param.
 */
export function match(template: string, path: string): Record<string, string> | null {
  const t = template.split('/').filter(Boolean);
  const p = path.split('/').filter(Boolean);
  if (t.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i]!;
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(p[i]!);
    } else if (seg !== p[i]) {
      return null;
    }
  }
  return params;
}
```

### Task 1.5: Extend `CaptureState` in `MobileApp.tsx`

**Files:**
- Modify: `apps/frontend/src/MobileApp.tsx:23-28` (state union); the rest of the file gets touched in groups 2-5.

- [ ] **Step 1: Replace the type alias**

Find:

```ts
type CaptureState =
  | { phase: 'idle' }
  | { phase: 'category' }
  | { phase: 'camera';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null }
  | { phase: 'form';    category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null }
  | { phase: 'review';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null };
```

Replace with:

```ts
type ReturnTo = 'idle' | 'review';

type CaptureState =
  | { phase: 'idle' }
  | { phase: 'category' }
  | { phase: 'camera';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; editingLineIdx?: number | null; returnTo: ReturnTo }
  | { phase: 'form';    category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null; editingLineIdx?: number | null; returnTo: ReturnTo }
  | { phase: 'review';  category: Category;  detected: ScanResponse | null; lines: DraftLine[]; editingId?: string | null };
```

Note: `review` does NOT get `returnTo` or `editingLineIdx` — it's the "home base" for the capture flow.

### Task 1.6: Update capture transitions to thread `returnTo` and `editingLineIdx`

**Files:**
- Modify: `apps/frontend/src/MobileApp.tsx:62-174`

- [ ] **Step 1: Update `pickCategory`**

Find:

```ts
  const pickCategory = (cat: Category) => {
    if (cat === 'RAM') {
      setCapture({ phase: 'camera', category: cat, detected: null, lines: [] });
    } else {
      setCapture({ phase: 'form', category: cat, detected: null, lines: [] });
    }
  };
```

Replace with:

```ts
  const pickCategory = (cat: Category) => {
    if (cat === 'RAM') {
      setCapture({ phase: 'camera', category: cat, detected: null, lines: [], editingLineIdx: null, returnTo: 'idle' });
    } else {
      setCapture({ phase: 'form', category: cat, detected: null, lines: [], editingLineIdx: null, returnTo: 'idle' });
    }
  };
```

- [ ] **Step 2: Update `onDetected`**

Find:

```ts
  const onDetected = (s: ScanResponse) => {
    setCapture(c => c.phase === 'camera' ? { ...c, phase: 'form', detected: s } : c);
  };
```

It already works — the spread preserves `editingLineIdx` and `returnTo`. No change.

- [ ] **Step 3: Update `onSaveLine` to handle edit mode**

Find:

```ts
  const onSaveLine = (line: DraftLine) => {
    setCapture(c => {
      if (c.phase !== 'form') return c;
      return {
        phase: 'review',
        category: c.category,
        detected: null,
        lines: [...c.lines, line],
        editingId: c.editingId,
      };
    });
  };
```

Replace with:

```ts
  const onSaveLine = (line: DraftLine) => {
    setCapture(c => {
      if (c.phase !== 'form') return c;
      const lines = (c.editingLineIdx != null)
        ? c.lines.map((l, i) => i === c.editingLineIdx ? line : l)
        : [...c.lines, line];
      return {
        phase: 'review',
        category: c.category,
        detected: null,
        lines,
        editingId: c.editingId,
      };
    });
  };
```

- [ ] **Step 4: Update `addAnotherItem` to set `returnTo: 'review'`**

Find:

```ts
  const addAnotherItem = () => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return c.category === 'RAM'
        ? { ...c, phase: 'camera', detected: null }
        : { ...c, phase: 'form', detected: null };
    });
  };
```

Replace with:

```ts
  const addAnotherItem = () => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return c.category === 'RAM'
        ? { phase: 'camera', category: c.category, detected: null, lines: c.lines, editingId: c.editingId, editingLineIdx: null, returnTo: 'review' }
        : { phase: 'form',   category: c.category, detected: null, lines: c.lines, editingId: c.editingId, editingLineIdx: null, returnTo: 'review' };
    });
  };
```

- [ ] **Step 5: Add new handlers `editLine` and `goBack`**

Insert immediately after `addAnotherItem`:

```ts
  const editLine = (idx: number) => {
    setCapture(c => {
      if (c.phase !== 'review') return c;
      return {
        phase: 'form',
        category: c.category,
        detected: null,
        lines: c.lines,
        editingId: c.editingId,
        editingLineIdx: idx,
        returnTo: 'review',
      };
    });
  };

  const goBack = () => {
    setCapture(c => {
      if (c.phase !== 'camera' && c.phase !== 'form') return c;
      if (c.returnTo === 'review') {
        return { phase: 'review', category: c.category, detected: null, lines: c.lines, editingId: c.editingId };
      }
      return { phase: 'idle' };
    });
  };

  const rescanRam = () => {
    setCapture(c => {
      if (c.phase !== 'form') return c;
      return {
        phase: 'camera', category: c.category, detected: null, lines: c.lines,
        editingId: c.editingId, editingLineIdx: c.editingLineIdx ?? null, returnTo: c.returnTo,
      };
    });
  };
```

- [ ] **Step 6: Update `startEdit` (no signature change, but keep types satisfied)**

The existing implementation creates a `review` phase object — review doesn't need `returnTo`/`editingLineIdx`, so it stays as-is. Confirm by re-reading lines 144-174 — no change required.

### Task 1.7: Wire SubmitForm + Camera renders to new state fields

**Files:**
- Modify: `apps/frontend/src/MobileApp.tsx:184-217` (the render block that intercepts camera/form/review).

- [ ] **Step 1: Replace the three full-screen render blocks**

Find:

```tsx
  // Full-screen camera/form/review intercept the normal tab UI
  if (capture.phase === 'camera') {
    return (
      <Camera
        category={capture.category}
        onDetected={onDetected}
        onClose={cancelCapture}
      />
    );
  }
  if (capture.phase === 'form') {
    return (
      <SubmitForm
        category={capture.category}
        detected={capture.detected}
        lineCount={capture.lines.length}
        onSaveLine={onSaveLine}
        onCancel={cancelCapture}
        onRescan={() => setCapture(c => c.phase === 'form' ? { ...c, phase: 'camera', detected: null } : c)}
      />
    );
  }
  if (capture.phase === 'review') {
    return (
      <OrderReview
        category={capture.category}
        lines={capture.lines}
        editingId={capture.editingId}
        onAddItem={addAnotherItem}
        onRemoveLine={removeLine}
        onUpdateLine={updateLine}
        onSubmit={submitOrder}
        onCancel={cancelCapture}
      />
    );
  }
```

Replace with:

```tsx
  // Full-screen camera/form/review intercept the normal tab UI
  if (capture.phase === 'camera') {
    return (
      <Camera
        category={capture.category}
        onDetected={onDetected}
        onClose={cancelCapture}
        onBack={goBack}
      />
    );
  }
  if (capture.phase === 'form') {
    const existing = capture.editingLineIdx != null ? capture.lines[capture.editingLineIdx] : undefined;
    return (
      <SubmitForm
        category={capture.category}
        detected={capture.detected}
        lineCount={capture.lines.length}
        editingLineIdx={capture.editingLineIdx ?? null}
        existingLine={existing}
        onSaveLine={onSaveLine}
        onCancel={cancelCapture}
        onBack={goBack}
        onRescan={rescanRam}
      />
    );
  }
  if (capture.phase === 'review') {
    return (
      <OrderReview
        category={capture.category}
        lines={capture.lines}
        editingId={capture.editingId}
        onAddItem={addAnotherItem}
        onEditLine={editLine}
        onRemoveLine={removeLine}
        onSubmit={submitOrder}
        onCancel={cancelCapture}
      />
    );
  }
```

(Note: removed `onUpdateLine` from OrderReview since inline editing is going away in Group 3.)

### Task 1.8: New file — `components/PhCategoryFields.tsx`

**Files:**
- Create: `apps/frontend/src/components/PhCategoryFields.tsx`

- [ ] **Step 1: Write the shared field-grid component**

```tsx
import type { Category, DraftLine } from '../lib/types';
import { useT } from '../lib/i18n';

type Props = {
  category: Category;
  value: DraftLine;
  onChange: <K extends keyof DraftLine>(key: K, v: DraftLine[K]) => void;
  aiFilled?: boolean;
};

/**
 * Per-category form fields (brand, capacity, type, etc.). Used by SubmitForm
 * in both "new line" and "edit line" modes — the wrapping page provides the
 * header, AI banner, action bar, and any other category-agnostic surrounding.
 */
export function PhCategoryFields({ category, value, onChange, aiFilled }: Props) {
  const { t } = useT();
  const inputCls = 'input' + (aiFilled ? ' ai-filled' : '');
  const selectCls = 'select' + (aiFilled ? ' ai-filled' : '');

  if (category === 'RAM') {
    return (
      <>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('brand')}</label>
            <input className={inputCls} value={value.brand ?? ''} onChange={e => onChange('brand', e.target.value)} />
          </div>
          <div className="ph-field">
            <label>{t('type')}</label>
            <select className={selectCls} value={value.type ?? 'DDR4'} onChange={e => onChange('type', e.target.value)}>
              <option>DDR3</option><option>DDR4</option><option>DDR5</option>
            </select>
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('capacity')}</label>
            <select className={selectCls} value={value.capacity ?? '32GB'} onChange={e => onChange('capacity', e.target.value)}>
              <option>4GB</option><option>8GB</option><option>16GB</option><option>32GB</option><option>64GB</option><option>128GB</option>
            </select>
          </div>
          <div className="ph-field">
            <label>{t('speedMhz')}</label>
            <input className={inputCls} value={value.speed ?? ''} onChange={e => onChange('speed', e.target.value)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('klass')}</label>
            <select className={selectCls} value={value.classification ?? 'RDIMM'} onChange={e => onChange('classification', e.target.value)}>
              <option>UDIMM</option><option>RDIMM</option><option>LRDIMM</option><option>SODIMM</option>
            </select>
          </div>
          <div className="ph-field">
            <label>{t('rank')}</label>
            <select className={selectCls} value={value.rank ?? '2Rx4'} onChange={e => onChange('rank', e.target.value)}>
              <option>1Rx4</option><option>1Rx8</option><option>2Rx4</option><option>2Rx8</option><option>4Rx4</option>
            </select>
          </div>
        </div>
        <div className="ph-field">
          <label>{t('partNumber')}</label>
          <input className={inputCls + ' mono'} value={value.partNumber ?? ''} onChange={e => onChange('partNumber', e.target.value)} />
        </div>
      </>
    );
  }

  if (category === 'SSD') {
    return (
      <>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('brand')}</label>
            <input className={inputCls} value={value.brand ?? ''} onChange={e => onChange('brand', e.target.value)} />
          </div>
          <div className="ph-field">
            <label>{t('capacity')}</label>
            <input className={inputCls} value={value.capacity ?? ''} onChange={e => onChange('capacity', e.target.value)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('interfaceLbl')}</label>
            <select className={selectCls} value={value.interface ?? 'NVMe'} onChange={e => onChange('interface', e.target.value)}>
              <option>SATA</option><option>SAS</option><option>NVMe</option><option>U.2</option>
            </select>
          </div>
          <div className="ph-field">
            <label>{t('formFactor')}</label>
            <select className={selectCls} value={value.formFactor ?? 'M.2 2280'} onChange={e => onChange('formFactor', e.target.value)}>
              <option>2.5"</option><option>M.2 2280</option><option>M.2 22110</option><option>U.2</option><option>AIC</option>
            </select>
          </div>
        </div>
        <div className="ph-field">
          <label>{t('partNumber')}</label>
          <input className={inputCls + ' mono'} value={value.partNumber ?? ''} onChange={e => onChange('partNumber', e.target.value)} />
        </div>
      </>
    );
  }

  // Other
  return (
    <>
      <div className="ph-field">
        <label>{t('description')}</label>
        <input className={inputCls} value={value.description ?? ''} onChange={e => onChange('description', e.target.value)} />
      </div>
      <div className="ph-field">
        <label>{t('partNumber')}</label>
        <input className={inputCls + ' mono'} value={value.partNumber ?? ''} onChange={e => onChange('partNumber', e.target.value)} />
      </div>
    </>
  );
}
```

### Task 1.9: Add i18n keys

**Files:**
- Modify: `apps/frontend/src/lib/i18n.tsx`

- [ ] **Step 1: Insert EN keys near the end of the `en:` block**

Find the line `units2: 'units',` (around line 166). Immediately after it, before the `// ── Desktop ──` comment, insert:

```ts
    // ── Mobile parity additions (2026-05-12) ──
    rescanWithAi: 'Rescan with AI',
    notifTitle: 'Notifications',
    notifNUnread: '{n} unread',
    notifAllCaught: 'All caught up',
    notifMarkAllRead: 'Mark all read',
    notifManageHint: 'Manage alert types in Profile · Notifications',
    loadingAccounts: 'Loading demo accounts…',
    signInBack: 'Back',
    searchOrders: 'Search orders…',
    vsLast30: '{pct} vs last 30d',
    cameraUpload: 'Upload from library',
    cameraSwitch: 'Switch camera',
    cameraFlash: 'Toggle flash',
    orderIdCopied: 'Order link copied',
    shareOrder: 'Share order',
    editRamItem: 'Edit RAM item',
    editSsdItem: 'Edit SSD item',
    editOtherItem: 'Edit item',
    saveChanges: 'Save changes',
    aboutSheetTitle: 'About',
    aboutVersion: 'Version',
    aboutBuild: 'Build',
    aboutSupport: 'Support',
    aboutClose: 'Close',
    securityNoticeTitle: 'Security & 2FA',
    securityNoticeBody: 'Managed by your Workspace Admin. Reach out through your IT channel to change SSO or two-factor settings.',
    securityOk: 'OK',
```

- [ ] **Step 2: Insert ZH keys at the corresponding location in the `zh:` block**

Add to the `zh` block (find the analogous spot — anywhere stable; just keep keys present):

```ts
    rescanWithAi: '用 AI 重新扫描',
    notifTitle: '通知',
    notifNUnread: '{n} 条未读',
    notifAllCaught: '全部已读',
    notifMarkAllRead: '全部标为已读',
    notifManageHint: '在「个人 · 通知」中管理提醒类型',
    loadingAccounts: '加载演示账号…',
    signInBack: '返回',
    searchOrders: '搜索订单…',
    vsLast30: '较过去 30 天 {pct}',
    cameraUpload: '从相册上传',
    cameraSwitch: '切换摄像头',
    cameraFlash: '切换闪光灯',
    orderIdCopied: '订单链接已复制',
    shareOrder: '分享订单',
    editRamItem: '编辑内存项目',
    editSsdItem: '编辑硬盘项目',
    editOtherItem: '编辑项目',
    saveChanges: '保存修改',
    aboutSheetTitle: '关于',
    aboutVersion: '版本',
    aboutBuild: '构建',
    aboutSupport: '支持',
    aboutClose: '关闭',
    securityNoticeTitle: '安全与双因素认证',
    securityNoticeBody: '由您的工作区管理员管理。如需更改单点登录或双因素设置，请通过 IT 渠道联系。',
    securityOk: '好',
```

### Task 1.10: Verify and commit Group 1

- [ ] **Step 1: Typecheck**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend exec tsc --noEmit
```

Expected: no errors. (`SubmitForm`/`OrderReview` may emit "extra props" errors against their current signatures — that's fine because Groups 2-3 update them; verify in Task 1.11 below.)

- [ ] **Step 2: Check that SubmitForm/OrderReview compile errors are EXPECTED**

After Task 1.7, the MobileApp passes `onBack`, `editingLineIdx`, `existingLine`, `onEditLine` props that the current SubmitForm/OrderReview don't declare. To keep this commit shippable, add the props as optional in the existing signatures *without* using them yet — Groups 2 & 3 wire them up properly.

Modify `apps/frontend/src/pages/SubmitForm.tsx:7-14` (Props type):

Find:

```ts
type Props = {
  category: Category;
  detected: ScanResponse | null;
  lineCount: number;
  onSaveLine: (line: DraftLine) => void;
  onCancel: () => void;
  onRescan: () => void;
};
```

Replace with:

```ts
type Props = {
  category: Category;
  detected: ScanResponse | null;
  lineCount: number;
  editingLineIdx?: number | null;
  existingLine?: DraftLine;
  onSaveLine: (line: DraftLine) => void;
  onCancel: () => void;
  onBack?: () => void;
  onRescan: () => void;
};
```

Then update the destructure on line 19:

Find:

```ts
export function SubmitForm({ category, detected, lineCount, onSaveLine, onCancel, onRescan }: Props) {
```

Replace with:

```ts
export function SubmitForm({ category, detected, lineCount, onSaveLine, onCancel, onRescan, onBack: _onBack, editingLineIdx: _editingLineIdx, existingLine: _existingLine }: Props) {
```

The `_`-prefixed names quiet the "declared but never read" warnings until Group 3 wires them.

Modify `apps/frontend/src/pages/OrderReview.tsx:9-18` (Props type):

Find:

```ts
type Props = {
  category: Category;
  lines: DraftLine[];
  editingId?: string | null;
  onAddItem: () => void;
  onRemoveLine: (idx: number) => void;
  onUpdateLine: (idx: number, patch: Partial<DraftLine>) => void;
  onSubmit: (payload: { warehouseId: string; payment: 'company' | 'self'; notes: string; totalCost: number }) => Promise<void>;
  onCancel: () => void;
};
```

Replace with:

```ts
type Props = {
  category: Category;
  lines: DraftLine[];
  editingId?: string | null;
  onAddItem: () => void;
  onEditLine?: (idx: number) => void;
  onRemoveLine: (idx: number) => void;
  onUpdateLine?: (idx: number, patch: Partial<DraftLine>) => void;
  onSubmit: (payload: { warehouseId: string; payment: 'company' | 'self'; notes: string; totalCost: number }) => Promise<void>;
  onCancel: () => void;
};
```

Update the destructure on line 20-24:

Find:

```ts
export function OrderReview({
  category, lines, editingId,
  onAddItem, onRemoveLine, onUpdateLine,
  onSubmit, onCancel,
}: Props) {
```

Replace with:

```ts
export function OrderReview({
  category, lines, editingId,
  onAddItem, onRemoveLine, onUpdateLine, onEditLine: _onEditLine,
  onSubmit, onCancel,
}: Props) {
```

Then check `onUpdateLine` calls inside OrderReview. They currently call `onUpdateLine(i, { ... })` directly. Make them safe for the now-optional prop: replace every occurrence of `onUpdateLine(i, ` with `onUpdateLine?.(i, ` (a regex-safe find-replace). There are ~13 occurrences in OrderReview.tsx between lines 97-195. After this, the optional prop won't throw at runtime if a caller stops passing it.

Re-run typecheck:

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp && \
git add apps/frontend/src/styles/phone.css \
        apps/frontend/src/lib/usePhScrolled.ts \
        apps/frontend/src/lib/route.ts \
        apps/frontend/src/lib/i18n.tsx \
        apps/frontend/src/components/PhCategoryFields.tsx \
        apps/frontend/src/MobileApp.tsx \
        apps/frontend/src/pages/SubmitForm.tsx \
        apps/frontend/src/pages/OrderReview.tsx && \
git commit -m "$(cat <<'EOF'
feat(mobile): cross-cutting infra for design parity

Adds the foundation for the mobile parity pass:
- .cam-hint and .ph-info-banner CSS rules
- usePhScrolled hook (for the .ph-header.scrolled treatment)
- lib/route.ts hash-routing helpers (mobile + desktop will subscribe)
- PhCategoryFields shared component (will replace inline RAM/SSD/Other forms)
- CaptureState extended with editingLineIdx and returnTo so SubmitForm
  can double as an edit page and back-buttons can return to review
- i18n keys for upcoming groups

No user-visible change yet; subsequent groups wire these in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Group 2: Login + Dashboard parity (S1, S2)

### Task 2.1: Localize the mobile Login picker block

**Files:**
- Modify: `apps/frontend/src/pages/Login.tsx`

- [ ] **Step 1: Brand row uses i18n**

In `renderMobile()` (lines 238-329), find lines 244-247:

```tsx
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>Recycle Servers</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Inventory & Profit</div>
            </div>
```

Replace with:

```tsx
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{t('appBrand')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('brandSub')}</div>
            </div>
```

- [ ] **Step 2: "Loading demo accounts…" via i18n**

Find line 303:

```tsx
                  <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', padding: 14 }}>Loading demo accounts…</div>
```

Replace with:

```tsx
                  <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', padding: 14 }}>{t('loadingAccounts')}</div>
```

- [ ] **Step 3: Role subtitle + chip via i18n**

Find lines 309-317:

```tsx
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{u.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                        {u.role === 'manager' ? 'Manager · Full access' : 'Purchaser · Submit & view own'}
                      </div>
                    </div>
                    <span className="chip">
                      <Icon name={u.role === 'manager' ? 'shield' : 'user'} size={12} />
                      {u.role === 'manager' ? 'Admin' : 'Purchaser'}
                    </span>
```

Replace with:

```tsx
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{u.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                        {u.role === 'manager' ? t('managerFullAccess') : t('purchaserOwn')}
                      </div>
                    </div>
                    <span className="chip">
                      <Icon name={u.role === 'manager' ? 'shield' : 'user'} size={12} />
                      {u.role === 'manager' ? t('role_admin') : t('role_purchaser')}
                    </span>
```

- [ ] **Step 4: Back link uses `signInBack`**

Find line 322:

```tsx
                <Icon name="chevronLeft" size={11} /> {t('back')}
```

Replace with:

```tsx
                <Icon name="chevronLeft" size={11} /> {t('signInBack')}
```

### Task 2.2: Auto-transition signin → picker after successful first auth (optional polish)

The current behavior keeps `picking` local — refreshing returns to signin. The spec says "two-step" is the target; the existing flow already implements this via the `Continue as →` text button. Confirm by reading lines 278-284 — that's the trigger. The "after Continue, transition to picker" intent referred to design layout, not auth flow, since user is authenticated immediately on `submitEmail()`. No change required beyond Task 2.1.

### Task 2.3: Replace the hard-coded dashboard delta

**Files:**
- Modify: `apps/frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Use the new `vsLast30` i18n key**

Find line 77-79:

```tsx
          <div className="ph-kpi-trend" style={{ color: 'var(--pos)' }}>
            <Icon name="arrowUp" size={11} /> 12.4% vs last 30d
          </div>
```

Replace with:

```tsx
          <div className="ph-kpi-trend" style={{ color: 'var(--pos)' }}>
            <Icon name="arrowUp" size={11} /> {t('vsLast30', { pct: '—' })}
          </div>
```

(The literal `'—'` is a placeholder until backend provides a real delta. The visual treatment remains.)

### Task 2.4: Wire scroll-shadow to Dashboard's custom header

**Files:**
- Modify: `apps/frontend/src/pages/Dashboard.tsx`

- [ ] **Step 1: Add the hook import and ref**

At the top of `Dashboard.tsx`, change the imports (line 1-2):

Find:

```tsx
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
```

Replace with:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { usePhScrolled } from '../lib/usePhScrolled';
```

- [ ] **Step 2: Use the hook and apply the class**

Inside the `Dashboard()` function body, find line 28:

```tsx
  const isManager = user.role === 'manager';
```

Immediately above it, add:

```tsx
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);
```

Find the header opening div (line 36):

```tsx
      <div className="ph-header">
```

Replace with:

```tsx
      <div className={'ph-header' + (scrolled ? ' scrolled' : '')}>
```

Find the scroll container opening div (line 60):

```tsx
      <div className="ph-scroll">
```

Replace with:

```tsx
      <div className="ph-scroll" ref={scrollRef}>
```

### Task 2.5: Verify and commit Group 2

- [ ] **Step 1: Typecheck**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 2: Manual check (dev server)**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend dev
```

Open the app on a phone-width viewport (or DevTools device mode):
- Login screen: brand row reads "Recycle Servers" / "Inventory & Profit"; switch language → reads "回收服务器" / equivalent (ZH dict must include those keys).
- Click "Continue as →" → picker loads. Role chip reads "Admin"/"Purchaser" in EN; "管理员"/"采购员" in ZH.
- Dashboard: scroll past 4px → header gets backdrop blur + bottom border. Scroll back → border fades.
- Dashboard KPI hero trend reads "— vs last 30d" (the em dash is intentional pending real data).

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp && \
git add apps/frontend/src/pages/Login.tsx apps/frontend/src/pages/Dashboard.tsx && \
git commit -m "$(cat <<'EOF'
feat(mobile): login picker + dashboard parity (S1, S2)

- Mobile login picker copy now flows through i18n (brand, role
  subtitles, role chips, back button).
- Dashboard's hard-coded "12.4% vs last 30d" is replaced with
  the t('vsLast30') key, value pending backend.
- Dashboard custom header now picks up the scroll-shadow treatment
  via usePhScrolled.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Group 3: Capture flow + unified line-edit (S3a–S3d)

The largest group. Reorders the line-edit flow: tap a line in review → open SubmitForm. Inline expansion is removed from OrderReview.

### Task 3.1: Camera screen — wire flash, switch-camera, i18n

**Files:**
- Modify: `apps/frontend/src/pages/Camera.tsx`

- [ ] **Step 1: Extend Props with `onBack`**

Find lines 7-11:

```tsx
type Props = {
  category: Category;
  onDetected: (s: ScanResponse) => void;
  onClose: () => void;
};
```

Replace with:

```tsx
type Props = {
  category: Category;
  onDetected: (s: ScanResponse) => void;
  onClose: () => void;
  onBack?: () => void;
};
```

- [ ] **Step 2: Add flash & facingMode state, plus a stream-start helper**

Replace the body of `export function Camera(...)` from line 20 down through line 56 (end of the `useEffect` that starts the stream) with:

```tsx
export function Camera({ category, onDetected, onClose, onBack }: Props) {
  const { t } = useT();
  const [phase, setPhase] = useState<Phase>('framing');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Start (or restart) the camera with the current facingMode. Called once on
  // mount and again whenever the user flips the camera.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      // Stop any active stream before requesting a new one.
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch {
        // Fine — we'll show the illustrated viewfinder instead.
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, [facingMode]);

  // Apply the torch constraint when flash toggles. Most desktop browsers and
  // some mobile front-cameras don't support torch — we swallow the rejection.
  useEffect(() => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track || typeof track.applyConstraints !== 'function') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    track.applyConstraints({ advanced: [{ torch: flash === 'on' } as any] }).catch(() => {});
  }, [flash]);
```

- [ ] **Step 3: Wire the top-bar buttons**

Find lines 112-121:

```tsx
      <div className="ph-cam-top">
        <button onClick={onClose} className="ph-cam-pill" style={{ background: 'rgba(255,255,255,0.12)' }}>
          <Icon name="x" size={14} />
        </button>
        <span className="ph-cam-pill">
          <span className="ai-dot" /> {t('aiScan')} · {category}
        </span>
        <button className="ph-cam-pill" style={{ background: 'rgba(255,255,255,0.12)', width: 36, padding: 0, height: 30, justifyContent: 'center' }}>
          <Icon name="flash" size={14} />
        </button>
      </div>
```

Replace with:

```tsx
      <div className="ph-cam-top">
        <button
          onClick={onBack ?? onClose}
          className="ph-cam-pill"
          style={{ background: 'rgba(255,255,255,0.12)' }}
          title={onBack ? t('signInBack') : t('cancel')}
        >
          <Icon name="x" size={14} />
        </button>
        <span className="ph-cam-pill">
          <span className="ai-dot" /> {t('aiScan')} · {category}
        </span>
        <button
          className="ph-cam-pill"
          style={{ background: flash === 'on' ? 'rgba(255,220,80,0.85)' : 'rgba(255,255,255,0.12)', width: 36, padding: 0, height: 30, justifyContent: 'center', color: flash === 'on' ? '#1a1300' : 'white' }}
          onClick={() => setFlash(f => f === 'on' ? 'off' : 'on')}
          title={t('cameraFlash')}
        >
          <Icon name="flash" size={14} />
        </button>
      </div>
```

- [ ] **Step 4: Wire the bottom-right switch-camera button**

Find lines 192-204:

```tsx
      <div className="ph-cam-bottom">
        <button className="ph-cam-thumbsq" onClick={onUpload} title="Upload from library">
          <Icon name="upload" size={16} />
        </button>
        <button
          className="ph-cam-shutter"
          onClick={onShoot}
          disabled={phase !== 'framing'}
        />
        <button className="ph-cam-thumbsq" title="Switch camera">
          <Icon name="rotate" size={16} />
        </button>
      </div>
```

Replace with:

```tsx
      <div className="ph-cam-bottom">
        <button className="ph-cam-thumbsq" onClick={onUpload} title={t('cameraUpload')}>
          <Icon name="upload" size={16} />
        </button>
        <button
          className="ph-cam-shutter"
          onClick={onShoot}
          disabled={phase !== 'framing'}
        />
        <button
          className="ph-cam-thumbsq"
          onClick={() => setFacingMode(m => m === 'environment' ? 'user' : 'environment')}
          title={t('cameraSwitch')}
        >
          <Icon name="rotate" size={16} />
        </button>
      </div>
```

### Task 3.2: SubmitForm — full rewrite as new-or-edit page

**Files:**
- Modify: `apps/frontend/src/pages/SubmitForm.tsx` — full file rewrite

- [ ] **Step 1: Replace the file with the unified version**

Overwrite `apps/frontend/src/pages/SubmitForm.tsx` with:

```tsx
import { useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { PhCategoryFields } from '../components/PhCategoryFields';
import { useT } from '../lib/i18n';
import type { Category, DraftLine, ScanResponse } from '../lib/types';

type Props = {
  category: Category;
  detected: ScanResponse | null;
  lineCount: number;
  editingLineIdx?: number | null;
  existingLine?: DraftLine;
  onSaveLine: (line: DraftLine) => void;
  onCancel: () => void;
  onBack?: () => void;
  onRescan: () => void;
};

const blankDefaults = (category: Category): DraftLine => ({
  category,
  brand: null,
  capacity: null,
  type: null,
  classification: null,
  rank: null,
  speed: null,
  interface: null,
  formFactor: null,
  description: null,
  partNumber: '',
  qty: 1,
  unitCost: 0,
  sellPrice: null,
  condition: 'Pulled — Tested',
  scanImageId: null,
  scanConfidence: null,
});

const aiDefaults = (category: Category, scan: ScanResponse): DraftLine => {
  const f = scan.extracted ?? {};
  return {
    category,
    brand:          (f.brand as string)          ?? null,
    capacity:       (f.capacity as string)       ?? null,
    type:           (f.type as string)           ?? null,
    classification: (f.classification as string) ?? null,
    rank:           (f.rank as string)           ?? null,
    speed:          (f.speed as string)          ?? null,
    interface:      (f.interface as string)      ?? null,
    formFactor:     (f.formFactor as string)     ?? null,
    description:    (f.description as string)    ?? null,
    partNumber:     (f.partNumber as string)     ?? '',
    qty: 1,
    unitCost: 0,
    sellPrice: null,
    condition: 'Pulled — Tested',
    scanImageId: scan.imageId ?? null,
    scanConfidence: scan.confidence ?? null,
  };
};

export function SubmitForm({ category, detected, lineCount, editingLineIdx, existingLine, onSaveLine, onCancel, onBack, onRescan }: Props) {
  const { t } = useT();
  const isEditing = editingLineIdx != null;
  const aiFilled = !!detected && !isEditing;
  const isFirst = lineCount === 0 && !isEditing;

  // Initial form values:
  //   - Editing an existing line → start from that line's values, optionally
  //     overlaid by AI-extracted fields (when re-scanning) but never the
  //     scalar fields (qty/cost/sell/condition).
  //   - New line + AI scan → fields from the scan, scalars left at sensible
  //     blanks.
  //   - New line, manual → all blank.
  const initial: DraftLine = isEditing && existingLine
    ? (detected
        ? { ...existingLine, ...aiDefaults(category, detected), qty: existingLine.qty, unitCost: existingLine.unitCost, sellPrice: existingLine.sellPrice, condition: existingLine.condition }
        : existingLine)
    : (detected ? aiDefaults(category, detected) : blankDefaults(category));

  const [line, setLine] = useState<DraftLine>(initial);
  const set = <K extends keyof DraftLine>(k: K, v: DraftLine[K]) => setLine(prev => ({ ...prev, [k]: v }));

  const buildLabel = (): string => {
    if (line.category === 'RAM') return [line.brand, line.capacity, line.type].filter(Boolean).join(' ');
    if (line.category === 'SSD') return [line.brand, line.capacity, line.interface].filter(Boolean).join(' ');
    return line.description ?? 'Item';
  };

  const save = () => onSaveLine({ ...line, label: buildLabel(), partNumber: line.partNumber || '—' });

  // Header text:
  //   - Edit mode:  "Edit RAM item" / sub = existing label
  //   - First-item new order: "New RAM order" / sub = AI-review or fill-in
  //   - Nth-item new order:  "Add RAM item" / sub = "Item N · adding..."
  const title = isEditing
    ? (category === 'RAM' ? t('editRamItem') : category === 'SSD' ? t('editSsdItem') : t('editOtherItem'))
    : isFirst
      ? (category === 'RAM' ? t('newRamOrder') : category === 'SSD' ? t('newSsdOrder') : t('newOtherOrder'))
      : (category === 'RAM' ? t('addRamItem')  : category === 'SSD' ? t('addSsdItem')  : t('addOtherItem'));

  const sub = isEditing
    ? buildLabel()
    : isFirst
      ? (aiFilled ? t('aiReview') : t('fillIn'))
      : t('addingItem', { n: lineCount + 1 });

  return (
    <div className="phone-app">
      <PhHeader
        title={title}
        sub={sub}
        leading={
          <button className="ph-icon-btn" onClick={onBack ?? onCancel}>
            <Icon name="chevronLeft" size={16} />
          </button>
        }
        trailing={category === 'RAM' && (
          <button className="ph-icon-btn" onClick={onRescan} title={t('rescanWithAi')}>
            <Icon name="camera" size={16} />
          </button>
        )}
      />
      <div className="ph-scroll" style={{ paddingBottom: 110 }}>
        {aiFilled && (
          <div className="ph-ai-banner" style={{ borderRadius: 12, marginTop: 6 }}>
            <span className="pill-ai">AI</span>
            <span>{t('extractedConf', { pct: Math.round((detected!.confidence) * 100) })}</span>
            <Icon name="sparkles" size={13} style={{ marginLeft: 'auto' }} />
          </div>
        )}

        <PhCategoryFields category={category} value={line} onChange={set} aiFilled={aiFilled} />

        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('quantity')}</label>
            <input className="input" type="number" min={1} value={line.qty} onChange={e => set('qty', parseInt(e.target.value, 10) || 0)} />
          </div>
          <div className="ph-field">
            <label>{t('condition')}</label>
            <select className="select" value={line.condition ?? 'Pulled — Tested'} onChange={e => set('condition', e.target.value)}>
              <option>New</option><option>Pulled — Tested</option><option>Pulled — Untested</option><option>Used</option>
            </select>
          </div>
        </div>

        <div className={isEditing ? 'ph-field-row' : ''}>
          <div className="ph-field">
            <label>{t('unitCost')}</label>
            <input className="input mono" type="number" step="0.01" min={0} value={line.unitCost} onChange={e => set('unitCost', parseFloat(e.target.value) || 0)} />
          </div>
          {isEditing && (
            <div className="ph-field">
              <label>{t('sellPrice')}</label>
              <input
                className="input mono"
                type="number"
                step="0.01"
                min={0}
                value={line.sellPrice ?? ''}
                placeholder="—"
                onChange={e => set('sellPrice', e.target.value === '' ? null : parseFloat(e.target.value) || 0)}
              />
            </div>
          )}
        </div>
      </div>

      <div className="ph-action-bar">
        <button className="ph-btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button className="ph-btn dark" onClick={save}>
          <Icon name="check" size={16} /> {isEditing ? t('saveChanges') : (isFirst ? t('addToOrder') : t('addItem'))}
        </button>
      </div>
    </div>
  );
}
```

### Task 3.3: OrderReview — remove inline expand-to-edit

**Files:**
- Modify: `apps/frontend/src/pages/OrderReview.tsx`

- [ ] **Step 1: Update Props and destructure**

Find lines 9-24 (Props + function signature). Replace with:

```tsx
type Props = {
  category: Category;
  lines: DraftLine[];
  editingId?: string | null;
  onAddItem: () => void;
  onEditLine: (idx: number) => void;
  onRemoveLine: (idx: number) => void;
  onSubmit: (payload: { warehouseId: string; payment: 'company' | 'self'; notes: string; totalCost: number }) => Promise<void>;
  onCancel: () => void;
};

export function OrderReview({
  category, lines, editingId,
  onAddItem, onEditLine, onRemoveLine,
  onSubmit, onCancel,
}: Props) {
```

- [ ] **Step 2: Remove the local `editingIdx` state**

Find line 31:

```tsx
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
```

Delete this line.

- [ ] **Step 3: Replace the entire line list (lines 68-208) with a tap-to-edit version**

Find this block — `<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>` through the matching `</div>` that closes the lines map (lines 68 to ~208). It will look like:

```tsx
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lines.map((l, i) => {
            const isEditing = editingIdx === i;
            return (
              <div key={i} className="ph-line">
                ...lots of inline editing JSX...
              </div>
            );
          })}
        </div>
```

Replace with:

```tsx
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lines.map((l, i) => (
            <div
              key={i}
              className="ph-line"
              onClick={() => onEditLine(i)}
              style={{ cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="lb-rank" style={{ width: 22, height: 22, fontSize: 11 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.label || '—'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>{l.partNumber || '—'}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onEditLine(i); }}
                  className="ph-icon-btn"
                  style={{ width: 28, height: 28, color: 'var(--fg-subtle)' }}
                  aria-label={t('edit')}
                >
                  <Icon name="edit" size={13} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemoveLine(i); }}
                  className="ph-icon-btn"
                  style={{ width: 28, height: 28, color: 'var(--fg-subtle)' }}
                  aria-label={t('delete')}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                <span>Qty {l.qty} · unit {fmtUSD(l.unitCost)}</span>
                <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(l.unitCost * l.qty)}</span>
              </div>
            </div>
          ))}
        </div>
```

- [ ] **Step 4: Remove the now-unused `useState` import (if applicable)**

After the changes, OrderReview still uses `useState` for warehouses, payment, notes, totalCost, submitting. Leave the import alone.

- [ ] **Step 5: Remove the `onUpdateLine` prop entirely**

Search OrderReview.tsx for any remaining references to `onUpdateLine` — there should be none after Step 3. If any remain, delete them.

### Task 3.4: Verify and commit Group 3

- [ ] **Step 1: Typecheck**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 2: Manual flow check (dev server)**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend dev
```

In phone mode:
1. Tap center FAB → pick RAM → camera opens.
   - Tap flash icon — pill background flips yellow.
   - Tap rotate icon — `getUserMedia` reinitializes (you'll see a brief flash).
   - Tap X (back) — returns to dashboard (because `returnTo: 'idle'`).
2. New flow: FAB → RAM → camera shoot → form opens with AI banner; values prefilled (assuming the stub OCR returns fields). Tap "Add to order" → review.
3. From review, tap the first line — SubmitForm opens with title "Edit RAM item", sub showing the line label, sell-price field visible, action button labeled "Save changes".
   - Change quantity, tap "Save changes" → returns to review with updated qty.
4. From review, tap "+ Add another RAM item" — SubmitForm opens as new (no edit mode), back button (top-left chevron) returns to review (not dashboard). Compare with: first-item form (capture flow), where back returns to dashboard.
5. From review's edit mode, tap the camera rescan icon (top-right) — camera opens, returns to the edit form with AI values merged but qty/cost preserved.

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp && \
git add apps/frontend/src/pages/Camera.tsx \
        apps/frontend/src/pages/SubmitForm.tsx \
        apps/frontend/src/pages/OrderReview.tsx && \
git commit -m "$(cat <<'EOF'
feat(mobile): unified line-edit page + camera polish (S3)

- Camera: flash and switch-camera buttons are now functional. All
  title attributes localized.
- SubmitForm: now doubles as the line-edit page. Tap any line in
  OrderReview to open it pre-filled, with sell-price visible and a
  "Save changes" CTA. AI rescan works in both new and edit modes
  and merges values without clobbering qty / cost / sellPrice.
- OrderReview: inline expand-to-edit form removed. Line cards stay
  compact; tap or pencil-tap pushes to SubmitForm. Trash icon
  unchanged. Eliminates ~110 lines of duplicated RAM/SSD/Other
  field markup.
- Back-button on Add Item now returns to review (not dashboard)
  when adding the Nth item; first-item flow still exits to idle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Group 4: Orders + Market + Inventory (S4–S6) + mobile deep-link UX

### Task 4.1: Orders — search toggle, scroll-shadow, deep-link, link-icon

**Files:**
- Modify: `apps/frontend/src/pages/Orders.tsx`

- [ ] **Step 1: Update imports**

Replace lines 1-8 (imports) with:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { fmtUSD, fmtUSD0, fmtDateShort } from '../lib/format';
import { ORDER_STATUSES, isCompleted, statusTone } from '../lib/status';
import { usePhScrolled } from '../lib/usePhScrolled';
import { useRoute, match, navigate } from '../lib/route';
import type { OrderSummary, Order } from '../lib/types';
```

- [ ] **Step 2: Add prop for toast helper**

Find lines 10-12 (Props type):

```tsx
type Props = {
  onEdit: (o: Order) => void;
};
```

Replace with:

```tsx
type Props = {
  onEdit: (o: Order) => void;
  onToast?: (msg: string) => void;
};
```

- [ ] **Step 3: Add state for search, refs, route, deep-link**

Find lines 14-21 (start of function body):

```tsx
export function Orders({ onEdit }: Props) {
  const { t } = useT();
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'Other'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openLines, setOpenLines] = useState<Order | null>(null);
```

Replace with:

```tsx
export function Orders({ onEdit, onToast }: Props) {
  const { t } = useT();
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'Other'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openLines, setOpenLines] = useState<Order | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);
  const { path } = useRoute();
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
```

- [ ] **Step 4: Filter by search query alongside chips**

Find the `orders.slice(0, 30).map(o => {` line (around line 71). Just before that line, insert a filtered list:

```tsx
        {(() => null)()}
```

(no-op marker — actual replacement next). Then replace the `{orders.slice(0, 30).map(o => {` opening with:

```tsx
        {(() => {
          const q = searchQ.trim().toLowerCase();
          const filtered = q
            ? orders.filter(o =>
                o.id.toLowerCase().includes(q) ||
                (o.warehouse?.short ?? '').toLowerCase().includes(q) ||
                (o.warehouse?.region ?? '').toLowerCase().includes(q) ||
                o.userName.toLowerCase().includes(q)
              )
            : orders;
          return filtered.slice(0, 30).map(o => {
```

And the closing `})}` at the end of the map (around line 137) becomes:

```tsx
          });
        })()}
```

- [ ] **Step 5: Deep-link effect — expand matching order on route match**

Insert immediately after the existing `useEffect` for `openId` (around line 37):

```tsx
  // CC-5: when the URL matches /orders/:id, expand that row and (if
  // editable) push to the review screen. Fires whenever route or the
  // currently-loaded list changes.
  useEffect(() => {
    const m = match('/orders/:id', path);
    if (!m) return;
    setOpenId(m.id);
    const node = rowRefs.current[m.id];
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const summary = orders.find(o => o.id === m.id);
    if (summary && !isCompleted(summary.status)) {
      // Fetch the full order to pass to onEdit (it expects the lines).
      api.get<{ order: Order }>(`/api/orders/${m.id}`).then(r => onEdit(r.order)).catch(() => {});
    }
    // Eslint: omitting onEdit on purpose — the parent provides a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, orders]);
```

- [ ] **Step 6: Use scrolled prop + trailing search button**

Find lines 41-45 (PhHeader call):

```tsx
      <PhHeader
        title={t('ordersHeading')}
        sub={t('ordersSubmitted', { n: orders.length })}
        trailing={<button className="ph-icon-btn"><Icon name="search" size={16} /></button>}
      />
```

Replace with:

```tsx
      <PhHeader
        title={t('ordersHeading')}
        sub={t('ordersSubmitted', { n: orders.length })}
        scrolled={scrolled}
        trailing={
          <button
            className="ph-icon-btn"
            onClick={() => setSearchOpen(o => !o)}
            aria-label={t('searchOrders')}
            style={{ color: searchOpen ? 'var(--accent-strong)' : undefined }}
          >
            <Icon name={searchOpen ? 'x' : 'search'} size={16} />
          </button>
        }
      />
```

- [ ] **Step 7: Add scroll ref and search row**

Find line 46:

```tsx
      <div className="ph-scroll">
```

Replace with:

```tsx
      <div className="ph-scroll" ref={scrollRef}>
        {searchOpen && (
          <div className="ph-field" style={{ marginTop: 6 }}>
            <input
              className="input"
              autoFocus
              placeholder={t('searchOrders')}
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
        )}
```

- [ ] **Step 8: Add link icon next to the order ID, with row ref**

In the order-head block, find lines 74-82:

```tsx
            <div key={o.id} className="ph-order">
              <div className="ph-order-head" onClick={() => setOpenId(isOpen ? null : o.id)} style={{ cursor: 'pointer' }}>
                <span className={'chip ' + (o.category === 'RAM' ? 'info' : o.category === 'SSD' ? 'pos' : 'warn')} style={{ minWidth: 42, justifyContent: 'center' }}>
                  {o.category}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{o.id}</span>
                    <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>· {o.lineCount} {o.lineCount === 1 ? t('item') : t('items')}</span>
                  </div>
```

Replace with:

```tsx
            <div key={o.id} className="ph-order" ref={el => { rowRefs.current[o.id] = el; }}>
              <div className="ph-order-head" onClick={() => setOpenId(isOpen ? null : o.id)} style={{ cursor: 'pointer' }}>
                <span className={'chip ' + (o.category === 'RAM' ? 'info' : o.category === 'SSD' ? 'pos' : 'warn')} style={{ minWidth: 42, justifyContent: 'center' }}>
                  {o.category}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{o.id}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const url = `${location.origin}${location.pathname}#/orders/${o.id}`;
                        const share = (navigator as Navigator & { share?: (data: { url: string; title: string }) => Promise<void> }).share;
                        if (typeof share === 'function') {
                          share.call(navigator, { url, title: t('shareOrder') }).catch(() => {});
                        } else {
                          navigator.clipboard?.writeText(url).then(() => onToast?.(t('orderIdCopied'))).catch(() => {});
                        }
                      }}
                      aria-label={t('shareOrder')}
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-subtle)', padding: 0, lineHeight: 0, cursor: 'pointer' }}
                    >
                      <Icon name="paperclip" size={12} />
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>· {o.lineCount} {o.lineCount === 1 ? t('item') : t('items')}</span>
                  </div>
```

- [ ] **Step 9: When user taps edit, also sync the route**

Find line 119-128 (the Edit button inside the expanded body):

```tsx
                    <button
                      className="btn sm"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={isCompleted(o.status)}
                      title={isCompleted(o.status) ? t('completedLocked') : t('editOrder')}
                      onClick={(e) => { e.stopPropagation(); if (!isCompleted(o.status)) onEdit(openLines); }}
                    >
                      <Icon name="edit" size={11} /> {t('edit')}
                    </button>
```

Replace with:

```tsx
                    <button
                      className="btn sm"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={isCompleted(o.status)}
                      title={isCompleted(o.status) ? t('completedLocked') : t('editOrder')}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isCompleted(o.status)) {
                          navigate('/orders/' + o.id);
                          onEdit(openLines);
                        }
                      }}
                    >
                      <Icon name="edit" size={11} /> {t('edit')}
                    </button>
```

### Task 4.2: Plumb `onToast` from MobileApp to Orders

**Files:**
- Modify: `apps/frontend/src/MobileApp.tsx`

- [ ] **Step 1: Pass `onToast` to Orders**

Find the Orders rendering in MobileApp's main return (around line 232):

```tsx
      {view === 'history' && <Orders onEdit={startEdit} />}
```

Replace with:

```tsx
      {view === 'history' && <Orders onEdit={startEdit} onToast={(msg) => showToast(msg)} />}
```

### Task 4.3: Market — scroll-shadow

**Files:**
- Modify: `apps/frontend/src/pages/Market.tsx`

- [ ] **Step 1: Add hook**

Update imports (line 1):

```tsx
import { useEffect, useRef, useState } from 'react';
```

Add after the existing imports:

```tsx
import { usePhScrolled } from '../lib/usePhScrolled';
```

- [ ] **Step 2: Use scrolled state**

Find lines 9-15 (start of the function body):

```tsx
export function Market() {
  const { t } = useT();
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'Other'>('all');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<RefPrice[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
```

Add after the existing state:

```tsx
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);
```

Find line 33 (PhHeader):

```tsx
      <PhHeader title={t('marketTitle')} sub={t('marketSub', { n: items.length })} />
```

Replace with:

```tsx
      <PhHeader title={t('marketTitle')} sub={t('marketSub', { n: items.length })} scrolled={scrolled} />
```

Find line 34:

```tsx
      <div className="ph-scroll">
```

Replace with:

```tsx
      <div className="ph-scroll" ref={scrollRef}>
```

### Task 4.4: Inventory — scroll-shadow + `.ph-info-banner`

**Files:**
- Modify: `apps/frontend/src/pages/Inventory.tsx`

- [ ] **Step 1: Add hook**

Update imports (line 1):

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
```

Add after the existing imports:

```tsx
import { usePhScrolled } from '../lib/usePhScrolled';
```

- [ ] **Step 2: Use scrolled and the new info banner class**

Find lines 30-42 (function start):

```tsx
export function Inventory({ onNewEntry }: Props) {
  const { t } = useT();
  const { user } = useAuth();
  const [filter, setFilter] = useState<'all' | 'RAM' | 'SSD' | 'Other'>('all');
  const [items, setItems] = useState<InventoryItem[]>([]);
```

Add after that state block:

```tsx
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);
```

Find line 57-61 (PhHeader call):

```tsx
      <PhHeader
        title={t('inventoryTitle')}
        sub={isManager ? t('invAcrossTeams') : t('invItemsYou')}
        trailing={<button className="ph-icon-btn" onClick={onNewEntry}><Icon name="plus" size={16} /></button>}
      />
```

Replace with:

```tsx
      <PhHeader
        title={t('inventoryTitle')}
        sub={isManager ? t('invAcrossTeams') : t('invItemsYou')}
        scrolled={scrolled}
        trailing={<button className="ph-icon-btn" onClick={onNewEntry}><Icon name="plus" size={16} /></button>}
      />
```

Find line 62:

```tsx
      <div className="ph-scroll">
```

Replace with:

```tsx
      <div className="ph-scroll" ref={scrollRef}>
```

Find lines 63-74 (the read-only banner):

```tsx
        {!isManager && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '10px 12px',
            background: 'var(--info-soft)',
            border: '1px solid color-mix(in oklch, var(--info) 25%, transparent)',
            borderRadius: 12, marginTop: 4, fontSize: 12,
          }}>
            <Icon name="lock" size={14} style={{ color: 'var(--info)', marginTop: 1, flexShrink: 0 }} />
            <div>{t('readonlyMgr')}</div>
          </div>
        )}
```

Replace with:

```tsx
        {!isManager && (
          <div className="ph-info-banner" style={{ marginTop: 4 }}>
            <Icon name="lock" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
            <div>{t('readonlyMgr')}</div>
          </div>
        )}
```

### Task 4.5: Verify and commit Group 4

- [ ] **Step 1: Typecheck**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 2: Manual check (dev server)**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend dev
```

- Open `http://localhost:5173/#/orders/<some-existing-id>` → orders tab opens with that row expanded and (if editable) review screen opens automatically.
- On the orders list, tap the small paperclip icon next to an order ID → toast "Order link copied" appears; clipboard contains `…/#/orders/<id>`.
- Tap the search icon (top-right of orders) → search row slides in; type "SO" or a warehouse short code → list filters live. Tap X (same icon, now an X) to close.
- Scroll Orders / Market / Inventory past 4px → headers gain backdrop blur + border. Inventory's purchaser-only read-only banner uses the unified `.ph-info-banner` style.

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp && \
git add apps/frontend/src/pages/Orders.tsx \
        apps/frontend/src/pages/Market.tsx \
        apps/frontend/src/pages/Inventory.tsx \
        apps/frontend/src/MobileApp.tsx && \
git commit -m "$(cat <<'EOF'
feat(mobile): orders search + deep-link + scroll-shadow polish (S4-S6)

- Orders: trailing search icon now toggles an in-page search input
  that filters loaded orders by id, warehouse, or submitter. Deep
  links (#/orders/:id) expand the matching row, scroll it into view,
  and open the edit screen for non-completed orders. A new paperclip
  icon next to each order id copies (or shares) the deep link, with
  toast confirmation.
- Market, Inventory: scroll-shadow header treatment wired through
  usePhScrolled.
- Inventory: read-only-manager banner switched to the shared
  .ph-info-banner primitive.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Group 5: Profile + sheets (S7, S8, S9)

### Task 5.1: New file — `components/PhAboutSheet.tsx`

**Files:**
- Create: `apps/frontend/src/components/PhAboutSheet.tsx`

- [ ] **Step 1: Write the sheet**

```tsx
import { Icon } from './Icon';
import { useT } from '../lib/i18n';

type Props = {
  onClose: () => void;
};

const VERSION = '2026.4.2';
const BUILD = 'mobile.r1';
const SUPPORT_EMAIL = 'support@recycleservers.io';

export function PhAboutSheet({ onClose }: Props) {
  const { t } = useT();
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onClose} />
      <div className="ph-sheet" style={{ paddingBottom: 24 }}>
        <div className="ph-sheet-grabber" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 14px' }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('aboutSheetTitle')}</div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--accent-strong)', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', padding: 4, cursor: 'pointer' }}
          >
            {t('aboutClose')}
          </button>
        </div>

        <div className="ph-card" style={{ padding: '4px 0' }}>
          <Row label={t('aboutVersion')} value={VERSION} />
          <Row label={t('aboutBuild')} value={BUILD} divider={false} />
        </div>

        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            marginTop: 12, padding: '12px 14px',
            background: 'var(--bg-elev)', border: '1px solid var(--border)',
            borderRadius: 12, textDecoration: 'none', color: 'var(--fg)',
          }}
        >
          <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent-soft)', display: 'grid', placeItems: 'center', color: 'var(--accent-strong)' }}>
            <Icon name="mail" size={15} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t('aboutSupport')}</div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{SUPPORT_EMAIL}</div>
          </div>
          <Icon name="chevronRight" size={14} style={{ color: 'var(--fg-subtle)' }} />
        </a>
      </div>
    </>
  );
}

function Row({ label, value, divider = true }: { label: string; value: string; divider?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 14px',
      borderBottom: divider ? '1px solid var(--border)' : 'none',
    }}>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
```

### Task 5.2: Profile — wire all row actions

**Files:**
- Modify: `apps/frontend/src/pages/Profile.tsx`

- [ ] **Step 1: Update Props**

Find lines 11-13:

```tsx
type Props = {
  onOpenLanguage: () => void;
};
```

Replace with:

```tsx
type Props = {
  onOpenLanguage: () => void;
  onOpenNotifications: () => void;
  onOpenAbout: () => void;
  onOpenSecurity: () => void;
};
```

- [ ] **Step 2: Wire onClick handlers in the items array**

Find lines 27-40 (the items array):

```tsx
  const items: Item[] = [
    { id: 'notif', icon: 'bell', label: t('notifications'), sub: t('notificationsSub') },
    { id: 'sec',   icon: 'lock', label: t('security'),      sub: t('securitySub') },
    {
      id: 'lang',  icon: 'globe', label: t('language'),     sub: lang === 'zh' ? '简体中文' : 'English',
      trailing: (
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--accent-strong)', fontWeight: 600 }}>{lang === 'zh' ? 'ZH' : 'EN'}</span>
        </span>
      ),
      onClick: onOpenLanguage,
    },
    { id: 'about', icon: 'info', label: t('about'),         sub: t('aboutSub') },
  ];
```

Replace with:

```tsx
  const items: Item[] = [
    { id: 'notif', icon: 'bell', label: t('notifications'), sub: t('notificationsSub'), onClick: onOpenNotifications },
    { id: 'sec',   icon: 'lock', label: t('security'),      sub: t('securitySub'),      onClick: onOpenSecurity },
    {
      id: 'lang',  icon: 'globe', label: t('language'),     sub: lang === 'zh' ? '简体中文' : 'English',
      trailing: (
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--accent-strong)', fontWeight: 600 }}>{lang === 'zh' ? 'ZH' : 'EN'}</span>
        </span>
      ),
      onClick: onOpenLanguage,
    },
    { id: 'about', icon: 'info', label: t('about'),         sub: t('aboutSub'),         onClick: onOpenAbout },
  ];
```

- [ ] **Step 3: Update Profile's destructure signature**

Find line 15:

```tsx
export function Profile({ onOpenLanguage }: Props) {
```

Replace with:

```tsx
export function Profile({ onOpenLanguage, onOpenNotifications, onOpenAbout, onOpenSecurity }: Props) {
```

### Task 5.3: PhNotificationsSheet — localize copy

**Files:**
- Modify: `apps/frontend/src/components/PhNotificationsSheet.tsx`

- [ ] **Step 1: Add i18n import + hook**

Find lines 1-2:

```tsx
import { Icon, type IconName } from './Icon';
import type { Notification } from '../lib/types';
```

Add after:

```tsx
import { useT } from '../lib/i18n';
```

- [ ] **Step 2: Use t() in the component**

Find line 37:

```tsx
export function PhNotificationsSheet({ items, onClose, onMarkAllRead }: Props) {
  const unreadCount = items.filter(n => n.unread).length;
```

Replace with:

```tsx
export function PhNotificationsSheet({ items, onClose, onMarkAllRead }: Props) {
  const { t } = useT();
  const unreadCount = items.filter(n => n.unread).length;
```

Find line 46:

```tsx
            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>Notifications</div>
```

Replace with:

```tsx
            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('notifTitle')}</div>
```

Find line 48:

```tsx
              {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
```

Replace with:

```tsx
              {unreadCount > 0 ? t('notifNUnread', { n: unreadCount }) : t('notifAllCaught')}
```

Find line 60:

```tsx
              Mark all read
```

Replace with:

```tsx
              {t('notifMarkAllRead')}
```

Find lines 112-116:

```tsx
        <div style={{
          textAlign: 'center', fontSize: 11.5, color: 'var(--fg-subtle)',
          padding: '12px 0 4px', borderTop: '1px solid var(--border)', marginTop: 4,
        }}>
          Manage alert types in Profile · Notifications
        </div>
```

Replace with:

```tsx
        <div style={{
          textAlign: 'center', fontSize: 11.5, color: 'var(--fg-subtle)',
          padding: '12px 0 4px', borderTop: '1px solid var(--border)', marginTop: 4,
        }}>
          {t('notifManageHint')}
        </div>
```

### Task 5.4: PhLanguageSheet — persist Follow-System and apply on mount

**Files:**
- Modify: `apps/frontend/src/components/PhLanguageSheet.tsx`

- [ ] **Step 1: Make follow-system stateful and load from localStorage**

Find lines 8-11:

```tsx
export function PhLanguageSheet({ onClose }: Props) {
  const { lang, setLang, t } = useT();
  const [draft, setDraft] = useState<Lang>(lang);
  const [followSystem, setFollowSystem] = useState(false);
```

Replace with:

```tsx
const LS_KEY = 'rs.langFollowSystem';

function systemLang(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const n = (navigator.language || 'en').toLowerCase();
  return n.startsWith('zh') ? 'zh' : 'en';
}

export function PhLanguageSheet({ onClose }: Props) {
  const { lang, setLang, t } = useT();
  const [draft, setDraft] = useState<Lang>(lang);
  const [followSystem, setFollowSystem] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; }
  });
```

- [ ] **Step 2: Persist on toggle and override draft when on**

Find line 13:

```tsx
  const apply = () => { setLang(draft); onClose(draft); };
```

Replace with:

```tsx
  const apply = () => {
    try { localStorage.setItem(LS_KEY, followSystem ? '1' : '0'); } catch { /* ignore */ }
    const final: Lang = followSystem ? systemLang() : draft;
    setLang(final);
    onClose(final);
  };
```

- [ ] **Step 3: Disable Done unless something changed**

Find line 59-60:

```tsx
          <button
            onClick={apply}
            disabled={draft === lang}
```

Replace with:

```tsx
          <button
            onClick={apply}
            disabled={!followSystem && draft === lang}
```

Find line 62 (the color attribute):

```tsx
              color: draft === lang ? 'var(--fg-subtle)' : 'var(--accent-strong)',
```

Replace with:

```tsx
              color: (!followSystem && draft === lang) ? 'var(--fg-subtle)' : 'var(--accent-strong)',
```

And line 64:

```tsx
              cursor: draft === lang ? 'default' : 'pointer',
```

Replace with:

```tsx
              cursor: (!followSystem && draft === lang) ? 'default' : 'pointer',
```

### Task 5.5: Wire Profile + new sheets into MobileApp

**Files:**
- Modify: `apps/frontend/src/MobileApp.tsx`

- [ ] **Step 1: Import PhAboutSheet**

Find the imports near the top (around line 5-6):

```tsx
import { PhLanguageSheet } from './components/PhLanguageSheet';
import { PhNotificationsSheet } from './components/PhNotificationsSheet';
```

Add:

```tsx
import { PhAboutSheet } from './components/PhAboutSheet';
```

- [ ] **Step 2: Add a sheet state alongside `langSheet` / `notifSheet`**

Find:

```tsx
  const [langSheet, setLangSheet] = useState(false);
  const [notifSheet, setNotifSheet] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
```

Replace with:

```tsx
  const [langSheet, setLangSheet] = useState(false);
  const [notifSheet, setNotifSheet] = useState(false);
  const [aboutSheet, setAboutSheet] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
```

- [ ] **Step 3: Wire Profile props and add the about sheet render**

Find:

```tsx
      {view === 'me' && <Profile onOpenLanguage={() => setLangSheet(true)} />}
```

Replace with:

```tsx
      {view === 'me' && (
        <Profile
          onOpenLanguage={() => setLangSheet(true)}
          onOpenNotifications={() => setNotifSheet(true)}
          onOpenAbout={() => setAboutSheet(true)}
          onOpenSecurity={() => showToast(t('securityNoticeBody'))}
        />
      )}
```

The `showToast(t('securityNoticeBody'))` call uses the existing toast helper; the body's longer than usual, but with the 14px font and ~2 lines of wrap it fits.

Find the `{langSheet && ...}` block. Right above it (or below), insert:

```tsx
      {aboutSheet && <PhAboutSheet onClose={() => setAboutSheet(false)} />}
```

### Task 5.6: Verify and commit Group 5

- [ ] **Step 1: Typecheck**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 2: Manual check**

- Profile → tap Notifications row → notifications sheet opens. Title localized.
- Profile → tap Security row → toast pops with the "Managed by Workspace Admin…" copy.
- Profile → tap About row → about sheet opens showing Version, Build, and a Support row that opens the mail client.
- Toggle Follow-System on language sheet → list dims; tap Done → app language switches to your browser's locale; close + reopen the app and the toggle stays on.

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp && \
git add apps/frontend/src/components/PhAboutSheet.tsx \
        apps/frontend/src/components/PhNotificationsSheet.tsx \
        apps/frontend/src/components/PhLanguageSheet.tsx \
        apps/frontend/src/pages/Profile.tsx \
        apps/frontend/src/MobileApp.tsx && \
git commit -m "$(cat <<'EOF'
feat(mobile): profile + sheets parity (S7-S9)

- Profile rows are all actionable: Notifications opens the sheet,
  Security toasts a workspace-admin notice, About opens a new
  PhAboutSheet (version, build, mail-to support).
- PhNotificationsSheet copy now flows through t() (title, unread
  count, "All caught up", "Mark all read", manage hint).
- PhLanguageSheet: Follow-System toggle persists in localStorage
  and, when on, sets the app language to navigator.language on
  apply.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Group 6: Desktop deep-link wiring (CC-5 desktop half)

### Task 6.1: DesktopApp — subscribe to route, sync editingOrder

**Files:**
- Modify: `apps/frontend/src/DesktopApp.tsx`

- [ ] **Step 1: Add route subscription and order-id sync**

Find the imports (lines 1-22) and add:

```tsx
import { useRoute, match, navigate } from './lib/route';
import { api } from './lib/api';
```

Find lines 27-31 (state):

```tsx
  const user = useEffectiveUser();
  const [view, setView] = useState<DesktopView>('dashboard');
  const [toast, setToast] = useState<Toast | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
```

Immediately after, insert:

```tsx
  const { path } = useRoute();

  // Sync editingOrder with the URL hash. Loading the app at
  // `#/orders/<id>` opens that order's edit page; clearing the hash
  // closes it.
  useEffect(() => {
    const m = match('/orders/:id', path);
    if (!m) {
      // If we're already on /orders (no id) and an editingOrder is open, close it.
      if (path === '/orders' && editingOrder) setEditingOrder(null);
      return;
    }
    if (editingOrder?.id === m.id) return; // already showing the right one
    // Force the orders view, then load the order.
    setView('history');
    api.get<{ order: Order }>(`/api/orders/${m.id}`)
      .then(r => setEditingOrder(r.order))
      .catch(() => {/* ignore — order may have been deleted */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
```

- [ ] **Step 2: When the user opens an order from the list or closes the editor, navigate**

Find lines 67-73:

```tsx
  const ordersOrEdit = editingOrder
    ? <DesktopEditOrder
        order={editingOrder}
        onCancel={() => setEditingOrder(null)}
        onSaved={(msg) => { setEditingOrder(null); showToast(msg); }}
      />
    : <DesktopOrders onEdit={(o) => setEditingOrder(o)} />;
```

Replace with:

```tsx
  const ordersOrEdit = editingOrder
    ? <DesktopEditOrder
        order={editingOrder}
        onCancel={() => { navigate('/orders'); setEditingOrder(null); }}
        onSaved={(msg) => { navigate('/orders'); setEditingOrder(null); showToast(msg); }}
      />
    : <DesktopOrders onEdit={(o) => { navigate('/orders/' + o.id); setEditingOrder(o); }} onToast={(m) => showToast(m)} />;
```

### Task 6.2: DesktopOrders — link icon on each row

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopOrders.tsx`

- [ ] **Step 1: Add `onToast` prop**

Find the Props type for the component. (Search the file for `type Props = ` or `interface Props ` — the file is large; ideally the prop signature is near the export.)

Search for `onEdit: (o: Order)`. The surrounding type is the Props type. Add `onToast?: (msg: string) => void;` to it.

If the existing destructure looks like `export function DesktopOrders({ onEdit }: Props)`, change it to:

```tsx
export function DesktopOrders({ onEdit, onToast }: Props)
```

- [ ] **Step 2: Find where the order ID is rendered**

Search for `o.id` in DesktopOrders.tsx — likely inside a `<td>` near the start of the row template. Wherever it's rendered, add a small share/copy button adjacent to it. Use the same Icon-button styling already present in the file.

If you can't find an obvious anchor, add this snippet inline next to the `o.id` cell content:

```tsx
<button
  onClick={(e) => {
    e.stopPropagation();
    const url = `${location.origin}${location.pathname}#/orders/${o.id}`;
    const share = (navigator as Navigator & { share?: (data: { url: string; title: string }) => Promise<void> }).share;
    if (typeof share === 'function') {
      share.call(navigator, { url, title: t('shareOrder') }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(url).then(() => onToast?.(t('orderIdCopied'))).catch(() => {});
    }
  }}
  aria-label={t('shareOrder')}
  title={t('shareOrder')}
  style={{ background: 'transparent', border: 'none', color: 'var(--fg-subtle)', padding: 0, marginLeft: 6, lineHeight: 0, cursor: 'pointer', verticalAlign: 'middle' }}
>
  <Icon name="paperclip" size={12} />
</button>
```

If `useT` isn't already imported / `const { t } = useT();` isn't already in scope, no change needed — it's used throughout DesktopOrders already.

### Task 6.3: Verify and commit Group 6

- [ ] **Step 1: Typecheck**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 2: Production build**

```bash
cd /srv/data/recycle_erp && pnpm --filter=frontend build
```

Expected: build succeeds.

- [ ] **Step 3: Manual check**

In desktop mode:
- Open `http://localhost:5173/#/orders/<id>` — DesktopEditOrder renders directly. Closing it returns to the list and the hash becomes `#/orders`.
- Click into any order from the list — the hash updates to `#/orders/<id>`. Browser back goes to `#/orders` and closes the editor.
- Click the paperclip icon next to an order ID — clipboard contains the deep link; toast confirms.

- [ ] **Step 4: Commit**

```bash
cd /srv/data/recycle_erp && \
git add apps/frontend/src/DesktopApp.tsx \
        apps/frontend/src/pages/desktop/DesktopOrders.tsx && \
git commit -m "$(cat <<'EOF'
feat(desktop): deep-linkable order URLs (CC-5)

DesktopApp subscribes to the shared hash router. Loading
#/orders/:id opens DesktopEditOrder for that order; navigating
through the UI keeps the URL in sync, so browser back/forward and
shareable links both work. Adds a paperclip icon next to each
order ID for one-tap copy/share.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (run after writing all groups)

**Spec coverage check:**

| Spec item | Implemented in |
|---|---|
| CC-1 `.cam-hint` | Task 1.1 |
| CC-2 scroll-shadow hook | Task 1.3 + per-page wiring in Tasks 2.4, 4.1, 4.3, 4.4 |
| CC-3 unified line-edit | Tasks 1.8 (PhCategoryFields), 3.2 (SubmitForm), 3.3 (OrderReview) |
| CC-4 AI rescan in edit-mode | Task 1.6 (`rescanRam`), Task 3.2 (SubmitForm merges values) |
| CC-5 deep-linkable order URLs (mobile) | Tasks 1.4 (route lib), 4.1 (Orders) |
| CC-5 deep-linkable order URLs (desktop) | Tasks 6.1, 6.2 |
| CC-6 back-button returns to review | Tasks 1.5-1.7 (state machine), 3.1 (camera), 3.2 (submit) |
| CC-7 i18n keys | Task 1.9 |
| S1 login picker localized | Task 2.1 |
| S2 dashboard delta + scroll-shadow | Tasks 2.3, 2.4 |
| S3a category sheet | no-op (already matches) |
| S3b camera flash + switch | Task 3.1 |
| S3c SubmitForm as edit page | Task 3.2 |
| S3d OrderReview tap-to-edit | Task 3.3 |
| S4 Orders search + deep-link | Task 4.1 |
| S5 Market scroll-shadow | Task 4.3 |
| S6 Inventory polish + info banner | Task 4.4 |
| S7 Profile row actions | Tasks 5.1, 5.2, 5.5 |
| S8 Language Follow-System persist | Task 5.4 |
| S9 Notifications i18n | Task 5.3 |

All spec items are covered.

**Placeholder scan:** No "TBD" / "implement later" / "TODO" left in any task. Every step that changes code shows the code.

**Type consistency:** `editingLineIdx` and `returnTo` are consistent across `CaptureState`, `SubmitForm` props, `Camera` props. The new `onEditLine` prop name is consistent between MobileApp wiring (Task 1.7) and OrderReview (Task 3.3). The new i18n keys used in code (Tasks 2.x, 3.x, 4.x, 5.x) all match the keys added in Task 1.9.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-mobile-design-parity.md`.

Recommended execution: **Subagent-Driven** — fresh subagent per group, review between groups. Each group is one commit and one user-visible checkpoint, matching the spec's delivery cadence.
