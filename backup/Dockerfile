# Railway cron service image: dumps the Railway ERP Postgres to Cloudflare R2.
#
# Pinned to postgres:18 so pg_dump/pg_restore match the Railway server's major
# version (18.x). A client older than the server refuses to dump, so this pin
# is load-bearing — do not downgrade it below the server's major version.
FROM postgres:18

# rclone uploads the dump to R2 (S3-compatible). ca-certificates for TLS to R2.
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Non-secret configuration lives in code (here); secrets and DATABASE_URL are
# injected as Railway variables. Override any of these via service variables.
ENV BACKUP_R2_BUCKET=recycle-db-backup \
    BACKUP_R2_PREFIX=railway-erp \
    BACKUP_KEEP=30 \
    BACKUP_NAME_PREFIX=recycle_erp_railway

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Clear the postgres image's entrypoint (it would try to init a DB cluster).
# The cron start command runs our script directly; it dumps once and exits.
ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
