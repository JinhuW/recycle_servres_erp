output "bucket_name" {
  description = "R2 bucket name (set as backend env R2_BUCKET)."
  value       = cloudflare_r2_bucket.attachments.name
}

output "r2_s3_endpoint" {
  description = "S3-compatible endpoint (set as backend env R2_S3_ENDPOINT)."
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "public_url" {
  description = "Public base URL for objects. Custom domain serves at the ROOT, so this has NO /<bucket> path segment. Set as backend env R2_ATTACHMENTS_PUBLIC_URL."
  value       = "https://${var.custom_domain}"
}

output "r2_access_key_id" {
  description = "Access Key ID for the backend (R2_ACCESS_KEY_ID). This is the API token's ID."
  value       = cloudflare_api_token.backend_r2.id
  sensitive   = true
}

output "r2_secret_access_key" {
  description = "Secret Access Key for the backend (R2_SECRET_ACCESS_KEY) = SHA-256 hex of the token value, per R2's S3 auth scheme."
  value       = sha256(cloudflare_api_token.backend_r2.value)
  sensitive   = true
}

output "r2_token_value" {
  description = "Raw Cloudflare API token value (only needed if using the token directly against the Cloudflare API rather than the S3 endpoint)."
  value       = cloudflare_api_token.backend_r2.value
  sensitive   = true
}
