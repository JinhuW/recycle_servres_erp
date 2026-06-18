# Postgres → Cloudflare R2 backups (Railway deployment)

> **Status: documented, not yet provisioned.** This note + the committed files
> (`infra/terraform/environments/experiment-backups/`, `deploy/railway-backup/`)
> are a ready-to-apply procedure. Nothing has been `terraform apply`'d or
> deployed to Railway yet.
>
> This started on the experimental Railway + Cloudflare deployment (see
> [deployment-railway-cloudflare.md](./deployment-railway-cloudflare.md)) but is
> written to **graduate to production** — the experiment is intended to become
> the real prod path. Where prod differs from the experiment, it's called out.

## Approach

Stream a compressed logical dump straight from the Railway Postgres to a
dedicated R2 bucket, on a schedule, with automatic retention:

```
Railway cron service (db-backup)
  pg_dump --no-owner --no-privileges $DATABASE_URL   (private network, no public DB)
    | gzip -9
    | rclone rcat  r2:recycle-erp-backups/postgres/recycle-erp-<UTC-timestamp>.sql.gz
                         │
                         └── R2 lifecycle rule auto-deletes objects > 30 days
```

No local disk, no volume. The job runs inside Railway so it reaches Postgres
over the private network — the database is never publicly exposed.

### Why a dedicated bucket + its own token

The backend's existing R2 token is **scoped to the attachments bucket only**, so
it cannot write backups. Backups get their own bucket (`recycle-erp-backups`)
and a **bucket-scoped** token — a leaked backup credential can't touch
attachments or the Terraform-state bucket, and vice versa.

## Files in this repo

| Path | Purpose |
|------|---------|
| `infra/terraform/environments/experiment-backups/main.tf` | R2 bucket + 30-day lifecycle + bucket-scoped R2 token + outputs |
| `infra/terraform/environments/experiment-backups/backend.tf` | Terraform state in the `recycle-erp-tfstate` R2 bucket (key `experiment-backups/`) |
| `deploy/railway-backup/Dockerfile` | `postgres:18-alpine` + `rclone` |
| `deploy/railway-backup/backup.sh` | the dump→gzip→R2 stream |

## Provisioning steps (when ready)

### 1. Create the bucket + token (Terraform)

`terraform apply` needs the **account-scoped** `CLOUDFLARE_API_TOKEN` (the one
used for `environments/prod`, kept in your shell — not in `.env`) plus the R2
state-bucket creds as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (same as a
prod `terraform init`).

```bash
cd infra/terraform/environments/experiment-backups
terraform init
terraform apply
# Capture the (sensitive) outputs for step 2:
terraform output -raw r2_s3_endpoint        # → RCLONE_CONFIG_R2_ENDPOINT
terraform output -raw bucket_name           # → R2_BACKUP_BUCKET
terraform output -raw r2_access_key_id      # → RCLONE_CONFIG_R2_ACCESS_KEY_ID
terraform output -raw r2_secret_access_key  # → RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
```

### 2. Create the Railway cron service

In the `recycle-erp-experiment` project, add a service `db-backup`:

- **Source:** the GitHub branch (same repo as `backend`).
- **Build:** root directory `deploy/railway-backup`, Dockerfile `Dockerfile`.
- **Cron schedule:** `0 3 * * *` (daily 03:00 UTC).
- **Restart policy:** `NEVER` (cron triggers the next run; don't loop on exit).
- **Variables:**

  | Variable | Value |
  |----------|-------|
  | `DATABASE_URL` | reference `${{Postgres.DATABASE_URL}}` |
  | `R2_BACKUP_BUCKET` | `bucket_name` output |
  | `RCLONE_CONFIG_R2_TYPE` | `s3` |
  | `RCLONE_CONFIG_R2_PROVIDER` | `Cloudflare` |
  | `RCLONE_CONFIG_R2_ACCESS_KEY_ID` | `r2_access_key_id` output |
  | `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY` | `r2_secret_access_key` output |
  | `RCLONE_CONFIG_R2_ENDPOINT` | `r2_s3_endpoint` output |
  | `RCLONE_CONFIG_R2_REGION` | `auto` |
  | `RCLONE_CONFIG_R2_NO_CHECK_BUCKET` | `true` |

### 3. Verify

To test before the first cron tick, temporarily clear the cron schedule and
deploy once so the container runs immediately; read its logs for
`[backup] done: …`, confirm the object appears in R2, then restore the schedule.

```bash
# List backups in R2 (from a host with the backups creds + rclone/aws configured)
rclone ls r2:recycle-erp-backups/postgres/
```

## Restore

```bash
# Stream a backup back into a database. NOTE: --no-owner/--no-privileges dumps
# restore cleanly into a fresh DB; for an existing DB, drop/recreate first.
rclone cat r2:recycle-erp-backups/postgres/recycle-erp-<timestamp>.sql.gz \
  | gunzip \
  | psql "$TARGET_DATABASE_URL"
```

Do a restore drill into a throwaway DB periodically — an untested backup is not
a backup.

## Promoting to production

When this deployment becomes prod:

- **Fold the bucket/token into the managed Terraform.** Move these resources
  from the isolated `experiment-backups` env into `environments/prod` (or a
  shared module), so prod state owns them. Consider `prevent_destroy` on the
  bucket once it holds real backups.
- **Revisit retention.** 30 days suits an experiment; prod may want longer plus
  a weekly/monthly tier (a second lifecycle prefix, or object-versioning).
- **Pin the `pg_dump` version to the prod server major.** The image is pinned to
  `postgres:18-alpine` because the Railway managed DB is PG 18. (The Docker-stack
  prod is PG 16 — match whichever server you back up; `pg_dump` must be ≥ the
  server.)
- **Alerting.** A silent cron failure is the classic backup trap. Add a
  failure alert (Railway deploy-failure notification, or a dead-man's-switch
  ping at the end of `backup.sh`).

## Alternative: pgbackrest / PITR

Railway's managed Postgres template ships **pgbackrest** with WAL archiving to a
bucket (visible in the Postgres service boot logs). That enables
point-in-time recovery, not just daily snapshots — more powerful but
template-specific and less transparent than this `pg_dump` approach. Worth
evaluating for prod if you need PITR rather than daily logical dumps.
