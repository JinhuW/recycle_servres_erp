# One-directional Postgres sync: copies the PROD database into the DEV database
# on the Railway deployment. Built and run by Railway as a cron service in the
# DEV environment. NOT part of the Docker Compose stack.
# See docs/deployment-railway-dev-prod.md.
#
# pg_dump/psql must be >= the server major version. The Railway managed Postgres
# is PostgreSQL 18, so this pins the v18 client. Bump if the DB is upgraded.
FROM postgres:18-alpine

# curl calls the Railway API to redeploy the backend after each restore.
RUN apk add --no-cache curl

COPY sync.sh /usr/local/bin/sync.sh
RUN chmod +x /usr/local/bin/sync.sh

# Railway invokes this once per cron tick; the script copies prod->dev and exits.
CMD ["/usr/local/bin/sync.sh"]
