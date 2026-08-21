# The project, the Postgres service, and the public TCP proxy the coordinator
# and the worker fleet reach it through.

resource "railway_project" "facebook_tracker" {
  name         = var.project_name
  description  = "Facebook Marketplace tracker — control plane database."
  private      = true
  workspace_id = var.workspace_id
}

# Alphanumeric only, deliberately. The password ends up inside a
# postgresql://user:pass@host/db URL, and a generated '@' or '/' would silently
# truncate the host when a client parses it. 40 chars of [A-Za-z0-9] is far more
# entropy than the symbols would have added.
resource "random_password" "postgres" {
  length  = 40
  special = false
}

resource "railway_service" "postgres" {
  project_id   = railway_project.facebook_tracker.id
  name         = "postgres"
  source_image = var.postgres_image

  volume = {
    name       = "pgdata"
    mount_path = var.volume_mount_path
  }
}

# Service variables. The image reads these on first boot to run initdb; after
# that the volume is authoritative and changing POSTGRES_PASSWORD here does NOT
# rotate the role's password (that needs an ALTER ROLE against a running
# database) — see infra/README.md.
locals {
  postgres_env = {
    POSTGRES_USER     = var.postgres_user
    POSTGRES_PASSWORD = random_password.postgres.result
    POSTGRES_DB       = var.postgres_database

    # A subdirectory of the mount, not the mount itself: Railway volumes come
    # with a lost+found, and initdb refuses to initialise a non-empty directory.
    PGDATA = "${var.volume_mount_path}/pgdata"
  }
}

resource "railway_variable" "postgres" {
  for_each = local.postgres_env

  environment_id = railway_project.facebook_tracker.default_environment.id
  service_id     = railway_service.postgres.id
  name           = each.key
  value          = each.value
}

# Public networking. The coordinator and the worker fleet run outside Railway,
# and the internal *.railway.internal host only resolves from inside Railway's
# private network — so a TCP proxy is required, not optional.
resource "railway_tcp_proxy" "postgres" {
  environment_id   = railway_project.facebook_tracker.default_environment.id
  service_id       = railway_service.postgres.id
  application_port = 5432
}
