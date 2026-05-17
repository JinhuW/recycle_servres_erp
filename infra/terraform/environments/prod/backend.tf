terraform {
  backend "s3" {
    bucket = "recycle-erp-tfstate"
    key    = "prod/terraform.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://cf0e09b533b74d32407f6fe1b558165b.r2.cloudflarestorage.com"
    }

    # R2-required S3 backend flags.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
