# Local verify of a service push: no migrations, no signing key, no localhost

**2026-11-16, ERP v1.472.0 (RS-599).**

## Symptom

Verifying the WeChat page against real days pushed from memtrade into a local
backend (`PORT=8931 JWT_SECRET=… pnpm dev`) failed three ways in a row:

1. memtrade's token request got **500**: the log said
   `OAUTH_SIGNING_KEY_CURRENT not set`.
2. With a key set, the day's `PUT /api/wechat-market/push/days/<date>` got
   **500**: `column "buy_qty" of relation "wechat_market_days" does not exist`.
   The new migration had never run.
3. Claude in Chrome showed an error page for `http://localhost:5180`, and a
   `fetch` from it failed, though vite was listening.

## Cause

1. `/oauth/token` signs with `OAUTH_SIGNING_KEY_CURRENT`, which the repo-root
   `.env` doesn't set. A cookie login works without it; any
   `client_credentials` caller (memtrade, the fleet agent) does not.
2. `pnpm dev` starts the backend with `tsx watch` and never runs
   `scripts/migrate.mjs`. Only the container boot and the test template do.
   The local docker DB is shared by every session, so it sits at whatever the
   last `pnpm db:migrate` left.
3. The Chrome that the extension drives isn't on this Mac. `localhost` there
   is the other machine.

## Fix

- Generate a throwaway Ed25519 key and start the backend with it:
  ```sh
  KEY=$(node -e "const {generateKeyPairSync}=require('crypto');const {privateKey}=generateKeyPairSync('ed25519');process.stdout.write(Buffer.from(privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))")
  OAUTH_SIGNING_KEY_CURRENT=$KEY OAUTH_ISSUER_URL=http://127.0.0.1:8931 PORT=8931 JWT_SECRET=local-dev-secret pnpm dev
  ```
  Then mint a client as a seed manager: `POST /api/oauth/clients` with
  `{"name":"…","scopes":["wechat:write"]}`.
- Run `pnpm db:migrate` from the repo root before pushing anything that
  writes a new column. It only adds what's pending.
- Open the frontend at the Mac's LAN address (vite prints it, e.g.
  `http://10.10.100.225:5180`). Vite proxies `/api` to the backend, so the
  login and every call go through the same origin.

## How to spot it next time

A 500 on a service route in local verify: read the backend log for the
`Unhandled error` line before touching code. An error page in the driven
browser for `localhost` while vite is up: use the LAN address.
