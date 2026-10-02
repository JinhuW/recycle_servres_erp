# Backups — cloud changes still to make

The 2026-10-01 code review found gaps in the backup setup that code alone
can't close. The repo side shipped with RS-134: the bucket env var now matches
Terraform's outputs, a failed bucket listing fails the run, and a dump must carry
data for the core tables. The steps below change Cloudflare and Railway, so
each needs an explicit go-ahead before anyone runs it.

## What is wrong today

- The live job writes to **`recycle-db-backup`**, a bucket Terraform doesn't
  manage. `infra/terraform/environments/experiment-backups` manages an unused
  `recycle-erp-backups` instead.
- The job's one credential both uploads and deletes. A bad or compromised run
  can prune every dump, and there's no object lock or versioning to fall back
  on.
- R2 attachments (label scans, sell-order evidence, line photos) have no
  backup at all.
- No restore has ever been rehearsed. `pg_restore --list` reads the table of
  contents only.

## Steps

1. **Bring the live bucket under Terraform.** Point
   `experiment-backups`' `bucket_name` at `recycle-db-backup` and run
   `terraform import` on that bucket, then `plan`. Expect no changes apart from
   the lifecycle rule. Add `prevent_destroy = true`, as the attachments bucket
   has.
2. **Split the credentials.** Give the cron a token scoped to object write on
   that bucket only, and drop `BACKUP_KEEP` pruning from the job (set it to `0`).
   Retention then comes from the bucket lifecycle rule (`lifecycle_expire_days`,
   30), which the cron's token cannot change.
3. **Lock the objects.** Enable an R2 bucket lock rule (retention ≥ 30 days)
   once step 2 is live, so even a leaked write token cannot delete history.
4. **Back up attachments.** Add a second cron step that `rclone sync`s the
   attachments bucket to a `recycle-erp-attachments-backup` bucket, under the
   same split-credential and lock rules.
5. **Rehearse a restore monthly.** In a throwaway Railway Postgres (or locally
   with `postgres:18`), restore the newest dump with
   `pg_restore --clean --if-exists`, then compare `count(*)` of `orders`,
   `order_lines` and `sell_orders` with production. Record the date and the
   counts in this file.

Rollback for steps 1–4 is a Terraform revert. Step 3 cannot be undone until its
retention period ends, which is the point of it.
