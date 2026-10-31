# B1 verification evidence (2026-10-31)

All read-only. Railway MCP list-*/get-*/describe-* calls plus railway-gql.sh, a read-only
GraphQL helper that takes the token from ~/.railway/config.json and never prints it.

- B1-01: get-logs deployment f458bd19 → last line 2026-10-28T21:11:43Z "alert post failed";
  get-logs service 365b9538 env production startDate 2026-10-28T21:12Z → [] (no runs since).
  Latest deployment 3506ce25 FAILED on 2026-10-31 18:00Z, "failed to fetch snapshot" x13.
- B1-03: get-logs db-sync 006cd405 env dev since 2026-10-27 → "[sync] done" 10-27 04:03Z;
  10-28, 10-29, 10-30 and 10-31 each: ERROR null value in column "url_enc" of relation "fleet_proxies".
- B1-04: same uptime log has 3x 429 at 21:11:03/23/43Z plus a 429 from the alert relay. Backend http
  log 21:10:50–21:12Z holds a single /api/health 200, host backend-production-7b10 (the origin probe),
  src 152.55.181.187. No 429 anywhere in deploy/cloudflare, deploy/railway-alerts or infra.
- B1-05: get-service-config backend prod watchPatterns = [apps/backend/**, packages/shared/**]; dev
  also has package.json, pnpm-lock.yaml, tsconfig.base.json. Prod SKIPPED releases 4fdc04e7 55b5a15a 17369975
  e3b05115 b5208277 41c400ed a08d5d16: among watched paths, git diff ^1 touches only root package.json.
- B1-02: list-deployments facebook-tracker postgres → newest 2026-08-19 (no Regenerate redeploy since
  the 10-21 breach). TCP proxy 1d2141e7 shortline.proxy.rlwy.net:21141 ACTIVE.
- B1-06: volumeInstanceBackupScheduleList / volumeInstanceBackupList for instance 194e7ac7 → [] / [].
  Control: ERP prod postgres instance b6ce449d → Daily schedule "13 4 * * *" plus backups.
