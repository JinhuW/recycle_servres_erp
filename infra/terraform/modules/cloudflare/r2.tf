resource "cloudflare_r2_bucket" "attachments" {
  account_id = var.cloudflare_account_id
  name       = var.bucket_name
  location   = var.bucket_location
}

resource "cloudflare_r2_bucket_cors" "attachments" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.attachments.name

  rules = [{
    allowed = {
      methods = ["GET", "HEAD"]
      origins = var.cors_allowed_origins
      headers = ["*"]
    }
    max_age_seconds = var.cors_max_age_seconds
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "attachments" {
  count       = var.lifecycle_expire_days > 0 ? 1 : 0
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.attachments.name

  rules = [{
    id      = "expire-old-objects"
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
