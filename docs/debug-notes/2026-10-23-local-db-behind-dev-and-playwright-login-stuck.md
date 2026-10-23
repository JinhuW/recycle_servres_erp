# Local check: the shared DB was behind dev, and Playwright's login stuck

**2026-10-23, ERP v1.318.2 (RS-363).**

## 1. Recording an accounting entry locally returned 500

### Symptom

`POST /api/accounting/entries` on the local stack answered `{"error":"Internal
error"}`. The backend log said
`column "author_id" of relation "accounting_entries" does not exist`.

### Cause

`pnpm dev` (`tsx watch src/server.ts`) doesn't run migrations. The local
database `recycle_erp_test` in the `recycle-erp-testdb` container is shared by
every session's local stack, and it was still at an older head than the
worktree's code: it had no 0197 (Review mode), 0199–0202.

### Fix

Don't migrate the shared database from one session: another worktree's older
code runs against it. Build a throwaway database in the same container, point
the backend at it with `DATABASE_URL` (dotenv never overrides a variable
already set), and drop it afterwards:

```bash
docker exec recycle-erp-testdb createdb -U recycle recycle_erp_<ticket>
# DATABASE_URL = the .env one with the db name swapped; don't echo it
DATABASE_URL=… node apps/backend/scripts/migrate.mjs
DATABASE_URL=… node apps/backend/scripts/seed.mjs
DATABASE_URL=… PORT=8931 JWT_SECRET=local-dev-secret pnpm --dir apps/backend dev
docker exec recycle-erp-testdb dropdb -U recycle recycle_erp_<ticket>
```

Any test rows already written to the shared database go too (here, three
drafts with no entries, deleted by id).

## 2. Playwright: Continue stopped submitting

### Symptom

After `context().clearCookies()` and a `goto('/')` in the same Playwright
page, the login form filled correctly, but clicking Continue (or pressing
Enter) sent no `/api/auth/login` request at all. This happened run after run.
The backend log showed no attempt, so the rate limiter wasn't the cause.

### Fix

Close the browser (`browser_close`) and start a fresh page. The first login in
a new page went through every time. The root cause in the SPA wasn't found.
The page that stuck had already signed in and out twice, so suspect the
auth context's state in that page rather than the form.

## Also: a stale read between two POs

Moving from `#/purchase-orders/PO-A` to `PO-B` and waiting only for
`#eo-paidby` reads PO-A's picker, because the element is already there. Wait
until the page shows PO-B's id, or reload, before reading the field.
