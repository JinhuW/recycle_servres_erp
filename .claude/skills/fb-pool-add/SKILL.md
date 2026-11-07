---
name: fb-pool-add
description: Use when someone gives Facebook accounts to add to the ERP account pool, as a pasted list, a sheet or a file ("add these accounts to the pool", "import this order of logins", "把这些账号加到账号池"). Adds them through the pool:write service route with secrets masked. Not for assigning accounts to workers.
---

# Add accounts to the Facebook account pool

The accounts go to `POST /api/facebook-pool/push/accounts`. Every row lands
`available`. Adding causes no Facebook login, because a worker only gets an
account through `/assign`, which this skill never calls.

## Setup

`add.mjs` reads `~/.config/recycle-erp/pool-client.env`, which must be mode 600:

```sh
RS_ERP_URL=https://<erp host>
RS_POOL_CLIENT_ID=...
RS_POOL_CLIENT_SECRET=...
```

If the file is missing, ask the owner to create it: as a manager, go to
**Settings → Connectors**, mint a service client with the `pool:write` scope
and save the secret, which is shown only once. A client belongs to one ERP, so
prod and dev each need their own. To use another file for one run, set
`RS_POOL_CREDS=<path>`.

## Steps

1. **Map the columns to fields.** Write `{ "batch": "<name>", "rows": [...] }`
   to a new file in the scratchpad. Each row has these string fields: `uid`,
   `password`, `totp`, `email`, `emailPassword`, `recovery`, `cookie`, `token`,
   `note`.
   - The layouts are the ones the page's import takes (`parsePoolImport` in
     `apps/frontend/src/lib/facebookPool.ts`), with `----`, `|`, tab or comma
     between columns. If there's a header row, map by its names, including
     Chinese ones and 令牌 for the token.
   - With no header, the order is uid, password, 2FA key, email, email password,
     recovery email, cookie, token, note. A leading short row number is not a
     column.
   - `uid` is 10–20 digits and `password` is required. Tokens start with `EAA`.
   - **If a column could be two things, ask. Don't guess.** A swapped password
     looks fine until a login fails on a live account.
   - Name the batch after where the accounts came from, such as `Order 2749318`.
     Ask if nothing says.
2. **Preview.** Run `node .claude/skills/fb-pool-add/add.mjs <rows.json>`. It
   sends nothing, and prints the target host, the batch and one masked line per
   row with its problems.
3. **Confirm.** Show the user the preview and get a yes for that target host,
   since this writes to a live pool.
4. **Send.** Run `node .claude/skills/fb-pool-add/add.mjs <rows.json> --send`.
   The batch is all-or-nothing, so a refusal adds nothing and names the rows.
   Remove a duplicate only if the user says to, because it may be an account
   they meant to update.
5. **Report and clean up.** Give the new `#` of each account, and delete the
   rows file.

## Never

- Print or repeat a password, 2FA key, cookie or token, in chat or in a command
  line. Keep them in the rows file.
- Assign accounts to workers, restart a worker or start a re-login.
- Write to the database directly if the route refuses. Report the refusal.

A row with no 2FA key can be added, but the fleet refuses it (`no_login`), so
say so when the user confirms.
