# WS-C — Secrets, backups and edge: fix plan

Planned on `origin/dev` f0c1d856 (2026-10-31). Planning only: nothing below has
been run. Every live step is an **owner gate**.

## 1. Goal and scope

Finish the 2026-10-21 Railway-breach rotation and shrink what one leaked
credential can do. That means four things:

- Split the Facebook control-plane secrets so the internet-facing rs-console
  holds only its own token.
- Make the offsite DB backups impossible for their own writer to delete.
- Put Cloudflare Access in front of `fbc-api`, and apply the committed R2 CORS
  fix.
- Clean up the office Mac: a stray secrets `.bak`, stale deployable clones, an
  unversioned memtrade and open LAN servers.

Findings covered (17): A10-01, A10-21, A11-02 (absorbs B2-03), B1-02, B1-06,
B2-01, B2-02, B2-04, B2-05, B2-06, B2-07, B4-05, B5-04, B5-05, B5-06, B5-07,
B5-08.

The scope line also names "OpenSearch/Alertmanager LAN exposure". No such
finding is in this input: B3-03, OpenSearch on 10.10.10.73, belongs to
**WS-A**.

Facts checked in code that shape the plan:

- **The console doesn't use the control-plane secrets.** rs_console reads only
  `RS_CONSOLE_TOKEN`, `RS_ADMIN_TOKEN` / `RS_COORDINATOR_ADMIN_TOKEN`,
  `RS_COORDINATOR_URL` and config paths (`rs_console/rs_console/app.py:214`,
  settings). It never reads `RS_VAULT_KEY`, `RS_WORKER_TOKEN_SECRET` or
  `RS_DATABASE_URL`. Those reach it only through
  `deploy/docker-compose.console.yml:29-30` (`env_file: ../configs/secrets.env`).
- **The live VM runs only fleet-agent workers** (`rs-fleet-homelab-1..9`, TS)
  plus the coordinator, console and agent. Per A10-01's evidence, the
  fleet-agent workers don't carry the control-plane names. The 2026-10-23 note
  about the Postgres DSN being "in ~42 homelab containers" is stale. After the
  split, only the **coordinator** needs the DSN, vault key and token secret.
  Recreating the coordinator or console is **not a login**.
- **The vault can't be re-keyed today.** `vault.py` holds a single Fernet key.
  `rsc vault init` refuses to overwrite, because rotation "makes every secret
  already in the vault unreadable" (`cli.py:296-305`). Sealed blobs live in:
  - `accounts.secret_blob`
  - session snapshots (`state_blob`)
  - device profiles (`device_cookies_blob`)
- **R2 has no write-only API token.** The permission groups are Object Read
  and Object Read & Write. A put-only key (runbook step 2, A11-02's proposal)
  can't be made. The bucket **lock** is what stops the writer deleting history,
  so the cron must stop pruning first.
- **All of the ERP's rs_console traffic goes through one place.**
  `upstream()` / `callFacade()` in `apps/backend/src/routes/coordinator.ts:30-46`
  serves `facebookPool.ts`, `fleet/proxyHealth.ts` and `vncBridge.ts`. All of
  it already sends `CF-Access-Client-*` when `COORDINATOR_ACCESS_CLIENT_ID` /
  `_SECRET` are set.
- **The breach rotation is partly done.** `RS_CONSOLE_TOKEN` =
  `COORDINATOR_API_TOKEN` was rotated on 2026-10-22. The rotation log of
  2026-10-23 still lists three things as pending: "R2 x3", the facebook-tracker
  DB password and `FB_POOL_KEY`.

## 2. Tickets

RS numbers are assigned at implementation time (`scripts/ticket.sh new`, then
renumbered against the latest `dev`). C1–C6 are this plan's labels.

| # | Title | Findings | Sev | Versions under | Worker restart? | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Facebook control-plane secret split, vault re-key tool, secret scanner | A10-01, A10-21 | P1 | `trackers/facebook` VERSION minor + `release.sh` | No: console + coordinator recreate only | L |
| C2 | Post-breach rotation of the facebook-tracker DB password and control-plane keys | B1-02 | P1 | none (runbook in `trackers/facebook/deploy/README.md`) | No, after C1 | M |
| C3 | Backup bucket under Terraform, with lock, lifecycle, a new key and no pruning | A11-02 (+B2-03), B2-04, B2-05, B1-06 | P1 | ERP root bump (minor) | No | L |
| C4 | Access in front of fbc-api; apply the attachments CORS | B2-01, B2-02 | P2 | ERP root bump (patch) | No | M |
| C5 | ERP Worker hygiene: retired Worker, default name, observability, deploy tag, ancestry guard | B2-06, B2-07 | P3 | ERP root bump (patch) | No | S |
| C6 | Office Mac hygiene: reddit `.bak`, stale clones, memtrade repo and backup, session perms, LAN servers | B4-05, B5-04, B5-05, B5-06, B5-07 | P2 | none (`trackers/reddit` `.gitignore` only; trackers-only push is exempt) | No | M |

B1-06 (Vaultwarden backups) rides C3: the same "every store holding secrets
has an offsite, delete-proof copy" check closes it, and it needs no code.

---

### C1 — Facebook control-plane secret split, vault re-key tool, secret scanner (P1)

**Closes:** A10-01, A10-21.

**Versions:** `trackers/facebook/VERSION` minor bump, `CHANGELOG.md` there, cut
with `scripts/release.sh`, tag `facebook-tracker/vX.Y.Z`. Release with a merge
commit so the tag stays on `dev`.

**Deploy:** the console-only recipe (memory `console-only-deploy`), plus a
coordinator-only recreate. **Never `scripts/deploy.sh`**: it restarts workers,
and A10-02 (WS-D) is rewriting it.

**Change**

1. **Split the env files.** All three names are already gitignored by
   `configs/secrets.*.env` and `configs/secrets.env`
   (`trackers/facebook/.gitignore:7-9`).
   - `configs/secrets.env` keeps only shared, worker-safe values:
     `OPENROUTER_API_KEY`, `TELEGRAM_*`, `RS_COORDINATOR_URL` /
     `RS_COORDINATOR_TOKEN`, `RS_ALERT_REPORT_URL`.
   - New `configs/secrets.coordinator.env` (coordinator only):
     `RS_VAULT_KEY`, `RS_VAULT_KEY_PREVIOUS` (new, optional),
     `RS_WORKER_TOKEN_SECRET`, `RS_ADMIN_TOKEN`, `RS_DATABASE_URL`.
   - New `configs/secrets.console.env` (console only): `RS_CONSOLE_TOKEN`,
     `RS_ADMIN_TOKEN`. The console forwards upstream with the admin token,
     `docker-compose.console.yml:26-28`.
   - Templates: move the "Control plane" block of `configs/secrets.env.example`
     (lines 103-121) into new `configs/secrets.coordinator.env.example` and
     `configs/secrets.console.env.example`. Leave a pointer comment in
     `secrets.env.example`.
2. **Compose files.**
   - `deploy/docker-compose.coordinator.yml:31-32`:
     `env_file: [../configs/secrets.env, ../configs/secrets.coordinator.env]`.
     Fix the comment at :26-29.
   - `deploy/docker-compose.console.yml:29-30`: `env_file:
     [../configs/secrets.console.env]` only. Fix the comment at :26-28 and the
     header ("holds the admin token so it never leaves the VM" stays true).
   - `deploy/docker-compose.messenger.yml:36-37`, `docker-compose.poster.yml:35-36`
     and `docker-compose.matrix.yml:89-92` keep `secrets.env`. After the split it
     holds no control-plane names, so nothing changes there except comments.
     They are dormant on the VM, but a future `up` must not re-leak.
   - `deploy/docker-compose.fleetd.yml:52,61` stays as is: it mounts
     `secrets.env`, which is now worker-safe. Fix the :24 comment. rs_fleetd is
     dormant (A10-43, WS-G).
   - `docker-compose.coordinator-lan.yml` / `registry.yml` take
     `--env-file secrets.coordinator-lan.env` for interpolation only. Check
     during implementation that neither `env_file`s `secrets.env`.
3. **Vault re-key** (so `RS_VAULT_KEY` can be rotated without losing the vault).
   - `rs_coordinator/rs_coordinator/vault.py`: `Vault.__init__` builds a
     `MultiFernet([new, previous])` when `RS_VAULT_KEY_PREVIOUS` is set. It
     encrypts with the new key and decrypts with either. Add
     `Vault.rotate(blob) -> bytes` (`MultiFernet.rotate`).
   - `rs_coordinator/rs_coordinator/cli.py`: new `rsc vault rekey [--dry-run]`.
     In one transaction per table it walks `accounts.secret_blob`, session
     snapshot `state_blob` and device-profile `device_cookies_blob`. It rewrites
     each blob with `rotate()` and prints counts only. Add `db.py` / `pg.py`
     helpers `iter_sealed_blobs()` and `replace_sealed_blob(table, key, blob)`
     on both backends; the SQLite and Postgres parity pattern already exists
     (`rekey_device_profile`, `db.py:2132`, `pg.py:1389`).
   - `rsc vault init --force` text (`cli.py:302`): point to `rekey` instead of
     warning that rotation orphans the vault.
4. **Secret scanner** (A10-21), `scripts/check-secrets.sh`.
   - Path rule (:40-41): mirror the `.gitignore` credential block.
     - Refuse `configs/secrets.*.env`, `configs/account_info.txt*`,
       `configs/proxies.decodo.txt`, `configs/data.txt` and
       `configs/*.local.toml`.
     - Allow `configs/secrets.*.env.example`.
   - Content rules (:94-104):
     - Add a case-insensitive unquoted rule:
       `^[[:space:]]*(export[[:space:]]+)?[A-Za-z_]*(PASSWORD|TOKEN|SECRET|API_KEY|VAULT_KEY)[A-Za-z_]*=[^$"'[:space:]][^[:space:]]{15,}`
       in `.env`-shaped and shell files only. That avoids the Python
       expressions the quoted rule's comment warns about.
     - Add JSON `"(totp_secret|password|access_token)"[[:space:]]*:[[:space:]]*"[^"]{8,}"`.
     - Add URL credentials `[a-z]+://[^/:@[:space:]]+:[^@/[:space:]]{6,}@`
       (postgres, proxy) and `syt_[A-Za-z0-9_]{20,}`.
   - Narrow `PLACEHOLDER`'s bare `\.\.\.` so a line with a real value plus
     `...` is not whitelisted. Accept only a value that is wholly `...` or ends
     in `...`.

**Tests**

- `scripts/tests/test_compose_secret_scope.py` (new, pytest + PyYAML, as in the
  other `scripts/tests/*.py`). It parses every `deploy/docker-compose*.yml` and
  fails when:
  - any service other than `coordinator` has `secrets.coordinator.env` in
    `env_file`;
  - any service other than `console` has `secrets.console.env`;
  - a control-plane name (`RS_VAULT_KEY`, `RS_WORKER_TOKEN_SECRET`,
    `RS_DATABASE_URL`, `RS_ADMIN_TOKEN`, `RS_CONSOLE_TOKEN`) appears in
    `configs/secrets.env.example`.

  Add it to the test step of `scripts/release.sh` (:92-95).
- `rs_coordinator/tests/test_vault_cli.py`:
  - `rekey` round-trip on SQLite. Seal with key A, set
    `RS_VAULT_KEY=B, RS_VAULT_KEY_PREVIOUS=A`, rekey, then a `Vault(B)` alone
    opens all three blob kinds and `Vault(A)` fails.
  - `--dry-run` writes nothing.
- `rs_coordinator/tests/test_postgres.py`: the same round-trip on the Postgres
  backend (existing PG fixture).
- `scripts/tests/test-check-secrets.sh`: port
  `docs/review-2026-10-31/repro/A10-verify/a10_21_check_secrets.sh` plus fake
  values for each missed case.
  - `secrets.fleetd.env`, `account_info.txt`, unquoted `RS_VAULT_KEY=…`,
    lowercase `"totp_secret": "…"`, a `postgres://u:p@h` URL, `syt_…`, and a
    `...`-suffixed real value must all be refused.
  - `secrets.coordinator.env.example` must be allowed.
  - The current tree must still pass `--all`.

**Owner gates**

1. Yes/no: recreate `rs-coordinator` and `rs-console` (not workers) on
   10.10.10.73 to pick up the split? It means about 30 s with no fleet page.
   Fleet-agent workers don't depend on the coordinator.
2. Exact action on the VM, names only, before the recreate. Move these lines
   out of `configs/secrets.env`:
   - `RS_VAULT_KEY`, `RS_WORKER_TOKEN_SECRET`, `RS_ADMIN_TOKEN` and
     `RS_DATABASE_URL` into `configs/secrets.coordinator.env` (0600);
   - `RS_CONSOLE_TOKEN` and `RS_ADMIN_TOKEN` into `configs/secrets.console.env`
     (0600).

   Back up the original as a 0600 `.bak` and delete it after verification.
   A10-44 (WS-G) is cleaning up the existing `.bak` files.

**Rollout and verification**

- Merge, then `release.sh`.
- Sync with the console-only recipe:
  1. Drift-check `rs_console/`, `rs_coordinator/` and the two compose files on
     the VM against the tag.
  2. rsync only those.
  3. Run `docker compose -f deploy/docker-compose.console.yml up -d --build
     --force-recreate console`, then the coordinator's compose the same way. Use
     the `-lan` overlay only if `secrets.coordinator-lan.env` exists, as
     `deploy.sh:366-371` does.
- Verify, read-only and names only:
  - `docker inspect rs-console --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1`
    lists none of `RS_VAULT_KEY`, `RS_WORKER_TOKEN_SECRET`, `RS_DATABASE_URL`;
  - the same on `rs-coordinator` lists all of them;
  - `/healthz` on both;
  - the ERP Fleet page loads;
  - `rsc vault rekey --dry-run` inside the coordinator reports blob counts.
- Rollback: restore the `.bak` and the previous compose files, then recreate
  the same two containers.

**Effort:** L.

---

### C2 — Post-breach rotation of the facebook-tracker DB password and control-plane keys (P1)

**Closes:** B1-02.

**Versions:** no code bump. The PR adds a "Rotating control-plane secrets"
section to `trackers/facebook/deploy/README.md` and the ticket; it is a
trackers-only docs push, exempt from the version gate.

**Deploy:** coordinator recreate only, which is not a login. **Depends on C1**
being live, so that the DSN and keys exist in exactly one container.

**Change (runbook content; every step is an owner action)**

1. **Find every DSN consumer, names only.** On 10.10.10.73 and
   `worker@10.10.60.14`, list the containers whose env carries
   `RS_DATABASE_URL` or `DATABASE_URL` pointing at facebook-tracker:
   ```
   for c in $(docker ps -q); do
     docker inspect $c --format '{{.Name}} {{range .Config.Env}}{{println .}}{{end}}' \
       | grep -o '^[^ ]*\|RS_DATABASE_URL\|DATABASE_URL'
   done
   ```
   Also grep crontabs and `~/fleet-ai-bridge` for the DB host name. Expect only
   `rs-coordinator`. If any worker shows up, stop and re-plan: a worker
   recreate is a login.
2. **Regenerate.** Use the Railway dashboard Regenerate on
   `facebook-tracker/production/postgres`, never `ALTER USER`. Follow the
   rotation-log traps: click by `find` ref, don't screenshot, and check by
   sha256[:8] fingerprint.
3. **Update** `RS_DATABASE_URL` in `configs/secrets.coordinator.env`, then
   recreate `rs-coordinator`.
4. **Rotate the vault key.** Put the current `RS_VAULT_KEY` in
   `RS_VAULT_KEY_PREVIOUS` and a new key from `rsc vault init` (print only) in
   `RS_VAULT_KEY`. Recreate the coordinator, run `rsc vault rekey`, check that
   the counts match `--dry-run`, then remove `RS_VAULT_KEY_PREVIOUS` and
   recreate again.
5. **Rotate the token secret and admin token.** First list which live caller
   still presents a coordinator worker or host token. If none (fleet-agent
   authenticates to the ERP), rotate `RS_WORKER_TOKEN_SECRET` now. Otherwise
   re-mint and re-place those tokens in the same step. Rotate `RS_ADMIN_TOKEN`
   in both coordinator and console files, then recreate both.
6. **TCP proxy.** The homelab coordinator reaches Railway Postgres through
   `shortline.proxy.rlwy.net:21141`, so the proxy stays. Railway TCP proxies
   have no IP allowlist, so the rotation is the fix. Keep `sslmode=require` in
   the DSN.

**Tests:** none in code (C1 carries the rekey tests). The runbook's checks are
the regression.

**Owner gates**

1. Yes/no: regenerate the facebook-tracker Postgres password now, accepting a
   coordinator recreate (about 30 s of fleet-page outage, no worker restart)?
2. Yes/no: rotate `RS_VAULT_KEY` with `rsc vault rekey`? It rewrites the
   ciphertext of session snapshots without changing their content: not a login,
   and no session file is touched.
3. Yes/no: rotate `RS_WORKER_TOKEN_SECRET` and `RS_ADMIN_TOKEN`, given the
   step-5 inventory?

**Rollout and verification**

- psql through the proxy with the old password fails. Test with a fingerprint
  check only, no value printed.
- The Railway audit log shows `DatabasePassword.regenerated` for project
  ca12c55b.
- The coordinator's `/healthz` is ok and the ERP Fleet page lists workers.
- `rsc vault status` (`cli.py` near :285) shows every account `SET` under the
  new key alone.
- Update memory `railway-security-disclosure-2026-10-21` to drop the item from
  "still pending".
- Rollback: the previous DSN is gone once regenerated, so there is no rollback
  for step 2. Fix forward. For step 4, keep `RS_VAULT_KEY_PREVIOUS` until
  status is clean.

**Effort:** M (mostly coordinated live work).

---

### C3 — Backup bucket under Terraform, with lock, lifecycle, a new key and no pruning (P1)

**Closes:** A11-02 (with B2-03), B2-04, B2-05, B1-06.

**Versions:** ERP root `package.json` minor bump plus `## [X.Y.Z]` in
`CHANGELOG.md`. `infra/` and `backup/` are on the version-check path list.

**Deploy:** none that restarts workers. Changing variables on Railway
`pg-r2-backup` takes effect at the next cron run.

**Change**

1. **Terraform environment for the real bucket.** Rename
   `infra/terraform/environments/experiment-backups/` to
   `environments/backups/`, with `backend.tf` key `backups/terraform.tfstate`.
   The old key's state is empty, so nothing migrates. In `main.tf`:
   - `bucket_name` default `recycle-db-backup` (the live bucket; `location`
     must match it, so read it during import);
   - `lifecycle { prevent_destroy = true }` on `cloudflare_r2_bucket.backups`;
     drop the "disposable" comment;
   - `cloudflare_r2_bucket_lifecycle.backups`, with rules:
     - `railway-erp/`: expire at `lifecycle_expire_days` = **35**, which must
       exceed the lock;
     - keep the existing multipart-abort rule (read it from the live bucket on
       import so the plan is clean);
     - B2-04, owner's choice: a one-shot `recycle_erp_2026` prefix rule,
       Age 1 day. Lifecycle deletes the 406 root dumps, so no
       delete-capable key is ever handled. Remove the rule in a follow-up
       once the listing shows them gone;
   - new `cloudflare_r2_bucket_lock.backups`: rule `railway-erp/`, condition
     Age, `max_age_seconds = 30 * 86400`. Check the v5 provider schema during
     implementation; if the pinned `~> 5.0` lacks the resource, bump it in
     `.terraform.lock.hcl` in the same PR;
   - `cloudflare_api_token.backups_r2`: name `recycle-db-backup-writer-<date>`,
     permission groups Object Read & Write scoped to this bucket only. Say in a
     comment that R2 has no write-only group and that the lock is the delete
     barrier.
   - Outputs unchanged.
2. **Dev attachments bucket (B2-05).**
   - Owner runs `terraform state list` against the orphan key
     `experiment-attachments-dev/terraform.tfstate`.
   - If it holds `recycle-erp-attachments-dev`, add
     `environments/dev-attachments/` (bucket + CORS + the `r2.dev` setting as
     live) on that same key, so plan shows no changes.
   - If it is empty, delete the key and import into the new directory under
     `dev-attachments/terraform.tfstate`.
3. **Backup job.**
   - `backup/Dockerfile:15`: `BACKUP_KEEP=0`, with a comment that retention is
     the bucket lifecycle and the lock refuses a writer's delete.
   - `backup/backup.sh:98-111` is unchanged: the `KEEP>0` branch stays for
     local and manual use.
   - `backup/README.md`: update the retention text (:16).
4. **Docs.**
   - `docs/backups-cloud-runbook.md`: mark steps 1-3 done with the version.
     Rewrite step 2's "write-only token" to the lock model.
   - `docs/deployment-railway-cloudflare-backups.md:104-116`: replace
     `r2:recycle-erp-backups/postgres/` with `recycle-db-backup/railway-erp/`
     and the `.dump.gz` + `pg_restore` restore that `backup/README.md` already
     documents. Drop the `.sql.gz | psql` block.
   - Coordinate with **WS-I** C2-03 (the `db-sync` naming in
     `backup/README.md:3`) and **WS-D** A11-10 (`backup/railway.toml`). The
     same files are touched, so whichever merges second rebases.
5. **Vaultwarden (B1-06).** No repo code. Owner gate below. Record the policy
   in `docs/agents/erp-ops.md` under backups: "every store holding secrets
   has an offsite copy".

**Tests**

- `backup/tests/keep-zero.sh` (new, plain sh). It puts stub `pg_dump`,
  `pg_restore` and `rclone` on `PATH`, records their argv, runs `backup.sh`
  with `BACKUP_KEEP=0`, and asserts `rclone` saw `copy` and never `lsf` or
  `deletefile`. A second case with `BACKUP_KEEP=2` and a stubbed listing of
  3 files asserts exactly one `deletefile`. Add a step running it to
  `backend-tests.yml` if `backup/**` is in its path filter; otherwise call it
  from the ticket's verification.
- `terraform fmt -check` and `terraform validate` for `environments/backups`
  and `environments/dev-attachments`, run locally, no credentials needed.
- Ports the evidence in `docs/review-2026-10-31/repro/B2-verify/`
  `backup-lock.json` and `backup-lifecycle.json` into the post-apply checks.

**Owner gates**

1. Exact action: run `terraform init` / `import` / `plan` in
   `environments/backups` with `CLOUDFLARE_API_TOKEN` and the state
   credentials. Import `cloudflare_r2_bucket.backups` (`<account>/recycle-db-backup/default`)
   and the existing lifecycle. The plan must show only:
   - the lifecycle update,
   - the lock create,
   - the new token create.

   Anything else, stop.
2. Yes/no, B2-04: delete the 406 root-level June–July dumps from the retired
   stack through the one-shot lifecycle rule? The alternative is to keep one
   named snapshot (e.g. `recycle_erp_20260704T010001Z.dump.gz`); copy it to
   `archive/` first.
3. Exact sequence, in this order:
   1. Apply (new token exists; lock **not yet**, so `-target` everything but
      `cloudflare_r2_bucket_lock`).
   2. Set Railway `pg-r2-backup` `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
      from the outputs and `BACKUP_KEEP=0`, with no redeploy needed for a cron.
   3. After the next 03:30Z run logs `Backup finished.` with no `Pruning` line,
      revoke the old backup token in the dashboard.
   4. Apply the lock.

   Locking before `KEEP=0` is live makes the prune's `deletefile` fail, and the
   run exits non-zero after the upload.
4. Yes/no, B1-06: enable Railway volume backups (daily, 30-day retention) on
   vaultwarden volume `3c4b4b10-…`? Separately, owner reads `SIGNUPS_ALLOWED`
   in the dashboard and confirms it is `false`, and confirms the `ADMIN_TOKEN`
   policy is intended.

**Rollout and verification**

- `terraform plan` in `backups` and `dev-attachments` shows no changes.
- `GET r2/buckets/recycle-db-backup/lock` shows the `railway-erp/` rule.
- The owner puts a canary `railway-erp/lock-canary-<date>.txt` with the cron's
  new key, then a delete with the same key returns 403. The canary expires by
  lifecycle.
- The object list shows no keys outside `railway-erp/` (B2-04) a day after the
  rule.
- Railway logs show the nightly run with no `Pruning`.
- The audit log shows `Backup.created` for vaultwarden project 1f5ba707 the
  next day.
- Rollback:
  - The lock can be removed by an account admin (not the writer key).
  - `BACKUP_KEEP` can go back to 30 only after the lock is removed.
  - `prevent_destroy` blocks the dangerous case by design.

**Effort:** L.

---

### C4 — Access in front of fbc-api; apply the attachments CORS (P2)

**Closes:** B2-01, B2-02.

**Versions:** ERP root patch bump plus CHANGELOG. The changes are in
`apps/backend/tests` and `deploy/railway-uptime/`.

**Deploy:** backend and uptime cron redeploy through the normal dev → main
release. Nothing on the VM changes, and no worker is touched.

**Change**

1. **Access app.** This is a live, owner-only step (gate 1); the order matters.
   1. Create an Access **service token** `erp-backend-fbc-api`.
   2. Set `COORDINATOR_ACCESS_CLIENT_ID` / `_SECRET` on Railway backend prod
      and dev, then deploy. `upstream()` sends them as soon as both exist
      (`coordinator.ts:38-43`).
   3. Only then create a self-hosted Access application for
      `fbc-api.recycleservers.com` with these policies:
      - Service Auth: that token;
      - Allow: the owner's email, for the standalone console at `/`;
      - Bypass: `/healthz` only, if the uptime probe needs it.
   - Enabling the app first would turn every ERP Fleet, Pool and VNC call into
     an Access 302.
2. **ERP regression test**, `apps/backend/tests/coordinator-routes.test.ts`.
   Assert that `callFacade` (one Pool route and `/api/coordinator/workers`) and
   the VNC bridge upgrade (`vnc-bridge.test.ts`) send `CF-Access-Client-Id` /
   `-Secret` when the env pair is set, and omit both when either is blank.
   This locks in the contract that the Access rollout depends on.
3. **Edge probe**, `deploy/railway-uptime/check.sh`. Add one check:
   `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' https://fbc-api.recycleservers.com/v1/workers`
   with no headers. It must be 302 to `*.cloudflareaccess.com` or 403 with a
   `cf-access-*` / Access body. An origin 401 JSON alerts "fbc-api is not
   behind Access". **WS-B** (B1-04) is also editing this script for 429
   handling. Merge after WS-B's change or rebase on it, and route the alert
   through the same relay.
4. **Docs.** The AGENTS.md Contracts row (:72), `trackers/facebook/AGENTS.md:43`
   and `coordinator.ts:37-38` already claim Access. Keep them, and add "probe:
   `deploy/railway-uptime/check.sh`" to the AGENTS.md row. Only if the owner
   chooses public exposure (gate 1 = no): change all three to say the console
   bearer is the only factor. **WS-I** owns the wider AGENTS contract rewrite
   (C2-02), so coordinate the line.
5. **CORS (B2-02).** No code: `infra/terraform/environments/prod/main.tf:32-36`
   is already right. Owner applies (gate 2).

**Tests:** items 2 and 3 above; the probe runs every uptime tick. CORS check:
`docs/review-2026-10-31/repro/B2-verify/attachments-cors-probe.txt` turned
into the post-apply command list.

**Owner gates**

1. Yes/no: put fbc-api behind Cloudflare Access in the order above? Before
   that, read-only: does an Access app already exist (Zero Trust → Access →
   Applications; the wrangler token can't list it), and are
   `COORDINATOR_ACCESS_CLIENT_ID` / `_SECRET` set on Railway backend prod and
   dev (names only)?
2. Exact action: in `infra/terraform/environments/prod`, run
   `terraform plan -target=module.cloudflare.cloudflare_r2_bucket_cors.attachments`.
   It must be exactly 1 in-place update, then apply that target only. A full
   plan may also want to change `cloudflare_api_token.backend_r2` if the token
   was touched out of band; don't let a CORS fix silently rotate the backend's
   R2 key.
3. Yes/no (beyond these findings, from the 10-23 "R2 x3" pending list): rotate
   the prod attachments token with `terraform apply
   -replace=module.cloudflare.cloudflare_api_token.backend_r2`, then update the
   backend's R2 vars and redeploy in the same window? The dev attachments
   token is the third key; it goes with C3's `dev-attachments` import.

**Rollout and verification**

- After gate 1, the unauthenticated curl above returns 302 or 403 from Access.
- The ERP Fleet, Pool and VNC pages work on inventory-dev, then on prod after
  release.
- The uptime probe is green.
- After gate 2, for each origin in `prod/main.tf`:
  `curl -sI -H "Origin: $o" https://static.recycleservers.com/<known object> | grep -i access-control-allow-origin`
  echoes `$o`.
- Carry a photo into a replacement line on inventory-prod.
- Rollback: set the Access app's policy to Bypass, which is instant;
  `terraform apply` of the old origin list restores the previous CORS.

**Effort:** M.

---

### C5 — ERP Worker hygiene (P3)

**Closes:** B2-06, B2-07. It also carries the optional ancestry-guard
suggestion from the stale-checkout finding, because it edits the same file;
C6 owns that finding.

**Versions:** ERP root patch bump plus CHANGELOG (`deploy/` path).

**Deploy:** the normal frontend Worker deploy (`deploy-frontend.yml`). No
worker restart.

**Change**

- `deploy/cloudflare/wrangler.toml`.
  - Top-level `name` becomes `recycle-erp-no-env`, and add top-level
    `workers_dev = false`. A bare `wrangler deploy` then creates an unrouted,
    unreachable Worker instead of republishing a public copy. `workers_dev`
    is inherited, so prod and dev also lose `*.workers.dev`; check that nothing
    uses it (gate 2).
  - Add `[observability] enabled = true`, `head_sampling_rate = 0.1`
    (inherited by both envs).
- `deploy/cloudflare/deploy.sh:43`.
  - Pass `--tag "$(git rev-parse --short=8 HEAD)" --message "${GITHUB_REF_NAME:-local $(git rev-parse --abbrev-ref HEAD)}"`.
    Confirm the flag names against `npx wrangler@4.146.0 deploy --help`
    first; if `deploy` lacks `--tag`, use `versions upload --tag` +
    `versions deploy`.
  - Ancestry guard for local runs only (`CI` unset): run `git fetch -q origin
    main dev`. Then require `git merge-base --is-ancestor origin/main HEAD` for
    `prod` and `origin/dev` for `dev`, else exit 2 with "HEAD is behind
    origin/<branch>; deploy from a current checkout". It doesn't protect the
    stale clones that already exist (they carry the old script); C6 archives
    those.

**Tests**

- `deploy/cloudflare/test-deploy-guard.sh` (new). In a temp git repo with a
  fake `origin`, stub `npx` / `pnpm` / `curl` on `PATH`. A HEAD behind
  `origin/main` exits 2 for `prod`, a current HEAD reaches the stubbed
  wrangler with `--tag`, and `CI=1` skips the guard. Wire it into
  `deploy-frontend.yml` before the deploy step (WS-D A11-06 is moving that
  workflow's tests onto PRs; follow its structure).
- `npx wrangler@4.146.0 deploy --env dev --dry-run` validates the toml.

**Owner gates**

1. Exact action: delete the Worker `recycle-erp-experiment` (dashboard or
   `wrangler delete --name recycle-erp-experiment`).
2. Yes/no: turn off `*.workers.dev` for recycle-erp-prod and -dev too? Read
   first that no probe or CI step uses those hostnames.
3. Yes/no: Workers Logs at 10% head sampling (billing)?

**Rollout and verification**

- After the next dev deploy, `wrangler deployments list --env dev` shows the
  8-char SHA as the tag.
- The script settings show observability enabled.
- `GET workers/scripts` lists no `recycle-erp-experiment`.
- `deploy.sh` smoke checks are green.
- Rollback: revert the PR, which redeploys the previous settings.

**Effort:** S.

---

### C6 — Office Mac hygiene (P2)

**Closes:** B4-05, B5-04, B5-05, B5-06, B5-07.

**Versions:** `trackers/reddit/.gitignore` only. Reddit has no release, and a
trackers-only push is exempt from the ERP bump. Everything else is owner
action on the office Mac and in `~/Projects/wehat_ai/memtrade` (outside this
repo).

**Deploy:** none.

**Depends on:** **WS-A** B5-01 / B5-02 (unload `fbmonitor`, its watchdog and
`search-probe`) and **WS-B** B5-03 (`keyword-eval`) before the legacy
`facebook_tracker` clone is moved: their launchd jobs run from it.

**Change**

1. **B4-05.** In `trackers/reddit/.gitignore:9`, replace `secrets.env` with
   `secrets.env*` and add `!secrets.env.example` (the template exists at
   `trackers/reddit/scripts/secrets.env.example`).
2. **B5-04, archive** (owner, following `legacy-tracker-checkouts-archived`).
   - Move these into `~/Projects/_archive/` with a `README.md` naming what
     each was and when it was archived:
     - `~/Projects/recycle_servers/recycle_servres_erp{,-dev-2,-dev-3,-dev-4,-main-3}`;
     - `~/Projects/recycle_servers_v2/recycle_servres_erp-{handfish,lancetfish}`;
     - after the WS-A/WS-B unloads, `~/Projects/recycle_servers/facebook_tracker`.
   - Before moving, `git status` in each. Clones with uncommitted work go to
     the owner first.
   - Run `railway unlink` in `recycle_servres_erp-handfish` first.
3. **B5-06** (owner). `chmod 600` the three session files in the legacy clone
   now, before the move. This touches neither the content nor any browser, so
   it is not a login. Once WS-A has unloaded the jobs, nothing reads them.
   After archive, `find ~/Projects/_archive -path '*configs/sessions/*' -perm +044`
   is empty.
4. **B5-05, memtrade** (owner or an agent session in that folder, outside this
   repo).
   1. Write `.gitignore`: the three token files, `data/`, `logs/`, `.env*`,
      `node_modules/`.
   2. Check that `git status --short --ignored` shows the token files ignored.
   3. Make the initial commit.
   4. Create a **private** GitHub repo and push.
   5. Back up `data/memtrade.sqlite` with a nightly launchd job:
      `sqlite3 data/memtrade.sqlite ".backup data/backup/memtrade-$(date +%F).sqlite"`,
      then `rclone copy` to a new `memtrade-backup` R2 bucket. That bucket gets
      its own bucket-scoped token and the C3 lock and lifecycle pattern, so add
      it to `environments/backups` in a follow-up. The alternative is Time
      Machine to an external disk.
   - Record the remote in the AGENTS.md Contracts paragraph about memtrade (one
     line; coordinate with **WS-I**).
5. **B5-07, LAN servers** (owner). The owner's own previews workflow needs
   `http://10.10.100.225:8800` from another host (10.10.100.106 seen in the
   log), so binding to loopback would break it.
   - Replace `python3 -m http.server` in `com.jinhu.archify-previews` with a
     ~30-line Python server. It allows only the owner's client addresses
     (default `127.0.0.1`, `10.10.100.106`), returns 403 to everyone else and
     serves no directory index.
   - Put the same allowlist in front of memtrade-web (`*:8780`), either in
     memtrade's serve command or with the macOS `pf` anchor below.
   - Alternative to both, without code: a `pf` anchor allowing 8780/8800 only
     from the allowlist.
   - Move the 2026-10-31 review pages out of `~/archify-previews` once the
     fixes ship.
   - Turning on the macOS application firewall is the owner's call, because it
     prompts for every listening binary.

**Tests:** in-repo,
`git check-ignore trackers/reddit/scripts/secrets.env.bak-x` matches and
`git check-ignore trackers/reddit/scripts/secrets.env.example` does not. Add
both as a 2-line check in the PR description (no reddit test harness for
ignores). The rest is owner verification below.

**Owner gates**

1. Yes/no: delete `trackers/reddit/scripts/secrets.env.bak-20261022-192641` in
   the main checkout? The rotation it backs up was verified on 2026-10-22, per
   the rotation log.
2. Yes/no: archive the seven ERP clones listed and, after the WS-A/WS-B
   unloads, the legacy `facebook_tracker` clone? And `railway unlink` handfish?
3. Yes/no: `chmod 600` the three legacy session files now?
4. Yes/no: create a private GitHub repo for memtrade and push. Which backup
   target: R2 bucket or Time Machine?
5. Exact answer: which client IPs may reach :8800 and :8780? Allowlist server
   or `pf`?

**Rollout and verification**

- `git status` in the main checkout no longer lists the `.bak`.
- `ls ~/Projects/recycle_servers ~/Projects/recycle_servers_v2` shows no ERP
  clone outside the main clone and Orca worktrees.
- `grep -l production ~/.railway/config.json` maps no non-worktree path.
- `git -C ~/Projects/wehat_ai/memtrade log -1` succeeds, `git status --short`
  has no `src/`, and the first nightly backup object exists.
- From another LAN host, `curl -o /dev/null -w '%{http_code}' http://10.10.100.225:8800/`
  returns 403, and from the allowlisted host it returns 200.
- Rollback: move folders back out of `_archive`, revert the plist.

**Effort:** M, mostly owner time.

## 3. Order

1. **C1.** It unblocks C2; the console stops holding the vault.
2. **C2**, right after C1 is live. It is the actual post-breach rotation.
3. **C3**, independent of C1 and C2, so it can run in parallel with C1's
   development. Its live steps are strictly sequenced (gate 3).
4. **C4**, ERP-side test and probe. The Access enablement waits for the env
   vars to be live on prod.
5. **C6.** The in-repo part (`.gitignore`) can go any time. The archive waits
   on WS-A and WS-B.
6. **C5**, any time; P3.

Cross-workstream dependencies:

| Ticket | Depends on / coordinates with | Why |
| --- | --- | --- |
| C1 | WS-D A10-02 (deploy.sh rewrite), WS-G A10-43 (rs_fleetd dormant), WS-G A10-44 (VM `.bak` cleanup) | C1 must not ship through `deploy.sh`; the compose comments must agree; the `.bak` files from C1's step also need A10-44's cleanup |
| C3 | WS-I C2-03, WS-D A11-10 | Same `backup/README.md` / `railway.toml` lines |
| C4 | WS-B B1-04 | Same `deploy/railway-uptime/check.sh` |
| C4 | WS-I C2-02 | Same AGENTS.md Contracts row |
| C5 | WS-D A11-06 | Same `deploy-frontend.yml` test step |
| C6 | WS-A B5-01 / B5-02, WS-B B5-03 | Their launchd jobs run from the legacy clone C6 archives |

Outside every workstream's findings but on the same pending list:
`FB_POOL_KEY` re-seal (ERP pool vault) and Telegram, Mercury, PayPal, Shippo,
eBay and SMTP rotations. They are not planned here. C2's runbook links the
pending list so it is not forgotten.

## 4. Dropped / deferred

| ID | Disposition | Reason |
| --- | --- | --- |
| B5-08 | Dropped here, closed by **WS-A** B5-01 | The `pkill chrome-headless-shell` lives in the legacy clone's `watchdog.sh`, run by `com.recycleservers.fbmonitor-watchdog`. WS-A's B5-01 unloads that job (its fix says "do the same for the watchdog"), and C6 then archives the script. No code fix is worth making in an archived checkout. Verify in C6: `launchctl list \| grep fbmonitor-watchdog` is empty. |
