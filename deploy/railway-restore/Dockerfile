# One-shot Postgres restore FROM Cloudflare R2 for the EXPERIMENTAL Railway
# deployment. Built and run by Railway as a manual one-off service. NOT part of
# the Docker Compose stack. See docs/deployment-railway-cloudflare-backups.md.
#
# psql must be >= the server major version. The Railway managed Postgres is
# PostgreSQL 18, so this pins the v18 client. Bump this tag if the DB is upgraded.
FROM postgres:18-alpine

# rclone is a single static binary with first-class R2 support; configured
# entirely via RCLONE_CONFIG_R2_* env vars (no config file baked in).
RUN apk add --no-cache rclone

COPY restore.sh /usr/local/bin/restore.sh
RUN chmod +x /usr/local/bin/restore.sh

# Railway runs this once; the script restores and exits.
CMD ["/usr/local/bin/restore.sh"]
