output "project_id" {
  description = "Railway project id."
  value       = railway_project.facebook_tracker.id
}

output "environment_id" {
  description = "Default environment id — needed when adding services by hand."
  value       = railway_project.facebook_tracker.default_environment.id
}

locals {
  # Railway returns the proxy domain as an absolute FQDN with the root dot
  # ("shortline.proxy.rlwy.net."). Valid DNS, but it travels into connection
  # strings and config files where some parsers and TLS hostname checks trip
  # over it, so it is trimmed once here rather than in every consumer.
  postgres_host = trimsuffix(railway_tcp_proxy.postgres.domain, ".")
}

output "postgres_host" {
  description = "Public TCP proxy host."
  value       = local.postgres_host
}

output "postgres_port" {
  description = "Public TCP proxy port. Not 5432 — Railway assigns it."
  value       = railway_tcp_proxy.postgres.proxy_port
}

output "database_url" {
  description = <<-EOT
    The connection string for RS_DATABASE_URL, over the public proxy.

    Read it with `terraform output -raw database_url`. sslmode=require is
    explicit because the coordinator only infers it for non-loopback hosts, and
    being wrong about TLS on a public endpoint is not a mistake worth risking.
  EOT
  sensitive   = true
  value = format(
    "postgresql://%s:%s@%s:%d/%s?sslmode=require",
    var.postgres_user,
    random_password.postgres.result,
    local.postgres_host,
    railway_tcp_proxy.postgres.proxy_port,
    var.postgres_database,
  )
}

output "internal_database_url" {
  description = "For anything running inside this Railway project. No TLS on the private network."
  sensitive   = true
  value = format(
    "postgresql://%s:%s@postgres.railway.internal:5432/%s",
    var.postgres_user,
    random_password.postgres.result,
    var.postgres_database,
  )
}
