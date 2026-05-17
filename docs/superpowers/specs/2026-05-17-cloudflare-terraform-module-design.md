# Cloudflare Terraform Module — Design

**Date:** 2026-05-17
**Status:** Approved

## Goal

Manage all of this service's cloud resources as code with Terraform. The
entire cloud footprint is Cloudflare: an R2 bucket for label-scan images and
sell-order attachments, served publicly via a custom domain, plus the scoped
R2 API token the backend uses for S3 access. Postgres (self-hosted Docker)
and OpenRouter (SaaS API key) are out of scope.

## Decisions (from brainstorming)

- **Resources managed:** R2 bucket(s), CORS, lifecycle, R2 custom domain +
  DNS record, scoped R2 API token.
- **Existing infra:** Fresh resources only. The user will **manually delete**
  the existing hand-created bucket/DNS first, then Terraform creates them
  fresh reusing the same names.
- **State:** R2 S3-compatible backend.
- **Environments:** Single (prod only).
- **Structure:** Approach A — reusable `cloudflare` module + thin prod root +
  separate bootstrap for the state bucket.
- **Upload path:** All R2 writes/deletes are **server-side** through the
  backend's `@aws-sdk/client-s3` client (`apps/backend/src/r2.ts`). Browsers
  only read objects via the public custom-domain URL. CORS therefore needs
  only GET/HEAD from the app origin(s).

## ⚠️ Risk / caveat

Deleting the live `recycle-erp-attachments` bucket destroys all existing
label-scan and sell-order attachment objects. There is no data migration in
this plan. The user accepted this; existing objects are lost unless
re-uploaded. The DB still holds storage keys that will 404 until re-uploaded.

## Layout

```
infra/terraform/
├── bootstrap/                 # local state; run ONCE
│   ├── main.tf                #   creates the TF-state R2 bucket only
│   └── README.md
├── modules/
│   └── cloudflare/            # the dedicated reusable module
│       ├── r2.tf              #   bucket + CORS + lifecycle
│       ├── domain.tf          #   R2 custom domain + DNS record
│       ├── token.tf           #   scoped R2 API token
│       ├── variables.tf
│       ├── outputs.tf
│       └── versions.tf        #   provider pin
└── environments/
    └── prod/
        ├── main.tf            # calls ../../modules/cloudflare
        ├── backend.tf         # R2 S3 state backend
        ├── prod.tfvars        # non-secret prod values (committed)
        └── README.md
```

## Module resources (`modules/cloudflare`)

- **R2 bucket** — `cloudflare_r2_bucket`; `name` + `location` from variables
  (default name `recycle-erp-attachments`).
- **CORS** — `cloudflare_r2_bucket_cors`; allow GET, HEAD from
  `var.cors_allowed_origins`. No PUT/POST (writes are server-side).
- **Lifecycle** — `cloudflare_r2_bucket_lifecycle`; optional age-based
  expiration rule, gated by `var.lifecycle_expire_days` (default `0` =
  disabled, so attachments are never silently deleted).
- **Custom domain** — `cloudflare_r2_custom_domain` binding the bucket to
  `var.custom_domain` (`static.recycleservers.com`) in `var.cloudflare_zone_id`.
  **Correction to brainstorming:** no separate `cloudflare_dns_record`. When
  the custom domain's zone is on the same Cloudflare account (it is —
  `recycleservers.com` is a Cloudflare zone), `cloudflare_r2_custom_domain`
  automatically creates and manages the proxied CNAME. A separate DNS-record
  resource for the same hostname causes a "record already exists" conflict.
  A manual record is only needed for external (non-Cloudflare) DNS.
- **R2 API token** — `cloudflare_api_token` scoped to Object Read & Write on
  this account's R2. Its secret value lands in Terraform state (unavoidable
  for a managed token) — mitigated by the private state bucket and treating
  state as secret.

## Variables & outputs

**Inputs** (non-secret values in `prod.tfvars`, committed):

- `cloudflare_account_id` — `cf0e09b533b74d32407f6fe1b558165b`
- `cloudflare_zone_id` — `dd2a6dc1b973dc1f98b1cb009edae6d1` (`recycleservers.com`)
- `bucket_name` (default `recycle-erp-attachments`)
- `bucket_location` — `enam` (US East / Eastern North America; v5 uses
  lowercase region codes)
- `custom_domain` (`static.recycleservers.com`)
- `cors_allowed_origins` (list of strings; default
  `["https://inventory.recycleservers.com"]` — GET/HEAD only)
- `lifecycle_expire_days` (number, default `0` = disabled)

The Cloudflare API token Terraform itself authenticates with is supplied via
the `CLOUDFLARE_API_TOKEN` environment variable — never in tfvars.

**Outputs:**

- `bucket_name`
- `r2_s3_endpoint`
- `public_url`
- `r2_access_key_id` (sensitive)
- `r2_secret_access_key` (sensitive)

These map directly onto the backend's `R2_*` env vars
(`R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`,
`R2_ATTACHMENTS_PUBLIC_URL`).

## State, bootstrap & secrets

- **Bootstrap** (`infra/terraform/bootstrap/`, local state, run once):
  creates the private state bucket `recycle-erp-tfstate`. Its own
  `terraform.tfstate` is gitignored.
- **Prod backend** (`environments/prod/backend.tf`): S3 backend pointed at
  R2 — bucket `recycle-erp-tfstate`, key `prod/terraform.tfstate`, `region`
  `auto`, with the `skip_credentials_validation`, `skip_region_validation`,
  `skip_requesting_account_id`, `skip_s3_checksum`, and `use_path_style`
  flags R2 requires. Backend access key/secret supplied via env
  (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) or `-backend-config`.
- **Secrets / gitignore:** add `infra/terraform/**/.terraform/`,
  `*.tfstate`, `*.tfstate.*`, `*.tfstate.backup`, `crash.log`,
  `*.auto.tfvars`, and `**/*.secret.tfvars` to `.gitignore`. The state
  bucket is private with no custom domain. `prod.tfvars` holds only
  non-secret account/zone IDs and is committed.

## Public URL behavior change (migration note)

A native R2 custom domain serves objects at the **domain root**:
`https://static.recycleservers.com/<key>`. The current hand-built setup
serves at `https://static.recycleservers.com/recycle-erp-attachments/<key>`.
After cut-over the backend env must change:

```
R2_ATTACHMENTS_PUBLIC_URL=https://static.recycleservers.com   # drop /recycle-erp-attachments
```

This is consistent with the fresh-start decision (old objects are gone
anyway). The module's `public_url` output is `https://<custom_domain>` with
no path segment. The runbook calls this out explicitly.

## Validation

No automated tests for IaC. Validation steps:

1. `terraform fmt -check -recursive`
2. `terraform validate` in `bootstrap/` and `environments/prod/`
3. After the user deletes the manual resources: `terraform plan` in
   `environments/prod/` shows a clean **create-only** plan.
4. `environments/prod/README.md` contains a step-by-step apply runbook
   (bootstrap → backend migrate → plan → apply → wire backend env vars).

## Out of scope

Data migration off the old bucket; multi-environment support; managing
Postgres or OpenRouter; CI automation of `terraform apply`.
