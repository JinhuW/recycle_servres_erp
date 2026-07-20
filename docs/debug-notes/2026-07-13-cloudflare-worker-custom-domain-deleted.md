# Wrangler deploy deleted the prod custom domain → sitewide HTTP 523

**Date:** 2026-07-13 (outage 2026-07-12 21:05 UTC → 2026-07-13 02:53 UTC)

## Symptom

`https://inventory.recycleservers.com` returned Cloudflare **HTTP 523**
("origin unreachable") on every path — static assets and `/api/*` alike — for
~6 hours. Everything Railway-side looked green the whole time: the backend
answered 200 on `backend-production-7b10.up.railway.app/api/health` and on
`api.prod.recycleservers.com`, deployments showed SUCCESS.

## Root cause

`inventory.recycleservers.com` had been attached to the `recycle-erp-prod`
Worker **out-of-band** (Cloudflare dashboard) but was **not** declared in
`deploy/cloudflare/wrangler.toml` — at that point `[env.prod]` routes only
listed `inventory-prod.recycleservers.com`.

`wrangler deploy --env prod` **reconciles the Worker's custom domains against
the config**: any attached domain missing from `routes` is torn down. The
21:05 UTC deploy therefore deleted the domain's DNS record and TLS cert
(Cloudflare audit log: system `dns.record delete` at 21:05:49, certificate
pack deleted at 21:05:50 — no re-create followed).

With the record gone, the hostname fell through to the zone's wildcard
`*.recycleservers.com → A 100.0.1.199` (proxied, unreachable IP), so
Cloudflare answered 523. That wildcard is why the failure masqueraded as an
"origin down" error instead of an obvious NXDOMAIN.

Fixed by commit `195b83a` (declare the domain in `[env.prod]` routes) +
redeploy — the 02:53 UTC deploy re-created the DNS record and cert.

## Rules

1. **Never attach a hostname to a Worker via the Cloudflare dashboard.**
   Declare every public hostname in `wrangler.toml` `routes` with
   `custom_domain = true`. Deploys converge to the file; anything not in it
   gets deleted.
2. **Deploy with `deploy/cloudflare/deploy.sh <env>`**, which smoke-checks
   every public hostname through Cloudflare after deploying. Probing the
   Railway origin is not enough — it stayed green throughout this outage.
3. Prod deploys from CI (`.github/workflows/deploy-frontend.yml`) use the
   committed config, eliminating the stale-local-checkout variant of this bug.

## Fast diagnosis next time

```bash
curl -si https://inventory.recycleservers.com/api/health | head -5
# 523 + `server: cloudflare` + NO `x-railway-*` headers
#   → request never left Cloudflare; check zone DNS records for the hostname
#     (missing record = this bug) and account audit logs for dns.record
#     deletes around the last worker deploy. Fix: deploy.sh prod.
curl -s -o /dev/null -w '%{http_code}\n' https://backend-production-7b10.up.railway.app/api/health
# 200 → backend fine, it's the Cloudflare layer. Non-200 → backend problem.
```

Related: the `uptime-monitor` Railway cron (`deploy/railway-uptime/`) probes
the public hostname every 5 minutes and distinguishes edge vs origin failures.
