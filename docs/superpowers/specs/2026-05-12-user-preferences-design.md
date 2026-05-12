# User Preferences — Server-Backed, Per-User, Flexible

## Problem

Today, user-customizable UI settings (column visibility on the Orders and Inventory desktop tables, density, manager role-preview, language) are scattered:

- Most live in `localStorage` under ad-hoc keys (`rs.tweaks.v1`, `rs.inventory.cols.v1`, `rs.inventory.cols.purchaser.v1`, an Orders columns key).
- Only `language` is server-backed, as a dedicated column on `users` written via `PATCH /api/me`.

Consequences:

- Preferences do not follow a user across browsers or devices.
- Each call-site duplicates load/save plumbing.
- Adding a new preference means inventing a new localStorage key in yet another component.

## Goals

- **Per-user, synced everywhere.** One canonical source of truth on the server. A user who logs in elsewhere sees their settings.
- **Flexible.** Adding a new preference is a one-line change. No schema migration per key.
- **Fast.** First paint must not wait on the network — cache reads in localStorage and reconcile.
- **Safe.** Server validates keys and values; unknown keys are rejected.

## Non-Goals

- Per-device overrides. Single sync model only.
- Cross-tab live sync of preferences within the same browser. Acceptable to require a refresh in another tab.
- Multi-user shared preferences / team defaults.

## Design

### Data Model

Single JSONB column on `users`, holding a flat namespaced key-value map.

Migration `0007_user_preferences.sql`:

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill: lift the existing language column into preferences so prefs is
-- the source of truth going forward. `users.language` stays for one release
-- as a fallback for any legacy code paths; it can be dropped later.
UPDATE users
   SET preferences = jsonb_set(preferences, '{language}', to_jsonb(language), true)
 WHERE NOT (preferences ? 'language');
```

Initial allowlist of keys:

| Key                          | Type                              | Notes                                                    |
| ---------------------------- | --------------------------------- | -------------------------------------------------------- |
| `language`                   | `"en" \| "zh"`                    | Mirrored to `users.language` column on write             |
| `tweaks.density`             | `"comfortable" \| "compact"`      |                                                          |
| `tweaks.rolePreview`         | `"actual" \| "as_purchaser"`      | Manager-only                                             |
| `inventory.cols.manager`     | `string[]`                        | Replaces `rs.inventory.cols.v1`                          |
| `inventory.cols.purchaser`   | `string[]`                        | Replaces `rs.inventory.cols.purchaser.v1`                |
| `orders.cols`                | `string[]`                        | Replaces Orders' current localStorage columns key        |

Rationale for JSONB on `users` (vs. a separate `user_preferences` table or typed columns): preferences are O(10 keys × tiny payload), always read together with the user row, always written by the user themselves. One read, one write, no joins. Adding a new key requires only an allowlist entry in code — no schema change.

### API

`GET /api/me` already returns the authed user. After this change, the response shape gains `user.preferences: Record<string, unknown>`.

`PATCH /api/me/preferences`:

- Body: a partial `Record<string, unknown>`. Only keys present in the body are written; absent keys are untouched. A `null` value unsets that key.
- Server validates every provided key against a TypeScript allowlist (per-key validator). Unknown keys → `400 { error: "unknown preference: <key>" }`. Invalid value → `400 { error: "invalid value for <key>" }`.
- Merge is performed at the SQL layer via `jsonb_set`/`||` so concurrent writes are serializable per-row.
- If `language` is among the keys, also `UPDATE users.language` in the same statement.
- Auth: existing `authMiddleware` on `/api/me/*`.

Response: `200 { user: User }` (refreshed full user, so the client can reconcile without a second fetch).

### Frontend

New module `apps/frontend/src/lib/preferences.tsx`:

- `PrefSchema`: a single map declaring default value + validator + (optional) per-role default for every preference key. Adding a new pref = one new entry.
- `PreferencesProvider`: mounts inside `AuthProvider`. On auth, seeds state from `user.preferences`. Maintains a localStorage mirror at `rs.prefs.v1` for instant first paint on the next visit.
- `usePreference<K extends PrefKey>(key, fallback?)` returns `[value, setValue]`.
  - `setValue(next)` updates React state immediately (optimistic) and schedules a debounced PATCH (~400ms coalesce window). All keys touched in the window are flushed in one request.
  - On request failure: rollback to previous server value, surface a toast.
- One-time localStorage migration: on first PreferencesProvider mount after deploy, for each known legacy localStorage key whose corresponding server pref is undefined, push the legacy value via PATCH, then `removeItem` the old key. Idempotent.
- `TweaksProvider` is refactored to delegate to `usePreference('tweaks.density', ...)` and `usePreference('tweaks.rolePreview', ...)`. Its public API (`useTweaks`, `useEffectiveUser`) is unchanged; call-sites do not change.
- `DesktopOrders.tsx` and `DesktopInventory.tsx`: replace the inline `useState + useEffect` localStorage blocks with `usePreference('orders.cols', defaults)` / `usePreference(isManager ? 'inventory.cols.manager' : 'inventory.cols.purchaser', defaults)`.

### Error Handling

- **Network down on save**: optimistic update stays in React state; on PATCH failure (after one retry) we rollback and toast. The user's change is *not* persisted until the next successful PATCH on that key.
- **Server returns unknown key error**: should not happen because frontend only writes keys it knows; if it does (client/server skew), the offending change is rolled back, others in the batch succeed.
- **Corrupt localStorage cache**: try/catch around parse; on failure, clear `rs.prefs.v1` and fall back to schema defaults until the next `/api/me` lands.

### Testing

Backend (`apps/backend/src/routes/me.test.ts` — new file):

- PATCH merges a partial set of keys without disturbing others.
- PATCH rejects an unknown key with 400.
- PATCH rejects an invalid value (e.g., `tweaks.density: "tiny"`) with 400.
- PATCH that includes `language` also updates the `users.language` column.
- PATCH with `key: null` removes the key.

Frontend (`apps/frontend/src/lib/preferences.test.tsx` — new file):

- `usePreference` returns the schema default before auth resolves.
- Updates flush in a debounced batch (one network call for N rapid changes).
- Failed PATCH rolls state back to the prior server value.
- One-time legacy-key migration runs once and clears the old key.

Smoke (manual or Playwright if available): toggle a column in DesktopInventory → reload → toggle persists. Toggle in a private window for the same user → toggle persists.

## Rollout

1. SQL migration (`0007_user_preferences.sql`).
2. Backend: `PATCH /api/me/preferences` route + allowlist + validator. `GET /api/me` includes `preferences`.
3. Frontend: `preferences.tsx` module + `PreferencesProvider` mounted under `AuthProvider`.
4. Refactor `TweaksProvider` to delegate; verify no call-site changes needed.
5. Convert `DesktopInventory.tsx` and `DesktopOrders.tsx` to `usePreference`.
6. One-time legacy localStorage migration ships with step 3.

Each step is independently deployable; step N+1 does not break step N.

## Risks

- **Write storm** from rapid column toggling — mitigated by debounce + coalesce.
- **Stale localStorage clobbering server** on first load — mitigated by reading server first; localStorage only seeds initial render and is overwritten by the `/api/me` response on auth.
- **Schema skew** (old client, new server with unknown keys) — frontend ignores unknown keys when reading; server rejects unknown keys on write.

## Future Work (out of scope for this spec)

- Drop `users.language` column once nothing reads it directly.
- Migrate density from `tweaks.density` to a top-level `theme.density` if more theme prefs land.
- Add settings-page UI for resetting preferences.
