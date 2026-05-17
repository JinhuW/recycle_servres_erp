# SECURITY: this token's secret (.value) is stored in Terraform state.
# Unavoidable for a Terraform-managed token. Mitigated by keeping the state
# in a private R2 bucket with no public access (see bootstrap/) and treating
# state as a secret.
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
