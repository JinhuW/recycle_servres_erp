# facebook-tracker infrastructure — the control plane's Postgres on Railway.
#
# A dedicated Postgres instance, deliberately NOT the one reddits-tracker uses.
# Two reasons, both about blast radius rather than performance:
#
#   1. This database holds the fleet's account vault — every Facebook password
#      and TOTP secret, Fernet-encrypted. It deserves an isolation boundary of
#      its own rather than sitting beside another app's operational data.
#   2. reddits-tracker's migration runner has a `--reset` that drops every
#      table in the public schema. Sharing would put these tables in its path.
#
# The unified "all finds, any source" view people expect from a shared database
# is built in the ERP anyway: it reads both trackers over HTTP proxies, never by
# joining tables. So sharing would have bought coupling without the payoff.
#
# STATE CONTAINS A SECRET. Unlike the reddits-tracker stack (whose state is
# secrets-free), this one generates the Postgres password, so the state file is
# itself a credential. It is gitignored and kept local; see infra/README.md
# before moving it to the shared remote backend.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    railway = {
      source  = "terraform-community-providers/railway"
      version = "~> 0.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Local state for now: the reddits-tracker convention (OCI Object Storage over
  # the S3-compatible API) needs ~/.aws/credentials, which this machine does not
  # have. infra/README.md documents the migration, and the note above about this
  # state holding a password applies doubly to a shared bucket.
  #
  # backend "s3" {
  #   bucket = "terraform-state-cross-region-cloud"
  #   key    = "homelab_infra/facebook-tracker"
  #   region = "ap-singapore-1"
  #   endpoints = {
  #     s3 = "https://ax6usa8hwbie.compat.objectstorage.ap-singapore-1.oraclecloud.com"
  #   }
  #   skip_region_validation      = true
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   skip_requesting_account_id  = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  # }
}

# Token comes from RAILWAY_TOKEN so it never lands in a file or in state.
provider "railway" {}
