output "worker_ips" {
  description = "Public IPs of every worker, grouped by pool. deploy-workers.sh reads this."
  value = {
    sg_arm = module.sg_arm.public_ips
    sg_amd = module.sg_amd.public_ips
    to_arm = module.to_arm.public_ips
    to_amd = module.to_amd.public_ips
  }
}

output "ssh_commands" {
  description = "Convenience SSH lines (user is ubuntu)."
  value = [
    for ip in flatten([
      module.sg_arm.public_ips,
      module.sg_amd.public_ips,
      module.to_arm.public_ips,
      module.to_amd.public_ips,
    ]) : "ssh ubuntu@${ip}"
  ]
}

output "toronto_arm_availability" {
  description = <<-EOT
    Free A1 OCPUs per AD in Toronto BEFORE this stack's own usage. Raise
    to_arm_count only up to this number (the Vaultwarden VM's share is already
    subtracted by OCI).
  EOT
  value       = module.to_arm.shape_availability
}

output "singapore_arm_availability" {
  description = "Free A1 OCPUs per AD in Singapore (sanity check after OKE teardown)."
  value       = module.sg_arm.shape_availability
}
