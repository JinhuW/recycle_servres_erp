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
