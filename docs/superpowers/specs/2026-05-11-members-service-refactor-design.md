# Members Service Layer + Wire Member-Management UI — Design

**Date:** 2026-05-11
**Scope:** `apps/backend` (members route + new service module) and `apps/frontend` (DesktopSettings Members panel)
**Type:** Refactor + small feature additions (soft-delete endpoint, invite dialog, Export-CSV button removal)

## Motivation

Two related problems in the Members area:

1. `apps/backend/src/routes/members.ts` mixes HTTP plumbing, authorization, and persistence/business logic in one file. The same shape is repeated across every route file under `apps/backend/src/routes/`; none of them have a service layer.
2. The frontend Members panel (`apps/frontend/src/pages/desktop/DesktopSettings.tsx`) has UI for actions that the backend can't yet serve:
   - **Remove member** trash button → toast `"Remove ${m.name} — endpoint not yet wired"` (line 584). No `DELETE /api/members/:id` exists.
   - **Invite member** button → toast `"Invite flow coming soon"` (line 468). The backend `POST /api/members` already exists; only the frontend dialog is missing.
   - **Export CSV** button → toast `"CSV export — endpoint not yet wired"` (line 465). Not planned; the button itself is removed in this change.

This change establishes the service-layer pattern using `members` as the proof of concept, adds the missing soft-delete endpoint, wires the Remove and Invite UI to real backend calls, and removes the Export CSV button.

## Out of Scope

- Other route files (`auth`, `customers`, `orders`, `warehouses`, …). Migration to the same pattern is a follow-up.
- The hardcoded `PENDING_INVITES` mock list on the Members panel.
- New operations beyond `DELETE`: no `GET /:id`, no search/pagination.
- Tests — no backend test framework exists today; this change does not introduce one.
- Type changes in `packages/shared`.

## File Layout

- **New:** `apps/backend/src/services/members.ts` — pure persistence + business logic, no Hono imports.
- **Modified:** `apps/backend/src/routes/members.ts` — thin HTTP wrapper; no inline SQL.
- **Modified:** `apps/frontend/src/pages/desktop/DesktopSettings.tsx` — Remove button calls the new DELETE; Invite button opens a new dialog component defined in the same file.

`apps/backend/src/index.ts` is unchanged. The route is still mounted at `/api/members` behind `authMiddleware`, and the manager-only guard remains inside the route file.

## Service Module — `services/members.ts`

Plain exported async functions. First argument is always the `Sql` client (the value returned by `getDb(env)`); subsequent arguments are typed input objects. No Hono, no `Env`, no request lifecycle awareness.

### Types

```ts
import type { Sql } from 'postgres';

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
```

### Functions

```ts
export async function listMembers(
  sql: Sql,
  opts?: ListMembersOptions,
): Promise<MemberSummary[]>;

// Returns the password the service ultimately stored (the caller's, or
// the default `'demo'` if none was supplied). Callers include this in
// the 201 response so the inviting manager can share it.
export async function createMember(
  sql: Sql,
  input: CreateMemberInput,
): Promise<{ id: string; password: string }>;

export async function updateMember(
  sql: Sql,
  id: string,
  input: UpdateMemberInput,
): Promise<void>;

// Soft-delete: sets active = false. Returns true if a row was updated,
// false if no user existed with that id.
export async function deactivateMember(sql: Sql, id: string): Promise<boolean>;
```

### Behavior moved from route into service

- The aggregated list query (`users LEFT JOIN orders LEFT JOIN order_lines`, `COUNT(DISTINCT o.id)`, `SUM(...)`, ordering by `role DESC, name`). When `opts.includeInactive` is falsy, the query gets a `WHERE u.active = TRUE` clause.
- `initials` defaulting from the name (`split → first letters → slice 2 → fallback 'NA'`).
- `password` defaulting to `'demo'` when omitted, plus calling `hashPassword` from `../auth`.
- The conditional password reset in `updateMember` (separate `UPDATE` when `password` is provided), and the `COALESCE(${...}, col)` partial-update pattern for the other fields.
- The new `UPDATE users SET active = FALSE WHERE id = $1` for soft-delete. Uses `RETURNING id` to detect missing rows.

The existing SQL stays the same as today (apart from the new optional `WHERE u.active = TRUE`); only its location moves.

## Route Module — `routes/members.ts`

Continues to own:

- Hono router construction and the `Bindings`/`Variables` generics.
- The manager-only middleware (`if (c.var.user.role !== 'manager') return 403`).
- JSON body parsing with the existing `.catch(() => null)` guard.
- HTTP-level required-field validation: `POST /` returns 400 unless `email`, `name`, `role` are present.
- Calling the service with `getDb(c.env)` and the parsed body or query parameters.
- Shaping responses: `{ items }` for list, `{ id, password }` with status 201 for create, `{ ok: true }` for update, `{ ok: true }` for delete (404 if the service reports no rows).

New endpoint surface:

| Method | Path                              | Notes                                              |
|--------|-----------------------------------|----------------------------------------------------|
| GET    | `/api/members`                    | Default: active only. `?includeInactive=true` for all. |
| POST   | `/api/members`                    | Unchanged. Returns `{ id, password }` with 201.    |
| PATCH  | `/api/members/:id`                | Unchanged.                                         |
| DELETE | `/api/members/:id`                | **New.** Soft delete. 400 if caller is target; 404 if no such user; 200 `{ ok: true }` on success. |

The DELETE handler additionally refuses to deactivate the requesting user themselves (returns 400 with `{ error: 'Cannot remove yourself' }`). This prevents a manager from accidentally locking themselves out.

The route file imports from `../services/members` and `../db`; it no longer imports `hashPassword`.

## Frontend — `DesktopSettings.tsx` `MembersPanel`

### Remove button (line 584)

Replace the toast `onClick` with a call to a new `removeMember` helper:

```ts
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

The button's `onClick` becomes `() => handleRemove(m)`. The `!isMe` guard around the button stays (extra belt-and-suspenders on top of the backend self-removal block).

`api.delete` already exists in `apps/frontend/src/lib/api.ts:64`; no change to the API client is needed.

### Export CSV button (line 465)

Delete the button entirely from the `SettingsHeader` `actions` slot. The `Icon name="download"` import stays only if it's still used elsewhere in the file; otherwise leave imports as-is (a follow-up tidy can prune unused icons).

### Invite member dialog (line 468)

Add an `inviting: boolean` state alongside `editing`. The button toggles it on. Add an `<InviteMemberDialog>` component inside `DesktopSettings.tsx` (mirror the existing edit-member dialog pattern). The dialog collects:

- `email` (required, type=email)
- `name` (required)
- `role` (required, radio: Manager / Purchaser)
- `team` (optional)
- `phone` (optional)
- `title` (optional)

On submit, POSTs to `/api/members`. On success, replaces the form with a small success view that displays the returned plaintext password and a "Copy" button, then a "Done" button that closes the dialog and reloads the list. Required because the backend returns the auto-generated `'demo'` password (or the manager-supplied one) only at creation time.

Validation on the frontend is minimal: trim inputs, require email/name/role, let the backend speak for everything else.

### List call (line 440)

No change. The new default behavior of the backend (active only) matches the existing UI expectation of the count label `"${members.length} active"`. If a manager later needs to see deactivated members, that's a follow-up — could be a "Show deactivated" toggle in the filter row.

## Error Handling

- DB errors (unique-constraint violations on `email`, malformed UUIDs, etc.) propagate out of the service, out of the route handler, and into Hono's existing `app.onError`, which logs and returns 500. Unchanged.
- The route still returns 400 on missing required fields and 403 on non-manager access.
- New 404 from DELETE when the service reports `false` (no rows updated).
- New 400 from DELETE when the caller is the target (`c.var.user.id === id`).
- No typed-error scheme — deferred until a second service exists.

## Public API Compatibility

- `POST` and `PATCH` shapes are byte-for-byte identical to today.
- `GET /api/members` changes default behavior: previously returned **all** users, now returns only `active = true`. To preserve old behavior, pass `?includeInactive=true`. This is a deliberate breaking change for any unknown consumer; the only known consumer is `DesktopSettings.tsx`, which is updated in this change (and which already expects active-only conceptually based on its UI labels).

## Verification

After implementation:

1. `pnpm typecheck` from repo root passes (covers backend + frontend).
2. `pnpm dev:backend` and `pnpm dev:frontend` both start without errors.
3. Manual walkthrough as a manager user in the browser:
   - Open Settings → Members. List loads. The count label and rows look unchanged.
   - Click **Invite member**. Dialog opens. Submit a new invite with email/name/role only. Success view shows the generated password. Click Done. Dialog closes; the new member appears in the table.
   - Click the trash icon next to that new member. Confirm prompt. Member disappears from the list. No frontend error.
   - In a second browser tab, hit `GET /api/members?includeInactive=true` and confirm the removed member is in the response with `active: false`.
   - Edit an existing member (the existing dialog), toggle the active flag, save. Member disappears from list. Reload list with `?includeInactive=true` and confirm visible.
4. Non-manager user: all four endpoints still 403.
5. Trying to DELETE yourself: 400 `Cannot remove yourself`.
6. DELETE with a bogus UUID: 404.

No automated tests are added in this change.

## Follow-ups (not part of this spec)

- Migrate remaining route files to the service-layer pattern, one per change.
- Introduce a backend test framework and cover `services/members.ts` directly with a fake `sql` tagged template.
- Add `GET /:id`, search, pagination once the service shape is settled.
- Build a "Show deactivated members" toggle in the Members panel filter row so managers can find and reactivate someone.
- Replace the hardcoded `PENDING_INVITES` mock list with real pending-invite data once the invite flow stores invites.
