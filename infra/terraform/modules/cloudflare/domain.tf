resource "cloudflare_r2_custom_domain" "attachments" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.attachments.name
  domain      = var.custom_domain
  zone_id     = var.cloudflare_zone_id
  enabled     = true
  min_tls     = "1.2"
}
