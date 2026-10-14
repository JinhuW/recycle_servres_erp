# Infrastructure and configuration coverage

Review snapshot `55b5a15a`, 2026-10-13. The primary reviewer inspected the following deployment, provider-facing platform, CI, recovery and development-tooling sources/configurations. Provider implementations are included in the [backend manifest](backend-coverage.md). Backend bootstrap scripts and test harness/migrations are listed in the [supporting manifest](schema-and-supporting-domain-todo.md#explicit-coverage). Frontend CSS/static assets were inventoried and pattern-screened; they received no browser visual certification. Operational and historical prose was supporting context. No external mutation or live infrastructure verification was performed.

The plain-JavaScript Worker falls outside the 431-module TypeScript inventory and is explicitly included below. Terraform lock/state files are not present in the tracked source inventory. Fingerprints record the reviewed source, not deployed state.

| File | Lines | Review evidence | SHA-256 prefix |
| --- | ---: | --- | --- |
| `.claude/settings.json` | 17 | configuration/script/source-flow inspection | `a2181bc9f21a` |
| `.dockerignore` | 14 | configuration/script/source-flow inspection | `8fdebf710a31` |
| `.env.example` | 159 | configuration/script/source-flow inspection | `18b770dfc6b1` |
| `.githooks/README.md` | 38 | operational documentation context | `86a2f0f678b0` |
| `.githooks/lib/scan.sh` | 91 | configuration/script/source-flow inspection | `adf374168da8` |
| `.githooks/pre-commit` | 19 | configuration/script/source-flow inspection | `1530ea90edf0` |
| `.githooks/pre-push` | 92 | configuration/script/source-flow inspection | `c07778b780be` |
| `.github/workflows/backend-tests.yml` | 113 | configuration/script/source-flow inspection | `b487d150045b` |
| `.github/workflows/deploy-frontend.yml` | 59 | configuration/script/source-flow inspection | `3c0290bf73aa` |
| `.github/workflows/version-check.yml` | 106 | configuration/script/source-flow inspection | `a01129dc1037` |
| `.gitignore` | 75 | configuration/script/source-flow inspection | `03247fa25c9b` |
| `.npmrc` | 3 | configuration/script/source-flow inspection | `216d74701ba0` |
| `.nvmrc` | 1 | configuration/script/source-flow inspection | `68ca3fba3b7e` |
| `apps/backend/Dockerfile` | 68 | configuration/script/source-flow inspection | `3fdbd1d18010` |
| `apps/backend/package.json` | 45 | configuration/script/source-flow inspection | `150f8e977ec9` |
| `apps/backend/tsconfig.json` | 10 | configuration/script/source-flow inspection | `17a4b1feb5b0` |
| `apps/backend/vitest.config.ts` | 22 | configuration/script/source-flow inspection | `b54dcd52aae1` |
| `apps/frontend/Caddyfile` | 67 | configuration/script/source-flow inspection | `0d46b46aa562` |
| `apps/frontend/Dockerfile` | 25 | configuration/script/source-flow inspection | `527b0bcc88fb` |
| `apps/frontend/index.html` | 49 | configuration/script/source-flow inspection | `7427afb1df68` |
| `apps/frontend/package.json` | 34 | configuration/script/source-flow inspection | `1d398e38682d` |
| `apps/frontend/public/_headers` | 51 | configuration/script/source-flow inspection | `174b24292008` |
| `apps/frontend/tsconfig.json` | 21 | configuration/script/source-flow inspection | `37c15a27b49a` |
| `apps/frontend/vite.config.ts` | 130 | configuration/script/source-flow inspection | `ef62d32e9740` |
| `backup/Dockerfile` | 26 | configuration/script/source-flow inspection | `ff5cd1fc8ebd` |
| `backup/README.md` | 54 | operational documentation context | `0bf527502e8a` |
| `backup/backup.sh` | 113 | configuration/script/source-flow inspection | `b4fe9d98c482` |
| `backup/railway.toml` | 22 | configuration/script/source-flow inspection | `a460c6848589` |
| `deploy/cloudflare/.gitignore` | 2 | configuration/script/source-flow inspection | `c7b19c97f231` |
| `deploy/cloudflare/deploy.sh` | 58 | configuration/script/source-flow inspection | `fd9356a901e8` |
| `deploy/cloudflare/worker.js` | 156 | configuration/script/source-flow inspection | `1cc70bd4466c` |
| `deploy/cloudflare/wrangler.toml` | 64 | configuration/script/source-flow inspection | `c3d983a8a173` |
| `deploy/railway-sync/Dockerfile` | 20 | configuration/script/source-flow inspection | `2bd29f30a50b` |
| `deploy/railway-sync/railway.toml` | 12 | configuration/script/source-flow inspection | `2670cd01f635` |
| `deploy/railway-sync/scrub.sql` | 21 | configuration/script/source-flow inspection | `8968c1c09802` |
| `deploy/railway-sync/sync.sh` | 99 | configuration/script/source-flow inspection | `c880b8e86ce3` |
| `deploy/railway-uptime/Dockerfile` | 12 | configuration/script/source-flow inspection | `47e9f351737e` |
| `deploy/railway-uptime/check.sh` | 50 | configuration/script/source-flow inspection | `4823c0a0e7b6` |
| `deploy/railway-uptime/railway.toml` | 14 | configuration/script/source-flow inspection | `b07da5a2a407` |
| `docker-compose.yml` | 166 | configuration/script/source-flow inspection | `62e3f32aca01` |
| `infra/terraform/bootstrap/.terraform.lock.hcl` | 20 | configuration/script/source-flow inspection | `86282f45b764` |
| `infra/terraform/bootstrap/README.md` | 27 | operational documentation context | `7987d5fb54ae` |
| `infra/terraform/bootstrap/main.tf` | 46 | configuration/script/source-flow inspection | `9402ca291fa0` |
| `infra/terraform/environments/experiment-backups/.terraform.lock.hcl` | 20 | configuration/script/source-flow inspection | `86282f45b764` |
| `infra/terraform/environments/experiment-backups/backend.tf` | 19 | configuration/script/source-flow inspection | `de82ca40f237` |
| `infra/terraform/environments/experiment-backups/main.tf` | 126 | configuration/script/source-flow inspection | `74683d44fbc3` |
| `infra/terraform/environments/experiment-dns/.terraform.lock.hcl` | 20 | configuration/script/source-flow inspection | `86282f45b764` |
| `infra/terraform/environments/experiment-dns/README.md` | 35 | operational documentation context | `2592c26f1b38` |
| `infra/terraform/environments/experiment-dns/backend.tf` | 19 | configuration/script/source-flow inspection | `63d1bd3819ff` |
| `infra/terraform/environments/experiment-dns/main.tf` | 69 | configuration/script/source-flow inspection | `38f7c067588d` |
| `infra/terraform/environments/prod/.terraform.lock.hcl` | 20 | configuration/script/source-flow inspection | `86282f45b764` |
| `infra/terraform/environments/prod/README.md` | 42 | operational documentation context | `0e721db58a3e` |
| `infra/terraform/environments/prod/backend.tf` | 19 | configuration/script/source-flow inspection | `a58b096e9c25` |
| `infra/terraform/environments/prod/main.tf` | 53 | configuration/script/source-flow inspection | `d75df92f9194` |
| `infra/terraform/environments/prod/prod.tfvars` | 3 | configuration/script/source-flow inspection | `b06b24dd4262` |
| `infra/terraform/modules/cloudflare/domain.tf` | 12 | configuration/script/source-flow inspection | `f223864b78e8` |
| `infra/terraform/modules/cloudflare/outputs.tf` | 32 | configuration/script/source-flow inspection | `68f00d6b27bf` |
| `infra/terraform/modules/cloudflare/r2.tf` | 43 | configuration/script/source-flow inspection | `a551fb64c328` |
| `infra/terraform/modules/cloudflare/token.tf` | 33 | configuration/script/source-flow inspection | `f47b03b5d5b2` |
| `infra/terraform/modules/cloudflare/variables.tf` | 77 | configuration/script/source-flow inspection | `127d91ea0b4a` |
| `infra/terraform/modules/cloudflare/versions.tf` | 10 | configuration/script/source-flow inspection | `b2bdc0997860` |
| `package.json` | 22 | configuration/script/source-flow inspection | `6ed0f29f58a8` |
| `packages/shared/package.json` | 17 | configuration/script/source-flow inspection | `c6c5e54efb36` |
| `packages/shared/tsconfig.json` | 7 | configuration/script/source-flow inspection | `a10538fb983a` |
| `pnpm-lock.yaml` | 7193 | lockfile audit and dependency-path tracing | `044c35346e20` |
| `pnpm-workspace.yaml` | 11 | configuration/script/source-flow inspection | `40a741e2bcfc` |
| `scripts/changelog.sh` | 279 | configuration/script/source-flow inspection | `db5448ff8328` |
| `scripts/claude-session-hook.sh` | 104 | configuration/script/source-flow inspection | `29f9bfb5858d` |
| `scripts/new-session.sh` | 639 | configuration/script/source-flow inspection | `c45f3d3beb69` |
| `scripts/ticket.sh` | 221 | configuration/script/source-flow inspection | `bb424e3c18b7` |
| `tsconfig.base.json` | 13 | configuration/script/source-flow inspection | `21301e1b2566` |
