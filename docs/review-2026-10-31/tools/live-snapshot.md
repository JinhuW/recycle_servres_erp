## Snapshot, 2026-10-31 ~20:15 UTC

| Resource | Deployed | Health | Drift | Last success |
| --- | --- | --- | --- | --- |
| Railway `recycle-erp-experiment` / backend prod | `main` fb4afda4 (v1.394.0) | 7 d: 465,949 req, 5xx 0.115 %, p95 < 200 ms; CPU 0.01 of 24 vCPU, RAM ≤ 0.60 GB | watchPatterns omit root manifests (B1-05) | deploy 2026-10-31 18:54Z |
| … backend dev | 8ad4e918 (v1.395.1, pushed during the review) | healthy | — | — |
| … Postgres prod | — | 0.88 of 5 GB volume, RAM ≤ 0.87 GB, WAL archive configured | — | — |
| … pg-r2-backup (cron) | `main` | runs | one key reads and deletes every dump (A11-02) | 2026-10-31 03:30Z |
| … db-sync (cron) | `dev` | **fails nightly** | scrub NULLs NOT NULL `fleet_proxies.url_enc` (A5-01) | 2026-10-27 |
| … uptime-monitor (cron) | — | **no probe since 2026-10-28 21:11Z** | 429 from Cloudflare misread (A11-01, B1-04) | 2026-10-28 21:05Z |
| Railway `reddits-tracker` api / worker | `railway up` uploads (no SHA), RS-476 fixes live | online | — | 2026-10-31 09:15Z |
| Railway `facebook-tracker` Postgres | — | 1.19 of 50 GB | password not rotated since the leak, public TCP proxy (B1-02) | last redeploy 08-19 |
| Railway `ebay-tracker`, `aio-manufacturing-solution`, `recycle-server-odoo-erp` | — | online | out of ERP scope | — |
| Railway `vaultwarden` | — | online, cert valid | **no volume backups** (B1-06) | — |
| Railway webhooks | all 7 projects → `railway-alerts` | deploy fail/crash/OOM, monitor, volume | cron non-zero exits are not a webhook event | — |
| Cloudflare Worker `recycle-erp-prod` | `main` fb4afda4 (v1.394.0) | domains match `wrangler.toml` | — | deploy-frontend run on main |
| Cloudflare Worker `recycle-erp-dev` | 8ad4e918 (v1.395.1) | domains match | — | — |
| Cloudflare Worker `railway-alerts` | version 617b0de0 (manual, 2026-10-23) | TOPICS/CHAT_ID equal the repo | spot-checked, not byte-diffed | — |
| Cloudflare `fbc-api.recycleservers.com` | rs_console via tunnel | answers anonymously at the origin | **no Access app in front** (B2-01) | — |
| R2 `recycle-db-backup` | — | daily dumps (3.96 → 9.63 MB, 10-26 → 10-31) | no lock rule; restore drill never run (INF-06) | 2026-10-31 |
| R2 attachments CORS | — | allows only `inventory.recycleservers.com` | INF-02 fix never applied (B2-02) | — |
| Terraform reddit | — | `plan`: no changes | untracked buckets / orphan tfstate (B2 P3s) | — |
| Homelab VM 10.10.10.73 | 9 `rs-fleet-homelab` workers on aimm-recycle:0.15.0 (= VERSION) + fleet-agent 1.380.1 | coordinator 24 h: 29,923×200, 4,805×404, 808×422, no 5xx | rs_console drift: see B3 P3s | — |
| … login ledger | — | **31 boot logins / 24 h, 20 walled; 105 / 7 d** (B3-01) | legacy roster: 41 retired, 25 parked (13 SESSION_EXPIRED, 12 CHECKPOINT) | — |
| … OpenSearch `fb-tracker-*` | — | green; open on the LAN with no auth | no index for 2026-10-28 (cutover) | — |
| Fleet host 10.10.60.14 | fleet-agent **1.380.1** (repo 1.395.x); 9 workers on 0.15.0 digest 462d29f2…, worker -2 exited on 0.14.7 | healthy, 23 % disk, 42 of 62 GB RAM free | 5 agent fixes behind (B4-01); not scraped by Prometheus (B4-04) | — |
| OCI reddit fleet (5 hosts) | ghcr `reddits_tracker:af37edd8` = trackers/reddit HEAD | 0 restarts, disks 18–20 % | — | started 09:25Z |
| Alertmanager 10.10.60.5 | 0.28.1 | no active alerts or silences; API unauthenticated on the LAN | config drift not checked (no homelab-monitoring clone) | up since 10-23 |
| Cloud routine `trig_01W3wmHwWNUGr63STjr9e5UT` | — | **blocked every night** but reports SUCCEEDED (B4-03) | no Railway token | — |
| Mac `com.jinhu.archify-previews` | — | running | — | — |
| Mac `com.wehatai.memtrade-report` / `-rerun` / `-web` | — | exit 0; daily push 10-26 → 10-31 | memtrade has no commits or backup (B5-05) | 2026-10-31 |
| Mac `com.recycleservers.fbmonitor` (+ watchdog) | legacy checkout | **still running, logged-in session, house IP** (B5-01) | should be retired | 2026-10-29 searches |
| Mac `com.recycleservers.search-probe` | legacy checkout | **opens Marketplace daily with personal session** (B5-02) | — | 2026-10-31 |
| Mac `com.recycleservers.keyword-eval` | legacy checkout | exit 1 daily since 10-25 (B5-03) | reads a container that no longer exists | 2026-10-24 |
