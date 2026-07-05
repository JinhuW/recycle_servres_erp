# Scheduled Postgres -> Cloudflare R2 backup for the EXPERIMENTAL Railway
# deployment. Built and run by Railway as a cron service. NOT part of the
# Docker Compose stack. See docs/deployment-railway-cloudflare-backups.md.
#
# pg_dump must be >= the server major version. The Railway managed Postgres is
# PostgreSQL 18, so this pins the v18 client. Bump this tag if the DB is upgraded.
FROM postgres:18-alpine

# rclone is a single static binary with first-class R2 support; configured
# entirely via RCLONE_CONFIG_R2_* env vars (no config file baked in).
RUN apk add --no-cache rclone

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Railway invokes this once per cron tick; the script dumps, uploads, and exits.
CMD ["/usr/local/bin/backup.sh"]
