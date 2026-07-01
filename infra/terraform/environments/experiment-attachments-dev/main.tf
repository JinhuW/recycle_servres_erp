# Dev attachments R2 bucket + bucket-scoped token for the experimental Railway
# DEV backend. Isolated from environments/prod (own state key) so the dev
# environment never shares credentials or storage with prod (finding H4/C5).
# No custom domain: dev serves attachments from the R2 managed r2.dev URL.

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
  type    = string
  default = "cf0e09b533b74d32407f6fe1b558165b"
}

variable "bucket_name" {
  type    = string
  default = "recycle-erp-attachments-dev"
}

variable "r2_token_name" {
  type    = string
  default = "recycle-erp-backend-r2-dev"
}

variable "r2_token_permission_group_ids" {
  description = "Stable account-agnostic IDs for Workers R2 Storage Write/Read."
  type        = list(string)
  default = [
    "bf7481a1826f439697cb59a20b22293e", # Workers R2 Storage Write
    "b4992e1108244f5d8bfbd5744320c2e1", # Workers R2 Storage Read
  ]
}

resource "cloudflare_r2_bucket" "attachments_dev" {
  account_id = var.cloudflare_account_id
  name       = var.bucket_name
  # No prevent_destroy: the dev bucket is disposable (mirrors the experiment).
}

# Bucket-scoped token: a leak can't touch prod attachments, backups, or tfstate.
locals {
  r2_bucket_resource_key = "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${cloudflare_r2_bucket.attachments_dev.name}"
}

resource "cloudflare_api_token" "backend_r2_dev" {
  name = var.r2_token_name

  policies = [{
    effect            = "allow"
    permission_groups = [for id in var.r2_token_permission_group_ids : { id = id }]
    resources         = jsonencode({ (local.r2_bucket_resource_key) = "*" })
  }]
}

output "bucket_name" {
  value = cloudflare_r2_bucket.attachments_dev.name
}

output "r2_access_key_id" {
  value     = cloudflare_api_token.backend_r2_dev.id
  sensitive = true
}

output "r2_secret_access_key" {
  value     = sha256(cloudflare_api_token.backend_r2_dev.value)
  sensitive = true
}
