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
