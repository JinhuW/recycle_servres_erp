# reddits-tracker worker fleet — Always-Free VMs across both tenancies.
#
# Each VM is one Reddit rate-limit budget (the tracker's anonymous limit is
# per IP), so the fleet maximizes distinct public IPs at zero cost. The VMs
# are stateless workers; the shared Postgres lives on Railway.
#
# Secrets are NOT in this configuration or its state: cloud-init only installs
# docker. The app env file, GHCR login, and container start are pushed over
# SSH by ../scripts/deploy-workers.sh after apply.
#
# DO NOT manage or import the existing Vaultwarden VM (instance-20220516-2257,
# Toronto) or anything else outside this stack. This stack only creates new
# resources in its own VCNs.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
    cloudinit = {
      source  = "hashicorp/cloudinit"
      version = "~> 2.3"
    }
  }

  # Remote state per homelab_infra convention (docs/oracle/account.md §5):
  # OCI Object Storage via the S3-compat API, creds from ~/.aws/credentials.
  # Safe for secrets-free state (see header note).
  backend "s3" {
    bucket = "terraform-state-cross-region-cloud"
    key    = "homelab_infra/reddits-tracker"
    region = "ap-singapore-1"
    endpoints = {
      s3 = "https://ax6usa8hwbie.compat.objectstorage.ap-singapore-1.oraclecloud.com"
    }
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Api-key auth from ~/.oci/config. Region comes from each profile.
provider "oci" {
  alias               = "singapore"
  config_file_profile = "DEFAULT"
}

provider "oci" {
  alias               = "toronto"
  config_file_profile = "jinhuwang112"
}
