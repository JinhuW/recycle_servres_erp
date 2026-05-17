# Prod environment

Calls `modules/cloudflare` and stores state in the `recycle-erp-tfstate`
R2 bucket. **Run `infra/terraform/bootstrap` first** (creates that bucket).

## ⚠️ Destructive prerequisite

Terraform creates resources fresh, reusing existing names. Before the first
apply, **manually delete** the existing hand-created Cloudflare resources in
the dashboard:

1. R2 → `recycle-erp-attachments` → remove the custom domain, then delete
   the bucket (this destroys all existing label-scan / attachment objects;
   DB storage keys for old objects will 404 until re-uploaded).
2. DNS → any pre-existing record for `static.recycleservers.com` (only if it
   was created outside the R2 custom-domain feature).

## Apply

    export CLOUDFLARE_API_TOKEN=<account token: R2 Admin + DNS Edit>
    export AWS_ACCESS_KEY_ID=<r2 S3 token Access Key ID>
    export AWS_SECRET_ACCESS_KEY=<r2 S3 token Secret Access Key>

    cd infra/terraform/environments/prod
    terraform init
    terraform plan  -var-file=prod.tfvars     # expect a clean create-only plan
    terraform apply -var-file=prod.tfvars

## Wire the backend

After apply, read the outputs and set the backend (`apps/backend/.env` or
Docker secrets):

    terraform output -raw r2_s3_endpoint        # -> R2_S3_ENDPOINT
    terraform output -raw bucket_name           # -> R2_BUCKET
    terraform output -raw public_url            # -> R2_ATTACHMENTS_PUBLIC_URL
    terraform output -raw r2_access_key_id      # -> R2_ACCESS_KEY_ID
    terraform output -raw r2_secret_access_key  # -> R2_SECRET_ACCESS_KEY

**Behavior change:** the custom domain now serves objects at the domain
ROOT. `R2_ATTACHMENTS_PUBLIC_URL` must be `https://static.recycleservers.com`
— WITHOUT the old `/recycle-erp-attachments` path segment.
