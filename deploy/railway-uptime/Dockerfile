# Uptime probe for the prod inventory app, run by Railway as a cron service.
# Curl-only on alpine — the whole job is two HTTP status checks and an
# optional webhook post. See check.sh for the why.
FROM alpine:3.22

RUN apk add --no-cache curl

COPY check.sh /usr/local/bin/check.sh
RUN chmod +x /usr/local/bin/check.sh

# Railway invokes this once per cron tick; the script probes and exits.
CMD ["/usr/local/bin/check.sh"]
