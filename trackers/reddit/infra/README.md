# Infrastructure

The tracker runs as: **Railway** (shared Postgres + `api` service + one
`worker` service) plus an **OCI Always-Free worker fleet** (this terraform).
Each OCI VM has its own public IP and therefore its own anonymous Reddit rate
budget — the fleet exists to multiply IPs, not compute.

```
Railway: Postgres ── api (HTTP admin/UI) ── worker (1, Railway's IP range)
   ▲ public TCP proxy
   └── OCI VMs: 4× A1 arm64 + 2× micro amd64 (Singapore)
                            + 2× micro amd64 (Toronto)
```

## Layout

- `terraform/` — the fleet. Two provider aliases (`DEFAULT` → ap-singapore-1,
  `jinhuwang112` → ca-toronto-1, api-key auth from `~/.oci/config`), one VCN
  per region, and 4 pool instantiations of `modules/oci-worker-pool`.
- `../scripts/deploy-workers.sh` — pushes the env file + starts/updates the
  container on every VM. Day 1 and day 2 are the same command.
- `../scripts/secrets.env.example` — template for the secrets the script needs.

## Key decisions

- **No secrets in terraform state.** Cloud-init only installs docker; the app
  env, GHCR login, and container start all happen over SSH via the deploy
  script. That is what makes the remote state backend (OCI Object Storage,
  bucket `terraform-state-cross-region-cloud`, key
  `homelab_infra/reddits-tracker`) safe to use.
- **Never destroy/replace A1 instances to ship code.** Freed A1 capacity may
  be unrecoverable for days. Code ships via the deploy script; `ignore_changes`
  on instance metadata enforces this at the terraform level.
- **Quota math (Singapore is Pay-As-You-Go):** the free allotment is ~3,000
  A1 OCPU-hours + 18,000 GB-hours/month — exactly 4× (1 OCPU / 6 GB) running
  24/7. Do not raise `sg_arm_count` or sizes: a fifth OCPU starts billing.
- **Block storage is the binding constraint:** every VM's boot volume is 47 GB
  (Ubuntu's minimum) against a 200 GB free cap per tenancy. Singapore: 4 A1 ×
  47 = 188 GB — full; that is why `sg_amd_count = 0` (2 micros were destroyed
  on 2026-08-14 when this was caught). Toronto: 150 (Vaultwarden) + 47 = 197 GB
  — also effectively full.
- **Toronto A1 quota is fully used by the Vaultwarden VM**
  (`instance-20220516-2257`) — which this stack must NEVER touch or import.
  `to_arm_count` stays 0 unless the `toronto_arm_availability` output shows
  headroom.

## Runbook

```bash
cd infra/terraform
terraform init
terraform plan -out tf.plan     # preflight fails if a pool has no quota
terraform apply tf.plan
cd ../.. && scripts/deploy-workers.sh          # push env + start containers
scripts/deploy-workers.sh <git-sha-tag>        # deploy a specific version / rollback
```

On **"Out of host capacity"**: lower the failing pool's count in
`terraform.tfvars`, apply what fits, re-raise later — applies are additive.

Image publishing (multi-arch, from the app repo):

```bash
docker buildx build --platform linux/arm64,linux/amd64 \
  -t ghcr.io/jinhuw/reddits_tracker:latest \
  -t ghcr.io/jinhuw/reddits_tracker:$(git rev-parse --short HEAD) --push .
```

## Pause vs destroy

To pause the fleet: `ssh ubuntu@<ip> sudo docker stop tracker` (or OCI-stop
the instances). `terraform destroy` gives up A1 capacity you may not get back.

## History

2026-08-14: The Singapore OKE cluster (`oracle-k8s-cluster`, 2× A1 nodes, k8s
dashboard + VictoriaMetrics + Flux, ingresses `hello/web/dashboard.jinhu.io` →
158.178.228.47) was destroyed to free the ARM allotment for this fleet.
