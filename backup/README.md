# Railway Postgres → Cloudflare R2 backup

A **Railway cron service** (`db-sync` in the `recycle-erp-experiment` project)
that dumps the ERP Postgres once a day and stores the dump offsite in
Cloudflare R2. Fully self-contained on Railway.

## How it works

1. Railway runs this service on the cron schedule in `railway.toml`
   (`30 3 * * *`, i.e. 03:30 UTC daily).
2. `backup.sh` runs `pg_dump --format=custom` against `DATABASE_URL` (the
   Postgres service, reached over Railway's **private network**), gzips it,
   verifies it with `pg_restore --list`, and `rclone copy`s it to R2.
3. Old dumps are pruned to the newest `BACKUP_KEEP` (30).
4. The script exits — required for Railway cron (a lingering process makes
   Railway skip the next run).

Result: `recycle-db-backup/railway-erp/recycle_erp_railway_<UTC>.dump.gz`.

## Files (Infrastructure as Code)

| File | Purpose |
| --- | --- |
| `railway.toml` | Build + deploy config: Dockerfile builder, `cronSchedule`, `restartPolicyType`. The service's config-file path points here. |
| `Dockerfile` | `FROM postgres:18` (matching client) + `rclone`; non-secret config as `ENV`. |
| `backup.sh` | Dump → integrity-check → upload → prune. |

Secrets are **not** in code (Railway config-as-code can't hold variables).
Set on the service: `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, and `DATABASE_URL` as a reference to
`${{Postgres.DATABASE_URL}}`.

## Restore

    aws s3 cp --endpoint-url "$R2_S3_ENDPOINT" \
      s3://recycle-db-backup/railway-erp/<file>.dump.gz .
    gunzip -c <file>.dump.gz | pg_restore -d "$TARGET_DATABASE_URL" --clean --if-exists

## Debug note — pg_dump version must be ≥ server major

**Trap:** the Railway Postgres is **PostgreSQL 18.x**. `pg_dump` refuses to dump
a server whose major version is newer than the client, with:

    pg_dump: error: server version: 18.x; pg_dump version: 16.x
    pg_dump: error: aborting because of server version mismatch

That is why this job runs from a **`postgres:18`** image: the client must be at
least as new as the Railway server (18.x), or `pg_dump` aborts.

**Rule:** keep the Dockerfile `FROM postgres:<N>` where `N >=` the Railway
server's major version. If Railway upgrades Postgres (e.g. to 19), bump the
image tag to match, or dumps start failing the integrity gate.
