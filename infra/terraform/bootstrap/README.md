# Terraform state bootstrap

Run **once**, before `environments/prod`. Creates the private R2 bucket
`recycle-erp-tfstate` that holds all Terraform state. Uses **local state**
(its own `terraform.tfstate` stays here, gitignored).

## Run

    export CLOUDFLARE_API_TOKEN=<an account-scoped token with R2 Admin + DNS Edit>
    cd infra/terraform/bootstrap
    terraform init
    terraform apply

Keep the local `terraform.tfstate` in this directory. It is small and only
tracks the one state bucket; losing it just means re-importing that bucket.

## R2 S3 credentials for the backend

The `environments/prod` S3 backend authenticates to R2 with an R2 token's
S3 credentials. Create an R2 API token in the Cloudflare dashboard
(R2 → Manage API Tokens → Object Read & Write), then:

    export AWS_ACCESS_KEY_ID=<r2 token Access Key ID>
    export AWS_SECRET_ACCESS_KEY=<r2 token Secret Access Key>

These are used only by the Terraform S3 backend, separate from the
`CLOUDFLARE_API_TOKEN` the provider uses.
