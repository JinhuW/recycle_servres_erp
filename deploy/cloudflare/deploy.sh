#!/usr/bin/env bash
# deploy.sh — build the frontend, deploy the Worker for one environment, then
# smoke-check every public hostname through Cloudflare.
#
# Usage:
#   deploy/cloudflare/deploy.sh <prod|dev> [--no-build]
#
# The smoke check exists because a `wrangler deploy` can silently tear down a
# custom domain (DNS record + cert) if the domain isn't declared in
# wrangler.toml routes — the Railway origin stays green while the public
# hostname serves Cloudflare 523. Probing through the public hostname is the
# only check that catches that class of failure.
# See docs/debug-notes/2026-07-13-cloudflare-worker-custom-domain-deleted.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV="${1:?usage: deploy.sh <prod|dev> [--no-build]}"
NO_BUILD="${2:-}"

case "$ENV" in
  prod) HOSTS=(inventory.recycleservers.com inventory-prod.recycleservers.com) ;;
  dev)  HOSTS=(inventory-dev.recycleservers.com) ;;
  *) echo "error: unknown env '$ENV' (expected prod or dev)" >&2; exit 2 ;;
esac

# Local shells often carry the terraform-scoped CLOUDFLARE_API_TOKEN, which
# can't deploy Workers — fall back to `wrangler login` OAuth there. CI sets a
# deploy-scoped token and must keep it.
if [[ -z "${CI:-}" ]]; then
  unset CLOUDFLARE_API_TOKEN
fi

if [[ "$NO_BUILD" != "--no-build" ]]; then
  echo "▸ Building frontend (guards against deploying a stale dist/)"
  (cd "$ROOT" && pnpm --filter recycle-erp-frontend build)
fi

echo "▸ wrangler deploy --env $ENV"
(cd "$SCRIPT_DIR" && npx wrangler@4 deploy --env "$ENV")

# Retries ride out cert/DNS propagation when a domain was just (re)attached.
fail=0
for host in "${HOSTS[@]}"; do
  url="https://$host/api/health"
  if curl -fsS -o /dev/null -m 15 --retry 5 --retry-delay 3 --retry-all-errors "$url"; then
    echo "✓ $url healthy"
  else
    echo "✗ $url FAILED after deploy — the Worker custom domain is likely broken." >&2
    echo "  Check [env.$ENV] routes in deploy/cloudflare/wrangler.toml and redeploy;" >&2
    echo "  every public hostname must be declared there with custom_domain = true." >&2
    fail=1
  fi
done
exit "$fail"
