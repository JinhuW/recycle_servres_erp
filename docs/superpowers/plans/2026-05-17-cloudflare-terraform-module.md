# Cloudflare Terraform Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage all of this service's Cloudflare cloud resources (R2 bucket, CORS, lifecycle, custom domain, scoped R2 API token) as a dedicated reusable Terraform module, with a single prod environment and R2-backed state.

**Architecture:** A reusable `modules/cloudflare` module holds all resource definitions. A thin `environments/prod` root calls the module with prod values and stores state in an R2 bucket via the S3-compatible backend. A one-shot `bootstrap` config (local state) creates the state bucket, resolving the chicken-and-egg. Existing hand-created resources are deleted by the operator first; Terraform creates everything fresh reusing the same names.

**Tech Stack:** Terraform ≥ 1.6, Cloudflare provider v5 (`cloudflare/cloudflare ~> 5.0`), Cloudflare R2 (S3-compatible) for both attachments and Terraform state.

**Spec:** `docs/superpowers/specs/2026-05-17-cloudflare-terraform-module-design.md`

**Concrete values (from the user):**
- Cloudflare Account ID: `cf0e09b533b74d32407f6fe1b558165b`
- Zone ID (`recycleservers.com`): `dd2a6dc1b973dc1f98b1cb009edae6d1`
- Bucket location: `enam` (US East)
- Frontend origin (CORS): `https://inventory.recycleservers.com`
- Bucket name: `recycle-erp-attachments`
- Custom domain: `static.recycleservers.com`
- State bucket: `recycle-erp-tfstate`

**Validation model (IaC, not TDD):** there are no unit tests for Terraform. Each task's "test" is `terraform fmt -check` + `terraform init -backend=false` + `terraform validate`. A live `terraform plan`/`apply` requires real credentials and the operator deleting the manual resources first — that is the final runbook task (Task 9), executed by the operator, not auto-run.

**Prerequisite tooling:** `terraform` CLI must be on PATH. If absent, install Terraform ≥ 1.6 before Task 1 (`terraform -version` to confirm).

---

### Task 1: Repo skeleton + gitignore

**Files:**
- Modify: `/srv/data/recycle_erp/.gitignore`
- Create: `/srv/data/recycle_erp/infra/terraform/.gitkeep`

- [ ] **Step 1: Append Terraform ignores to `.gitignore`**

Add these lines to the end of `/srv/data/recycle_erp/.gitignore`:

```gitignore

# Terraform
infra/terraform/**/.terraform/*
*.tfstate
*.tfstate.*
*.tfstate.backup
crash.log
crash.*.log
*.auto.tfvars
**/*.secret.tfvars
.terraform.lock.hcl
```

(`.terraform.lock.hcl` is ignored deliberately: this is a private single-operator setup and we are not vendoring provider hashes. `prod.tfvars` is intentionally NOT ignored — it holds only non-secret IDs and is committed.)

- [ ] **Step 2: Create the directory marker**

Create `/srv/data/recycle_erp/infra/terraform/.gitkeep` with empty content.

- [ ] **Step 3: Verify gitignore matches state files**

Run: `cd /srv/data/recycle_erp && git check-ignore -v infra/terraform/environments/prod/terraform.tfstate`
Expected: a line showing `.gitignore:<n>:*.tfstate` matched the path.

- [ ] **Step 4: Commit**

```bash
cd /srv/data/recycle_erp
git add .gitignore infra/terraform/.gitkeep
git commit -m "chore(infra): scaffold terraform dir + gitignore"
```

---

### Task 2: Module — provider pinning and variables

**Files:**
- Create: `/srv/data/recycle_erp/infra/terraform/modules/cloudflare/versions.tf`
- Create: `/srv/data/recycle_erp/infra/terraform/modules/cloudflare/variables.tf`

- [ ] **Step 1: Write `versions.tf`**

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}
```

- [ ] **Step 2: Write `variables.tf`**

```hcl
variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the R2 bucket and token."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Zone ID for the custom domain's parent zone (recycleservers.com)."
  type        = string
}

variable "bucket_name" {
  description = "R2 bucket name for scan/attachment storage."
  type        = string
  default     = "recycle-erp-attachments"
}

variable "bucket_location" {
  description = "R2 location hint (v5 lowercase region codes: apac, eeur, enam, weur, wnam, oc). Honored only on first creation."
  type        = string
  default     = "enam"

  validation {
    condition     = contains(["apac", "eeur", "enam", "weur", "wnam", "oc"], var.bucket_location)
    error_message = "bucket_location must be one of: apac, eeur, enam, weur, wnam, oc."
  }
}

variable "custom_domain" {
  description = "Public custom domain bound to the bucket (served at the domain ROOT, not under a /bucket path)."
  type        = string
  default     = "static.recycleservers.com"
}

variable "cors_allowed_origins" {
  description = "Origins allowed to read objects via browser fetch/canvas. GET/HEAD only; all writes are server-side."
  type        = list(string)
  default     = ["https://inventory.recycleservers.com"]
}

variable "cors_max_age_seconds" {
  description = "How long browsers may cache the CORS preflight response."
  type        = number
  default     = 3600
}

variable "lifecycle_expire_days" {
  description = "Delete objects older than N days. 0 = lifecycle disabled (attachments never auto-deleted)."
  type        = number
  default     = 0

  validation {
    condition     = var.lifecycle_expire_days >= 0
    error_message = "lifecycle_expire_days must be >= 0."
  }
}

variable "r2_token_name" {
  description = "Name of the scoped R2 API token the backend uses for S3 access."
  type        = string
  default     = "recycle-erp-backend-r2"
}

variable "r2_token_permission_group_ids" {
  description = <<-EOT
    Cloudflare permission group IDs granted to the R2 token. Defaults are the
    stable account-agnostic IDs for "Workers R2 Storage Write" and
    "Workers R2 Storage Read". Verify for your account with:
      curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        https://api.cloudflare.com/client/v4/user/tokens/permission_groups \
        | jq '.result[] | select(.name|test("R2 Storage")) | {id,name}'
  EOT
  type        = list(string)
  default = [
    "bf7481a1826f439697cb59a20b22293e", # Workers R2 Storage Write
    "b4992e1108244f5d8bfbd5744320c2e1", # Workers R2 Storage Read
  ]
}
```

- [ ] **Step 3: fmt + validate the module in isolation**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform/modules/cloudflare
terraform fmt -check
terraform init -backend=false
terraform validate
```
Expected: `fmt` prints nothing (already formatted); `validate` prints `Success! The configuration is valid.` (a module with only variables + versions validates cleanly).

- [ ] **Step 4: Commit**

```bash
cd /srv/data/recycle_erp
git add infra/terraform/modules/cloudflare/versions.tf infra/terraform/modules/cloudflare/variables.tf
git commit -m "feat(infra): cloudflare module provider pin + variables"
```

---

### Task 3: Module — R2 bucket, CORS, lifecycle

**Files:**
- Create: `/srv/data/recycle_erp/infra/terraform/modules/cloudflare/r2.tf`

- [ ] **Step 1: Write `r2.tf`**

```hcl
resource "cloudflare_r2_bucket" "attachments" {
  account_id = var.cloudflare_account_id
  name       = var.bucket_name
  location   = var.bucket_location
}

resource "cloudflare_r2_bucket_cors" "attachments" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.attachments.name

  rules = [{
    allowed = {
      methods = ["GET", "HEAD"]
      origins = var.cors_allowed_origins
      headers = ["*"]
    }
    max_age_seconds = var.cors_max_age_seconds
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "attachments" {
  count       = var.lifecycle_expire_days > 0 ? 1 : 0
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.attachments.name

  rules = [{
    id      = "expire-old-objects"
    enabled = true
    conditions = {
      prefix = ""
    }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = var.lifecycle_expire_days * 86400
      }
    }
  }]
}
```

- [ ] **Step 2: fmt + validate**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform/modules/cloudflare
terraform fmt -check
terraform validate
```
Expected: no fmt output; `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp
git add infra/terraform/modules/cloudflare/r2.tf
git commit -m "feat(infra): R2 bucket, CORS, optional lifecycle"
```

---

### Task 4: Module — R2 custom domain (owns the DNS record)

**Files:**
- Create: `/srv/data/recycle_erp/infra/terraform/modules/cloudflare/domain.tf`

> No separate `cloudflare_dns_record`. When the custom domain's zone is on the same Cloudflare account (it is — `recycleservers.com`), `cloudflare_r2_custom_domain` automatically creates and manages the proxied CNAME. A separate DNS-record resource for the same hostname causes a "record already exists" conflict.

- [ ] **Step 1: Write `domain.tf`**

```hcl
resource "cloudflare_r2_custom_domain" "attachments" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.attachments.name
  domain      = var.custom_domain
  zone_id     = var.cloudflare_zone_id
  enabled     = true
  min_tls     = "1.2"
}
```

- [ ] **Step 2: fmt + validate**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform/modules/cloudflare
terraform fmt -check
terraform validate
```
Expected: no fmt output; `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp
git add infra/terraform/modules/cloudflare/domain.tf
git commit -m "feat(infra): R2 custom domain (auto-manages proxied CNAME)"
```

---

### Task 5: Module — scoped R2 API token

**Files:**
- Create: `/srv/data/recycle_erp/infra/terraform/modules/cloudflare/token.tf`

- [ ] **Step 1: Write `token.tf`**

```hcl
resource "cloudflare_api_token" "backend_r2" {
  name = var.r2_token_name

  policies = [{
    effect = "allow"
    permission_groups = [
      for pg_id in var.r2_token_permission_group_ids : { id = pg_id }
    ]
    resources = {
      "com.cloudflare.api.account.${var.cloudflare_account_id}" = "*"
    }
  }]
}
```

> The token's secret (`.value`) is stored in Terraform state. This is unavoidable for a Terraform-managed token and is mitigated by the private state bucket (Task 7) and treating state as a secret.

- [ ] **Step 2: fmt + validate**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform/modules/cloudflare
terraform fmt -check
terraform validate
```
Expected: no fmt output; `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp
git add infra/terraform/modules/cloudflare/token.tf
git commit -m "feat(infra): scoped R2 API token for the backend"
```

---

### Task 6: Module — outputs

**Files:**
- Create: `/srv/data/recycle_erp/infra/terraform/modules/cloudflare/outputs.tf`

- [ ] **Step 1: Write `outputs.tf`**

```hcl
output "bucket_name" {
  description = "R2 bucket name (set as backend env R2_BUCKET)."
  value       = cloudflare_r2_bucket.attachments.name
}

output "r2_s3_endpoint" {
  description = "S3-compatible endpoint (set as backend env R2_S3_ENDPOINT)."
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "public_url" {
  description = "Public base URL for objects. Custom domain serves at the ROOT, so this has NO /<bucket> path segment. Set as backend env R2_ATTACHMENTS_PUBLIC_URL."
  value       = "https://${var.custom_domain}"
}

output "r2_access_key_id" {
  description = "Access Key ID for the backend (R2_ACCESS_KEY_ID). This is the API token's ID."
  value       = cloudflare_api_token.backend_r2.id
  sensitive   = true
}

output "r2_secret_access_key" {
  description = "Secret Access Key for the backend (R2_SECRET_ACCESS_KEY) = SHA-256 hex of the token value, per R2's S3 auth scheme."
  value       = sha256(cloudflare_api_token.backend_r2.value)
  sensitive   = true
}

output "r2_token_value" {
  description = "Raw Cloudflare API token value (only needed if using the token directly against the Cloudflare API rather than the S3 endpoint)."
  value       = cloudflare_api_token.backend_r2.value
  sensitive   = true
}
```

> R2's S3 API uses the token **ID** as the Access Key ID and the **SHA-256 of the token value** as the Secret Access Key. This is the documented R2 S3 credential derivation, hence the `sha256()` on the secret output.

- [ ] **Step 2: fmt + validate**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform/modules/cloudflare
terraform fmt -check
terraform validate
```
Expected: no fmt output; `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
cd /srv/data/recycle_erp
git add infra/terraform/modules/cloudflare/outputs.tf
git commit -m "feat(infra): module outputs mapping to backend R2_* env vars"
```

---

### Task 7: Bootstrap config — the Terraform-state R2 bucket

**Files:**
- Create: `/srv/data/recycle_erp/infra/terraform/bootstrap/main.tf`
- Create: `/srv/data/recycle_erp/infra/terraform/bootstrap/README.md`

- [ ] **Step 1: Write `bootstrap/main.tf`**

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
  # Local state on purpose: this config creates the bucket that every other
  # config stores its state in. Its own tfstate is gitignored.
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment.
}

variable "cloudflare_account_id" {
  type    = string
  default = "cf0e09b533b74d32407f6fe1b558165b"
}

variable "state_bucket_name" {
  type    = string
  default = "recycle-erp-tfstate"
}

variable "state_bucket_location" {
  type    = string
  default = "enam"
}

resource "cloudflare_r2_bucket" "tfstate" {
  account_id = var.cloudflare_account_id
  name       = var.state_bucket_name
  location   = var.state_bucket_location
  # No CORS, no custom domain, no public access: state is secret.
}

output "state_bucket_name" {
  value = cloudflare_r2_bucket.tfstate.name
}

output "state_s3_endpoint" {
  value = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}
```

- [ ] **Step 2: Write `bootstrap/README.md`**

```markdown
# Terraform state bootstrap

Run **once**, before `environments/prod`. Creates the private R2 bucket
`recycle-erp-tfstate` that holds all Terraform state. Uses **local state**
(its own `terraform.tfstate` stays here, gitignored).

## Run

    export CLOUDFLARE_API_TOKEN=<an account-scoped token with R2 Admin + DNS Edit>
    cd infra/terraform/bootstrap
    terraform init
    terraform apply

Keep the local `terraform.tfstate` in this directory. It is small and only
tracks the one state bucket; losing it just means re-importing that bucket.

## R2 S3 credentials for the backend

The `environments/prod` S3 backend authenticates to R2 with an R2 token's
S3 credentials. Create an R2 API token in the Cloudflare dashboard
(R2 → Manage API Tokens → Object Read & Write), then:

    export AWS_ACCESS_KEY_ID=<r2 token Access Key ID>
    export AWS_SECRET_ACCESS_KEY=<r2 token Secret Access Key>

These are used only by the Terraform S3 backend, separate from the
`CLOUDFLARE_API_TOKEN` the provider uses.
```

- [ ] **Step 3: fmt + validate**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform/bootstrap
terraform fmt -check
terraform init -backend=false
terraform validate
```
Expected: no fmt output; `Success! The configuration is valid.`

- [ ] **Step 4: Commit**

```bash
cd /srv/data/recycle_erp
git add infra/terraform/bootstrap/main.tf infra/terraform/bootstrap/README.md
git commit -m "feat(infra): bootstrap config for the TF-state R2 bucket"
```

---

### Task 8: Prod environment root + runbook

**Files:**
- Create: `/srv/data/recycle_erp/infra/terraform/environments/prod/main.tf`
- Create: `/srv/data/recycle_erp/infra/terraform/environments/prod/backend.tf`
- Create: `/srv/data/recycle_erp/infra/terraform/environments/prod/prod.tfvars`
- Create: `/srv/data/recycle_erp/infra/terraform/environments/prod/README.md`

- [ ] **Step 1: Write `environments/prod/main.tf`**

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment.
}

variable "cloudflare_account_id" {
  type = string
}

variable "cloudflare_zone_id" {
  type = string
}

module "cloudflare" {
  source = "../../modules/cloudflare"

  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  # All other inputs use the module defaults (bucket name, enam location,
  # custom domain, CORS origin, lifecycle disabled).
}

output "bucket_name" {
  value = module.cloudflare.bucket_name
}

output "r2_s3_endpoint" {
  value = module.cloudflare.r2_s3_endpoint
}

output "public_url" {
  value = module.cloudflare.public_url
}

output "r2_access_key_id" {
  value     = module.cloudflare.r2_access_key_id
  sensitive = true
}

output "r2_secret_access_key" {
  value     = module.cloudflare.r2_secret_access_key
  sensitive = true
}
```

- [ ] **Step 2: Write `environments/prod/backend.tf`**

```hcl
terraform {
  backend "s3" {
    bucket = "recycle-erp-tfstate"
    key    = "prod/terraform.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://cf0e09b533b74d32407f6fe1b558165b.r2.cloudflarestorage.com"
    }

    # R2-required S3 backend flags.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
```

- [ ] **Step 3: Write `environments/prod/prod.tfvars`**

```hcl
# Non-secret Cloudflare identifiers. Safe to commit.
cloudflare_account_id = "cf0e09b533b74d32407f6fe1b558165b"
cloudflare_zone_id    = "dd2a6dc1b973dc1f98b1cb009edae6d1"
```

- [ ] **Step 4: Write `environments/prod/README.md`**

```markdown
# Prod environment

Calls `modules/cloudflare` and stores state in the `recycle-erp-tfstate`
R2 bucket. **Run `infra/terraform/bootstrap` first** (creates that bucket).

## ⚠️ Destructive prerequisite

Terraform creates resources fresh, reusing existing names. Before the first
apply, **manually delete** the existing hand-created Cloudflare resources in
the dashboard:

1. R2 → `recycle-erp-attachments` → remove the custom domain, then delete
   the bucket (this destroys all existing label-scan / attachment objects;
   DB storage keys for old objects will 404 until re-uploaded).
2. DNS → any pre-existing record for `static.recycleservers.com` (only if it
   was created outside the R2 custom-domain feature).

## Apply

    export CLOUDFLARE_API_TOKEN=<account token: R2 Admin + DNS Edit>
    export AWS_ACCESS_KEY_ID=<r2 S3 token Access Key ID>
    export AWS_SECRET_ACCESS_KEY=<r2 S3 token Secret Access Key>

    cd infra/terraform/environments/prod
    terraform init
    terraform plan  -var-file=prod.tfvars     # expect a clean create-only plan
    terraform apply -var-file=prod.tfvars

## Wire the backend

After apply, read the outputs and set the backend (`apps/backend/.env` or
Docker secrets):

    terraform output -raw r2_s3_endpoint        # -> R2_S3_ENDPOINT
    terraform output -raw bucket_name           # -> R2_BUCKET
    terraform output -raw public_url            # -> R2_ATTACHMENTS_PUBLIC_URL
    terraform output -raw r2_access_key_id      # -> R2_ACCESS_KEY_ID
    terraform output -raw r2_secret_access_key  # -> R2_SECRET_ACCESS_KEY

**Behavior change:** the custom domain now serves objects at the domain
ROOT. `R2_ATTACHMENTS_PUBLIC_URL` must be `https://static.recycleservers.com`
— WITHOUT the old `/recycle-erp-attachments` path segment.
```

- [ ] **Step 5: fmt + validate (no backend init)**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform/environments/prod
terraform fmt -check
terraform init -backend=false
terraform validate
```
Expected: no fmt output; `Success! The configuration is valid.` (`-backend=false` skips contacting R2, so this works without credentials.)

- [ ] **Step 6: Commit**

```bash
cd /srv/data/recycle_erp
git add infra/terraform/environments/prod/
git commit -m "feat(infra): prod environment root + R2 state backend + runbook"
```

---

### Task 9: Repo-wide fmt + final verification (operator-run live apply)

**Files:** none (verification only)

- [ ] **Step 1: Repo-wide formatting check**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform
terraform fmt -recursive -check
```
Expected: no output (all files formatted). If anything prints, run `terraform fmt -recursive`, then `git add -A infra/terraform && git commit -m "style(infra): terraform fmt"`.

- [ ] **Step 2: Validate every config**

Run:
```bash
cd /srv/data/recycle_erp/infra/terraform
for d in bootstrap modules/cloudflare environments/prod; do
  ( cd "$d" && terraform init -backend=false >/dev/null && terraform validate )
done
```
Expected: `Success! The configuration is valid.` printed three times.

- [ ] **Step 3: Operator live apply (manual — NOT auto-run)**

This step is performed by the operator with real credentials, after deleting
the manual resources (see `environments/prod/README.md`):

1. `bootstrap`: `terraform init && terraform apply`
2. `environments/prod`: `terraform init` → `terraform plan -var-file=prod.tfvars`
3. Confirm the plan is **create-only** (no destroys/replacements of unrelated infra).
4. `terraform apply -var-file=prod.tfvars`
5. Wire the five `R2_*` outputs into the backend env; redeploy backend.
6. Smoke test: upload a label scan, confirm it stores and the public URL
   (`https://static.recycleservers.com/<key>`) serves the image.

- [ ] **Step 4: Update the R2 memory note**

After a successful live cut-over, update the project memory: the R2 setup is
now Terraform-managed and `R2_ATTACHMENTS_PUBLIC_URL` no longer carries the
`/recycle-erp-attachments` path segment (supersedes the prior note that the
custom domain serves at `/<bucket>/<key>`).

---

## Self-Review

**Spec coverage:**
- R2 bucket + CORS + lifecycle → Task 3 ✓
- R2 custom domain (owns DNS, no duplicate record) → Task 4 ✓ (matches spec correction)
- Scoped R2 API token, secret-in-state caveat → Task 5 ✓
- Variables/outputs mapping to backend `R2_*` env → Tasks 2, 6 ✓
- R2 S3 state backend + bootstrap chicken-and-egg → Tasks 7, 8 ✓
- Secrets/gitignore handling → Task 1 ✓
- Public-URL behavior change documented → Tasks 6, 8 ✓
- Destructive "delete manual resources first" caveat → Task 8 README ✓
- Validation = fmt/validate/plan + runbook → Tasks 2–9 ✓
- Single prod env, reusable module structure (Approach A) → Tasks 2–8 ✓

**Placeholder scan:** No TBD/TODO. Permission-group IDs have concrete documented defaults plus a verification command. Account/zone IDs are the user-supplied real values. No "add error handling" hand-waves.

**Type/name consistency:** `cloudflare_r2_bucket.attachments.name` referenced consistently by CORS, lifecycle, custom domain. Module outputs (`bucket_name`, `r2_s3_endpoint`, `public_url`, `r2_access_key_id`, `r2_secret_access_key`) re-exported with identical names in the prod root. Account ID `cf0e09b533b74d32407f6fe1b558165b` identical in bootstrap, backend endpoint, and prod.tfvars. Variable names match between `variables.tf` and all `.tf` references.
