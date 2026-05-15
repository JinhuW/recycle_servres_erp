# Members Service Layer + UI Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `services/members.ts` layer from the existing `routes/members.ts`, add a soft-delete endpoint, wire the frontend Remove and Invite buttons to real backend calls, and delete the unused Export CSV button.

**Architecture:** Backend route stays thin (Hono wiring + HTTP shape) and delegates to plain async service functions that take a `Sql` client as their first argument. Frontend Members panel calls the existing/new endpoints directly via the shared `api` client; the new invite dialog mirrors the existing edit-member modal pattern in the same file.

**Tech Stack:** Hono 4 on Cloudflare Workers, postgres.js, bcryptjs, React + TypeScript via Vite.

**Spec:** `docs/superpowers/specs/2026-05-11-members-service-refactor-design.md`

---

## File Map

- **Create:** `apps/backend/src/services/members.ts`
- **Modify:** `apps/backend/src/routes/members.ts`
- **Modify:** `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

No other files need touching. `apps/backend/src/index.ts` is unchanged. `apps/frontend/src/lib/api.ts` already exposes `api.delete`.

## Verification baseline

Before starting Task 1, run from the repo root and confirm a clean baseline:

```bash
pnpm typecheck
```

Expected: passes (project compiles today; the spec doesn't depend on a green starting point but you want to know if anything is broken before you touch it).

---

## Task 1: Create the service module

**Files:**
- Create: `apps/backend/src/services/members.ts`

This task moves the SQL and password/initials defaulting out of the existing route and into a stateless module. The signatures match the spec exactly. The list query is copied verbatim from `apps/backend/src/routes/members.ts:18-28` plus an optional `WHERE u.active = TRUE` clause when `includeInactive` is falsy.

- [ ] **Step 1.1: Create the service file**

Write the full file at `apps/backend/src/services/members.ts`:

```ts
// Members domain service. Pure SQL + business logic; no Hono, no Env, no
// request-lifecycle awareness. Each function takes the postgres.js Sql
// client as its first argument so the caller (route handler or test) owns
// the connection.

import { hashPassword } from '../auth';
import type { getDb } from '../db';

type Sql = ReturnType<typeof getDb>;

export type MemberRole = 'manager' | 'purchaser';

export interface MemberSummary {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: MemberRole;
  team: string | null;
  phone: string | null;
  title: string | null;
  active: boolean;
  commission_rate: number;
  created_at: Date;
  order_count: number;
  lifetime_profit: number;
}

export interface ListMembersOptions {
  includeInactive?: boolean;
}

export interface CreateMemberInput {
  email: string;
  name: string;
  role: MemberRole;
  team?: string;
  phone?: string;
  title?: string;
  password?: string;
}

export interface UpdateMemberInput {
  name?: string;
  team?: string;
  phone?: string;
  title?: string;
  role?: MemberRole;
  commissionRate?: number;
  active?: boolean;
  password?: string;
}

export async function listMembers(
  sql: Sql,
  opts: ListMembersOptions = {},
): Promise<MemberSummary[]> {
  const activeOnly = !opts.includeInactive;
  const rows = await sql<MemberSummary[]>`
    SELECT u.id, u.email, u.name, u.initials, u.role, u.team, u.phone, u.title,
           u.active, u.commission_rate::float AS commission_rate, u.created_at,
           COUNT(DISTINCT o.id)::int AS order_count,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS lifetime_profit
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    LEFT JOIN order_lines l ON l.order_id = o.id
    ${activeOnly ? sql`WHERE u.active = TRUE` : sql``}
    GROUP BY u.id
    ORDER BY u.role DESC, u.name
  `;
  return rows;
}

function deriveInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
  return initials || 'NA';
}

export async function createMember(
  sql: Sql,
  input: CreateMemberInput,
): Promise<{ id: string; password: string }> {
  const initials = deriveInitials(input.name);
  const password = input.password || 'demo';
  const hash = await hashPassword(password);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, initials, role, team, phone, title, password_hash)
    VALUES (${input.email.toLowerCase()}, ${input.name}, ${initials}, ${input.role},
            ${input.team ?? null}, ${input.phone ?? null}, ${input.title ?? null}, ${hash})
    RETURNING id
  `;
  return { id: rows[0].id, password };
}

export async function updateMember(
  sql: Sql,
  id: string,
  input: UpdateMemberInput,
): Promise<void> {
  await sql`
    UPDATE users SET
      name            = COALESCE(${input.name ?? null}, name),
      team            = COALESCE(${input.team ?? null}, team),
      phone           = COALESCE(${input.phone ?? null}, phone),
      title           = COALESCE(${input.title ?? null}, title),
      role            = COALESCE(${input.role ?? null}, role),
      commission_rate = COALESCE(${input.commissionRate ?? null}, commission_rate),
      active          = COALESCE(${input.active ?? null}, active)
    WHERE id = ${id}
  `;
  if (input.password) {
    const hash = await hashPassword(input.password);
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${id}`;
  }
}

export async function deactivateMember(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE users SET active = FALSE WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}
```

Notes for the implementer:
- The `Sql` type is derived as `ReturnType<typeof getDb>` so the service doesn't need to know how `postgres()` is parameterised.
- The `${activeOnly ? sql\`WHERE u.active = TRUE\` : sql\`\`}` pattern is the postgres.js way to conditionally splice SQL fragments — see the postgres-js docs if unfamiliar; it is *not* string interpolation.
- `hashPassword` is the existing helper from `apps/backend/src/auth.ts`.

- [ ] **Step 1.2: Typecheck**

Run from the repo root:

```bash
pnpm typecheck
```

Expected: passes. The service file is self-contained and not yet imported anywhere; if typecheck fails it will be because of an internal type error in the new file. Fix and re-run.

- [ ] **Step 1.3: Commit**

```bash
git add apps/backend/src/services/members.ts
git commit -m "feat(backend): add members service module"
```

---

## Task 2: Refactor the route to use the service and add DELETE

**Files:**
- Modify: `apps/backend/src/routes/members.ts` (full rewrite of the file body)

The current file has 78 lines of inline SQL across three handlers. After this task the file is a thin HTTP wrapper that delegates to `services/members.ts` and adds a new `DELETE /:id` handler. The manager-only middleware and Hono types are unchanged.

- [ ] **Step 2.1: Rewrite `routes/members.ts`**

Replace the entire file with:

```ts
// Manager-only members admin: list, invite, edit profile + reset password,
// toggle active, soft-delete. HTTP plumbing only; all SQL and domain logic
// lives in services/members.ts.

import { Hono } from 'hono';
import { getDb } from '../db';
import {
  listMembers,
  createMember,
  updateMember,
  deactivateMember,
  type CreateMemberInput,
  type UpdateMemberInput,
} from '../services/members';
import type { Env, User } from '../types';

const members = new Hono<{ Bindings: Env; Variables: { user: User } }>();

members.use('*', async (c, next) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  await next();
});

members.get('/', async (c) => {
  const includeInactive = c.req.query('includeInactive') === 'true';
  const items = await listMembers(getDb(c.env), { includeInactive });
  return c.json({ items });
});

members.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<CreateMemberInput> | null;
  if (!body?.email || !body?.name || !body?.role) {
    return c.json({ error: 'email, name, role required' }, 400);
  }
  const result = await createMember(getDb(c.env), body as CreateMemberInput);
  return c.json(result, 201);
});

members.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as UpdateMemberInput | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  await updateMember(getDb(c.env), id, body);
  return c.json({ ok: true });
});

members.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (c.var.user.id === id) {
    return c.json({ error: 'Cannot remove yourself' }, 400);
  }
  const ok = await deactivateMember(getDb(c.env), id);
  if (!ok) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default members;
```

Notes:
- `hashPassword` is no longer imported here — it's used only inside the service now.
- The `includeInactive` query param uses strict `=== 'true'` comparison; any other value (`'false'`, `'1'`, missing) is treated as false, which is what we want.

- [ ] **Step 2.2: Typecheck**

```bash
pnpm typecheck
```

Expected: passes.

- [ ] **Step 2.3: Manual smoke test of the backend**

Start the backend dev server in one terminal:

```bash
pnpm dev:backend
```

In another terminal, grab a manager token (the simplest path is to log in via the frontend and copy the `Authorization: Bearer …` header from a DevTools network request; or follow whatever local procedure already exists).

Then exercise each endpoint:

```bash
TOKEN=...   # paste your manager bearer token

# List — should look identical to before except inactive users are hidden.
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/members | jq '.items | length'

# List with includeInactive — should be >= the previous count.
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8787/api/members?includeInactive=true" | jq '.items | length'

# Create — note the returned id and password.
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"email":"plan-test@example.com","name":"Plan Test","role":"purchaser"}' \
  http://localhost:8787/api/members

# Replace NEW_ID with the id returned above.
NEW_ID=...

# Patch — change the title.
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"QA"}' \
  http://localhost:8787/api/members/$NEW_ID

# Delete — should return { ok: true }.
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/members/$NEW_ID

# Delete again — should now 404.
curl -s -i -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/members/$NEW_ID

# Delete yourself — should 400.
MY_ID=$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/me | jq -r .id)
curl -s -i -X DELETE -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/members/$MY_ID

# Confirm the deleted user appears in includeInactive=true with active=false.
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8787/api/members?includeInactive=true" \
  | jq --arg id "$NEW_ID" '.items[] | select(.id == $id) | { id, email, active }'
```

If any of these fail, stop and fix before committing.

- [ ] **Step 2.4: Commit**

```bash
git add apps/backend/src/routes/members.ts
git commit -m "refactor(backend): thin members route + DELETE soft-delete endpoint"
```

---

## Task 3: Remove the Export CSV button

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx` (around line 465)

Smallest, most isolated frontend change. Lands as its own commit.

- [ ] **Step 3.1: Delete the Export CSV button from `MembersPanel`**

Locate the `SettingsHeader actions={...}` block inside `MembersPanel` (currently around lines 463-472). It looks like this:

```tsx
actions={
  <>
    <button className="btn" onClick={() => showToast?.('CSV export — endpoint not yet wired', 'error')}>
      <Icon name="download" size={14} /> Export CSV
    </button>
    <button className="btn accent" onClick={() => showToast?.('Invite flow coming soon', 'error')}>
      <Icon name="plus" size={14} /> Invite member
    </button>
  </>
}
```

Replace it with (only the Invite button stays — its `onClick` is replaced in Task 5):

```tsx
actions={
  <button className="btn accent" onClick={() => showToast?.('Invite flow coming soon', 'error')}>
    <Icon name="plus" size={14} /> Invite member
  </button>
}
```

(The fragment wrapper goes away because there's only one child now. The Invite button's onClick is left as-is in this task; Task 5 replaces it. This keeps the diff small and the commit focused.)

Do not delete any imports — `Icon` is used elsewhere in the file with other names; the implementer should not touch import lines in this task.

- [ ] **Step 3.2: Typecheck**

```bash
pnpm typecheck
```

Expected: passes.

- [ ] **Step 3.3: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "feat(settings): remove unused Export CSV button from Members panel"
```

---

## Task 4: Wire the Remove (trash) button

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx` (inside `MembersPanel`, around line 584)

- [ ] **Step 4.1: Add the `handleRemove` helper inside `MembersPanel`**

After the existing `reload` and `useEffect` lines in `MembersPanel` (currently around line 440-441), add:

```tsx
async function handleRemove(m: Member) {
  if (!window.confirm(`Remove ${m.name}? They will no longer appear in the list. Their order history is preserved.`)) return;
  try {
    await api.delete(`/api/members/${m.id}`);
    showToast?.(`${m.name} removed`, 'success');
    reload();
  } catch (err) {
    showToast?.(err instanceof Error ? err.message : 'Remove failed', 'error');
  }
}
```

- [ ] **Step 4.2: Replace the Remove button's onClick**

Find the trash-icon button (currently around lines 581-588):

```tsx
<button
  className="btn icon sm ghost"
  title="Remove from workspace"
  onClick={() => showToast?.(`Remove ${m.name} — endpoint not yet wired`, 'error')}
  style={{ color: 'var(--neg)' }}
>
  <Icon name="trash" size={13} />
</button>
```

Change the `onClick` line to:

```tsx
  onClick={() => handleRemove(m)}
```

Leave the surrounding `!isMe &&` guard, the `className`, `title`, `style`, and the `<Icon>` child untouched.

- [ ] **Step 4.3: Typecheck**

```bash
pnpm typecheck
```

Expected: passes.

- [ ] **Step 4.4: Manual browser smoke test**

Make sure the backend dev server (Task 2) is still running, then in another terminal:

```bash
pnpm dev:frontend
```

Open the app, log in as a manager, navigate to Settings → Members. Click the trash icon next to any user *other than yourself*:

1. A native `window.confirm` dialog appears.
2. Click OK. A success toast says "{name} removed".
3. The row disappears from the list.

If anything else happens, stop and fix.

- [ ] **Step 4.5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "feat(settings): wire Remove member button to DELETE /api/members/:id"
```

---

## Task 5: Wire the Invite member dialog

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx` (add a new component + state + button onClick)

Largest frontend task. Adds a new `InviteMemberDialog` component (modelled on the existing `MemberEditModal` at line 690), wires the Invite button to open it, and shows the generated password once after a successful POST.

- [ ] **Step 5.1: Add the `InviteMemberDialog` component**

Insert this new component definition *immediately before* `MemberEditModal` in `apps/frontend/src/pages/desktop/DesktopSettings.tsx`. The exact location: just before the line `function MemberEditModal({ member, onClose, onSaved }: ...) {`.

```tsx
function InviteMemberDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'manager' | 'purchaser'>('purchaser');
  const [team, setTeam] = useState('');
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; password: string } | null>(null);

  const canSubmit = email.trim() && name.trim() && !submitting;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.post<{ id: string; password: string }>('/api/members', {
        email: email.trim(),
        name: name.trim(),
        role,
        team: team.trim() || undefined,
        phone: phone.trim() || undefined,
        title: title.trim() || undefined,
      });
      setCreated(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite failed');
    } finally {
      setSubmitting(false);
    }
  };

  const copyPassword = async () => {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.password); } catch { /* ignore */ }
  };

  const done = () => {
    onCreated();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 480 }}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{created ? 'Member invited' : 'Invite member'}</div>
            <div className="modal-sub">
              {created
                ? 'Share this initial password with them. It will not be shown again.'
                : 'A new account will be created with a temporary password.'}
            </div>
          </div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>

        {!created && (
          <>
            <div className="modal-body">
              <div className="field-row">
                <div className="field">
                  <label className="label">Email</label>
                  <input
                    className="input"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="field">
                  <label className="label">Name</label>
                  <input className="input" value={name} onChange={e => setName(e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Role</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <label className={'role-card ' + (role === 'purchaser' ? 'active' : '')}>
                      <input
                        type="radio"
                        checked={role === 'purchaser'}
                        onChange={() => setRole('purchaser')}
                      />
                      <span>Purchaser</span>
                    </label>
                    <label className={'role-card ' + (role === 'manager' ? 'active' : '')}>
                      <input
                        type="radio"
                        checked={role === 'manager'}
                        onChange={() => setRole('manager')}
                      />
                      <span>Manager</span>
                    </label>
                  </div>
                </div>
                <div className="field">
                  <label className="label">Title</label>
                  <input className="input" value={title} onChange={e => setTitle(e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Team</label>
                  <input className="input" value={team} onChange={e => setTeam(e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Phone</label>
                  <input className="input" value={phone} onChange={e => setPhone(e.target.value)} />
                </div>
              </div>
              {error && (
                <div style={{ marginTop: 12, color: 'var(--neg)', fontSize: 13 }}>{error}</div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button
                className="btn accent"
                disabled={!canSubmit}
                onClick={submit}
              >
                {submitting ? 'Inviting…' : 'Send invite'}
              </button>
            </div>
          </>
        )}

        {created && (
          <>
            <div className="modal-body">
              <div className="field">
                <label className="label">Initial password</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input mono" value={created.password} readOnly />
                  <button className="btn" onClick={copyPassword}>
                    <Icon name="copy" size={13} /> Copy
                  </button>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn accent" onClick={done}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

Notes:
- The component reuses existing classes (`modal-backdrop`, `modal-shell`, `modal-head`, `modal-body`, `modal-foot`, `field-row`, `field`, `label`, `input`, `btn`, `btn accent`, `role-card`, `mono`) that already appear in `MemberEditModal` and `DangerConfirmDialog`. No new CSS is required.
- `Icon name="copy"` is used because copy icons appear elsewhere in the codebase. If `pnpm typecheck` later complains that `'copy'` isn't a valid `IconName`, swap it for `'clipboard'`, then `'check'`, then drop the icon entirely (`<Icon name="x" />` is not appropriate). Pick whichever icon name typechecks.

- [ ] **Step 5.2: Add `inviting` state and render the dialog in `MembersPanel`**

Inside `MembersPanel` (around line 433-438 where the other useState hooks live), add a new state declaration alongside `editing`:

```tsx
const [inviting, setInviting] = useState(false);
```

Then locate the existing render of `<MemberEditModal>` near the end of `MembersPanel`'s return (currently around lines 602-609). It looks like:

```tsx
{editing && (
  <MemberEditModal
    member={editing}
    onClose={() => setEditing(null)}
    onSaved={() => { setEditing(null); reload(); showToast?.('Member updated'); }}
  />
)}
```

Immediately after that block (still inside the same parent fragment, before the closing `</div>`), add:

```tsx
{inviting && (
  <InviteMemberDialog
    onClose={() => setInviting(false)}
    onCreated={() => { reload(); showToast?.('Member invited', 'success'); }}
  />
)}
```

- [ ] **Step 5.3: Replace the Invite button's onClick**

Find the Invite button in `SettingsHeader actions` (after Task 3 it should be the only button in the actions slot, around line 465-468):

```tsx
<button className="btn accent" onClick={() => showToast?.('Invite flow coming soon', 'error')}>
  <Icon name="plus" size={14} /> Invite member
</button>
```

Change the `onClick` to:

```tsx
  onClick={() => setInviting(true)}
```

- [ ] **Step 5.4: Typecheck**

```bash
pnpm typecheck
```

Expected: passes. If `Icon name="copy"` errors, swap it per the note in Step 5.1 until it typechecks.

- [ ] **Step 5.5: Manual browser smoke test**

With both dev servers running, open Settings → Members as a manager:

1. Click **Invite member**. Dialog opens. The role selector defaults to Purchaser.
2. Type an email and name. Leave team/phone/title blank. Click **Send invite**.
3. The form is replaced by the "Member invited" success view showing an initial password (`demo` unless you supplied one). Click **Copy** — clipboard should contain `demo`.
4. Click **Done**. Dialog closes; a toast says "Member invited"; the new row appears in the members table.
5. Click the trash icon next to the new row; confirm; row disappears (cross-check that Task 4 still works after this change).
6. Click **Invite member** again, fill in only an email (leave name blank). The **Send invite** button is disabled. Fill in name; button enables. Click it. Verify success.
7. Click **Invite member**, enter an email that already exists, submit. The dialog should show a red error message (the backend's 500 from the unique-constraint violation surfaces as a thrown Error from the `api.post` call).

- [ ] **Step 5.6: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "feat(settings): add Invite member dialog wired to POST /api/members"
```

---

## Wrap-up

After all five tasks:

- [ ] **Final: Run full typecheck**

```bash
pnpm typecheck
```

Expected: passes for both `apps/backend` and `apps/frontend`.

- [ ] **Final: End-to-end browser walkthrough**

Follow the verification list in the spec (`docs/superpowers/specs/2026-05-11-members-service-refactor-design.md` § Verification, items 3-6). Confirm each.

- [ ] **Final: Commit log sanity check**

```bash
git log --oneline -n 5
```

Expected five new commits (one per Task 1-5), each focused on a single change.

---

## Risk notes

- **Breaking change on list endpoint.** `GET /api/members` now hides inactive users by default. Any consumer other than `DesktopSettings.tsx` will see fewer rows. The frontend `MembersPanel` was already labelling its count as "active", so the user-facing behaviour is in line with the label. Manager users who toggled someone's `active` flag to `false` via the existing edit dialog will now find that user gone from the default view — there is no UI yet to bring them back, which is captured as a follow-up in the spec.
- **Self-delete via API.** The DELETE route refuses to deactivate the requesting user (400). The PATCH route does *not* currently apply the same guard, which means a manager could still set their own `active = false` via the edit dialog and lock themselves out. The spec doesn't ask us to add this guard now; flagging here so it doesn't surprise a reviewer.
- **Unique email collision in invite dialog.** The dialog surfaces the backend's 500 as a generic error message. We aren't catching unique-violation specifically. If this becomes noisy in practice, add typed errors in a follow-up.
