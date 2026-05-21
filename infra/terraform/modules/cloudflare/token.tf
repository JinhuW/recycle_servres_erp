# SECURITY: this token's secret (.value) is stored in Terraform state.
# Unavoidable for a Terraform-managed token. Mitigated by keeping the state
# in a private R2 bucket with no public access (see bootstrap/) and treating
# state as a secret.
#
# SECURITY: the policy is scoped to ONLY the single attachments bucket, not the
# whole account. A leaked backend token therefore cannot read/write/delete any
# other R2 bucket in the account (notably the recycle-erp-tfstate state bucket).
#
# Cloudflare's bucket-scoped resource selector key format is:
#   com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_<JURISDICTION>_<BUCKET_NAME>
# (default jurisdiction is "default"). Confirmed against Cloudflare docs:
#   https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/r2/api/tokens.mdx
# The bucket name is taken from the managed cloudflare_r2_bucket.attachments
# resource so the scope tracks the bucket automatically. The bucket sets no
# jurisdiction, so it lives in the "default" jurisdiction.
locals {
  r2_bucket_resource_key = "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${cloudflare_r2_bucket.attachments.name}"
}

resource "cloudflare_api_token" "backend_r2" {
  name = var.r2_token_name

  policies = [{
    effect = "allow"
    permission_groups = [
      for pg_id in var.r2_token_permission_group_ids : { id = pg_id }
    ]
    resources = jsonencode({
      (local.r2_bucket_resource_key) = "*"
    })
  }]
}
