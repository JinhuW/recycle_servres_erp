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
