variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the R2 bucket and token."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Zone ID for the custom domain's parent zone (recycleservers.com)."
  type        = string
}

variable "bucket_name" {
  description = "R2 bucket name for scan/attachment storage."
  type        = string
  default     = "recycle-erp-attachments"
}

variable "bucket_location" {
  description = "R2 location hint (v5 lowercase region codes: apac, eeur, enam, weur, wnam, oc). Honored only on first creation."
  type        = string
  default     = "enam"

  validation {
    condition     = contains(["apac", "eeur", "enam", "weur", "wnam", "oc"], var.bucket_location)
    error_message = "bucket_location must be one of: apac, eeur, enam, weur, wnam, oc."
  }
}

variable "custom_domain" {
  description = "Public custom domain bound to the bucket (served at the domain ROOT, not under a /bucket path)."
  type        = string
  default     = "static.recycleservers.com"
}

variable "cors_allowed_origins" {
  description = "Origins allowed to read objects via browser fetch/canvas. GET/HEAD only; all writes are server-side."
  type        = list(string)
  default     = ["https://inventory.recycleservers.com"]
}

variable "cors_max_age_seconds" {
  description = "How long browsers may cache the CORS preflight response."
  type        = number
  default     = 3600
}

variable "lifecycle_expire_days" {
  description = "Delete objects older than N days. 0 = lifecycle disabled (attachments never auto-deleted)."
  type        = number
  default     = 0

  validation {
    condition     = var.lifecycle_expire_days >= 0
    error_message = "lifecycle_expire_days must be >= 0."
  }
}

variable "r2_token_name" {
  description = "Name of the scoped R2 API token the backend uses for S3 access."
  type        = string
  default     = "recycle-erp-backend-r2"
}

variable "r2_token_permission_group_ids" {
  description = <<-EOT
    Cloudflare permission group IDs granted to the R2 token. Defaults are the
    stable account-agnostic IDs for "Workers R2 Storage Write" and
    "Workers R2 Storage Read". Verify for your account with:
      curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        https://api.cloudflare.com/client/v4/user/tokens/permission_groups \
        | jq '.result[] | select(.name|test("R2 Storage")) | {id,name}'
  EOT
  type        = list(string)
  default = [
    "bf7481a1826f439697cb59a20b22293e", # Workers R2 Storage Write
    "b4992e1108244f5d8bfbd5744320c2e1", # Workers R2 Storage Read
  ]
}
