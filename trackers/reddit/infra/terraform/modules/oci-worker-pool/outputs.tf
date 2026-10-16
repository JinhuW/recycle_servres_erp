output "public_ips" {
  value = oci_core_instance.worker[*].public_ip
}

output "display_names" {
  value = oci_core_instance.worker[*].display_name
}

output "shape_availability" {
  description = "Free cores for this pool's shape, per AD, before this stack's usage."
  value       = local.ad_availability
}
