variable "project_name" {
  description = "Railway project name. Shown in the dashboard and in `railway list`."
  type        = string
  default     = "facebook-tracker"
}

variable "workspace_id" {
  description = <<-EOT
    Workspace the project is created in. Railway scopes projectCreate to a
    workspace and rejects the call outright when it cannot infer one, so this is
    passed explicitly rather than left to a default.

    Find it with:
      curl -s -X POST https://backboard.railway.com/graphql/v2 \
        -H "Authorization: Bearer $RAILWAY_TOKEN" -H 'Content-Type: application/json' \
        -d '{"query":"query { me { workspaces { id name } } }"}'
  EOT
  type        = string
  default     = "0556aaa2-93c8-4aeb-8a0d-5f71fc83671b" # "My Projects" (personal)
}

variable "postgres_image" {
  description = <<-EOT
    Postgres image for the database service.

    Railway's own template image rather than library/postgres: it ships with TLS
    enabled, and the coordinator connects over the public TCP proxy where
    sslmode=require is the sane default. library/postgres serves no TLS and
    would force the connection down to sslmode=disable.
  EOT
  type        = string
  default     = "ghcr.io/railwayapp-templates/postgres-ssl:16"
}

variable "postgres_user" {
  description = "Superuser role the coordinator connects as."
  type        = string
  default     = "postgres"
}

variable "postgres_database" {
  description = "Database the coordinator's tables live in."
  type        = string
  default     = "facebook_tracker"
}

variable "volume_mount_path" {
  description = <<-EOT
    Where the persistent volume mounts. PGDATA points at a *subdirectory* of
    this (see postgres.tf) because initdb refuses a non-empty directory, and a
    fresh Railway volume contains lost+found.
  EOT
  type        = string
  default     = "/var/lib/postgresql/data"
}
