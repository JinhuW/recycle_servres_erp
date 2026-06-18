# Experimental DB-backup infra: a dedicated R2 bucket + bucket-scoped token for
# Postgres backups of the experimental Railway deployment. Deliberately ISOLATED
# from environments/prod (its own state key, not the shared module) so applying
# this never touches the production attachments bucket/token or its state.
#
# The existing backend R2 token (environments/prod) is scoped to ONLY the
# attachments bucket, so it cannot write here — backups get their own scoped
# token, mirroring that security posture.

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
  # Reads CLOUDFLARE_API_TOKEN from the environment — the same account-scoped
  # token used for environments/prod, kept in your shell (never in .env).
}

variable "cloudflare_account_id" {
  type = string
}

variable "bucket_name" {
  type    = string
  default = "recycle-erp-backups"
}

variable "bucket_location" {
  type    = string
  default = "enam"
}

variable "lifecycle_expire_days" {
  description = "Auto-delete backup objects older than this many days."
  type        = number
  default     = 30
}

variable "r2_token_name" {
  type    = string
  default = "recycle-erp-experiment-backups-r2"
}

variable "r2_token_permission_group_ids" {
  description = "Stable account-agnostic IDs for Workers R2 Storage Write/Read."
  type        = list(string)
  default = [
    "bf7481a1826f439697cb59a20b22293e", # Workers R2 Storage Write
    "b4992e1108244f5d8bfbd5744320c2e1", # Workers R2 Storage Read
  ]
}

resource "cloudflare_r2_bucket" "backups" {
  account_id = var.cloudflare_account_id
  name       = var.bucket_name
  location   = var.bucket_location
  # No prevent_destroy: backups are disposable and the experiment is meant to be
  # torn down. The lifecycle rule below caps retention.
}

resource "cloudflare_r2_bucket_lifecycle" "backups" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.backups.name

  rules = [{
    id      = "expire-old-backups"
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

# Bucket-scoped resource selector. Format (default jurisdiction):
#   com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_default_<BUCKET_NAME>
locals {
  r2_bucket_resource_key = "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${cloudflare_r2_bucket.backups.name}"
}

resource "cloudflare_api_token" "backups_r2" {
  name = var.r2_token_name

  policies = [{
    effect            = "allow"
    permission_groups = [for id in var.r2_token_permission_group_ids : { id = id }]
    resources         = jsonencode({ (local.r2_bucket_resource_key) = "*" })
  }]
}

output "r2_s3_endpoint" {
  description = "S3-compatible endpoint → set as RCLONE_CONFIG_R2_ENDPOINT on the backup service."
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "bucket_name" {
  description = "Backups bucket name → R2_BACKUP_BUCKET."
  value       = cloudflare_r2_bucket.backups.name
}

output "r2_access_key_id" {
  description = "Access Key ID (the token's ID) → RCLONE_CONFIG_R2_ACCESS_KEY_ID."
  value       = cloudflare_api_token.backups_r2.id
  sensitive   = true
}

output "r2_secret_access_key" {
  description = "Secret Access Key = SHA-256 hex of the token value → RCLONE_CONFIG_R2_SECRET_ACCESS_KEY."
  value       = sha256(cloudflare_api_token.backups_r2.value)
  sensitive   = true
}
