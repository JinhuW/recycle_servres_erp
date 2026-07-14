#!/bin/sh
# Probe the prod app THROUGH the public Cloudflare hostname, not the Railway
# origin — Railway's own dashboards stayed green during the 2026-07-12 outage
# because only the Cloudflare→Worker→domain layer was broken (HTTP 523).
#
# On failure the run exits 1 (shows as FAILED in Railway) and, when
# ALERT_WEBHOOK_URL is set, posts a Lark custom-bot message with which layer
# broke (edge vs origin).
#
# Env (all optional):
#   PUBLIC_URL         default https://inventory.recycleservers.com/api/health
#   ORIGIN_URL         default https://backend-production-7b10.up.railway.app/api/health
#   ALERT_WEBHOOK_URL  Lark custom-bot webhook; unset = rely on Railway FAILED status
set -eu

PUBLIC_URL="${PUBLIC_URL:-https://inventory.recycleservers.com/api/health}"
ORIGIN_URL="${ORIGIN_URL:-https://backend-production-7b10.up.railway.app/api/health}"

status_of() {
  curl -sS -o /dev/null -m 15 -w '%{http_code}' "$1" 2>/dev/null || echo 000
}

# Three attempts, 20s apart, so a transient blip doesn't page.
attempt=1
while :; do
  public_status="$(status_of "$PUBLIC_URL")"
  [ "$public_status" = "200" ] && { echo "[uptime] ok: $PUBLIC_URL -> 200"; exit 0; }
  echo "[uptime] attempt $attempt: $PUBLIC_URL -> $public_status"
  [ "$attempt" -ge 3 ] && break
  attempt=$((attempt + 1))
  sleep 20
done

origin_status="$(status_of "$ORIGIN_URL")"
if [ "$origin_status" = "200" ]; then
  layer="Cloudflare edge/Worker/custom-domain (Railway origin is healthy — likely the Worker domain binding; redeploy with deploy/cloudflare/deploy.sh prod)"
else
  layer="Railway backend (origin -> $origin_status)"
fi
msg="recycle-erp prod DOWN: $PUBLIC_URL -> HTTP $public_status. Failing layer: $layer"
echo "[uptime] ALERT: $msg"

if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
  curl -sS -m 15 -X POST "$ALERT_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$msg\"}}" \
    || echo "[uptime] webhook post failed"
fi

exit 1
