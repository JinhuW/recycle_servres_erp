# Railway + Cloudflare security work — status

_Last updated 2026-06-19. Full findings: `docs/security-railway-cloudflare-review.md`._

## Architecture (final)

```
browser → CF Worker (inventory-prod/dev.recycleservers.com)
        → api.prod/dev.recycleservers.com  (DNS-only, Railway cert)
        → Railway backend  (gated by PROXY_SECRET; direct hit → 403)
```

R2: prod backend → `recycle-erp-attachments` (TF token `fa9f673b`), dev backend →
`recycle-erp-attachments-dev` (TF token `a5e2154a`), state → `recycle-erp-tfstate`
(`8125b4`). Every token verified scoped (AccessDenied outside its bucket).

## Done

- **C2** prod DB exposure — superuser rotated, read-only `recycle_sync_ro` for the sync.
- **C4** prod admin password rotated.
- **C5** backend R2 over-privilege — fixed; the account-wide `874aaa` key is **destroyed**.
- **H1/H2** origin lockdown (`PROXY_SECRET`, live) + per-env workers/domains.
- **H3** backups — covered by existing hourly `recycle-db-backup`.
- **H4** dev R2 isolation — own bucket + scoped token.
- **M2** sync guards.
- **experiment-dns** — `api.prod/dev.recycleservers.com` applied; certs VALID.
- **Workers repointed** — `BACKEND_URL` → `api.*` hostnames; both deployed + verified.
- **Terraform reconciliation** —
  - `environments/prod`: token replaced with a fresh scoped one via TF (`-replace`);
    `874aaa` destroyed in the process.
  - `environments/experiment-attachments-dev`: new env; dev bucket imported, scoped
    token created via TF; dev backend rewired; interim API tokens revoked.

## Remaining

### Commit the working tree (on `experiment/railway-cloudflare-deploy`)
```
M  deploy/cloudflare/wrangler.toml                         # BACKEND_URL → api.*
?? docs/security-railway-cloudflare-review.md
?? infra/terraform/NEXT-STEPS.md
?? infra/terraform/environments/experiment-attachments-dev/
```
(Left uncommitted to avoid colliding with the parallel session. `.env` is gitignored.)

### Rotate — THIS TRANSCRIPT CONTAINS LIVE PRODUCTION SECRETS
Do these from a private shell; the values below were all surfaced in-session.
1. **`recycle-erp-tfstate-scoped` token `8125b4`** — highest priority: it can read
   the state bucket = every TF-managed secret. Create a new tfstate-scoped R2 token,
   update `infra/terraform/.env`, revoke `8125b4`.
2. **prod Postgres superuser** + **`recycle_sync_ro`** passwords — `ALTER USER … PASSWORD`,
   then update Railway `DATABASE_URL` / Postgres vars / `db-sync PROD_DATABASE_URL`.
3. **prod admin** `admin@recycle.local` — change on first login.
4. **R2 backend tokens** `fa9f673b` (prod) / `a5e2154a` (dev) — secrets were in-session
   and in state; reissue via `terraform apply -replace=…cloudflare_api_token…` in each
   env, then re-wire the backend R2 vars (railway CLI).
5. **Cloudflare API tokens** `cfut_orq0…` (provider, in `.env`) and `cfut_1wh5…` (earlier) — revoke after the rotations above; replace the provider token in `.env`.

## Operational notes
- `infra/terraform/.env` (gitignored): provider token + state-scoped S3 creds.
  Source before terraform: `set -a; . ../../.env; set +a`. `environments/prod` also
  needs `-var-file=prod.tfvars`.
- `railway-mcp` auth lapses; the `railway` CLI (authenticated) was used for var swaps.
- Worker deploys use wrangler's own oauth login: `unset CLOUDFLARE_API_TOKEN && npx wrangler deploy --env prod|dev`.
