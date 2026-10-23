#!/bin/sh
# Probe the prod app THROUGH the public Cloudflare hostname, not the Railway
# origin — Railway's own dashboards stayed green during the 2026-07-12 outage
# because only the Cloudflare→Worker→domain layer was broken (HTTP 523).
#
# On failure the run exits 1 (shows as FAILED in Railway) and, when ALERT_URL
# is set, posts to the ops alert relay (deploy/railway-alerts, POST /alert),
# which puts it in the "ERP · Uptime" Telegram topic with the layer that broke
# (edge vs origin).
#
# Env (all optional):
#   PUBLIC_URL   default https://inventory.recycleservers.com/api/health
#   ORIGIN_URL   default https://backend-production-7b10.up.railway.app/api/health
#   ALERT_URL    the relay's /alert URL; unset = rely on Railway FAILED status
#   ALERT_TOKEN  the relay's ALERT_TOKEN bearer
set -eu

PUBLIC_URL="${PUBLIC_URL:-https://inventory.recycleservers.com/api/health}"
ORIGIN_URL="${ORIGIN_URL:-https://backend-production-7b10.up.railway.app/api/health}"

status_of() {
  # curl prints 000 itself when it can't connect, then exits non-zero.
  curl -sS -o /dev/null -m 15 -w '%{http_code}' "$1" 2>/dev/null || true
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

if [ -n "${ALERT_URL:-}" ]; then
  # Strings are escaped for JSON (a URL with a quote used to make an invalid
  # body). The relay answers 204 once Telegram has the message, and 502 when
  # Telegram refused it.
  esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  body="{\"topic\":\"erp_uptime\",\"status\":\"firing\",\"title\":\"recycle-erp prod DOWN\",\"lines\":[\"$(esc "$PUBLIC_URL") -> HTTP $public_status\",\"Failing layer: $(esc "$layer")\"],\"link\":\"$(esc "$PUBLIC_URL")\"}"
  if curl -fsS -m 15 -o /dev/null -X POST "$ALERT_URL" \
      -H "Authorization: Bearer ${ALERT_TOKEN:-}" \
      -H 'Content-Type: application/json' \
      -d "$body"; then
    echo "[uptime] alert delivered"
  else
    echo "[uptime] alert post failed"
  fi
fi

exit 1
