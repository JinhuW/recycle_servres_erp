variable "sg_compartment_ocid" {
  description = "Compartment for Singapore resources (tenancy root, matching existing usage)."
  type        = string
}

variable "to_compartment_ocid" {
  description = "Compartment for Toronto resources (tenancy root, matching existing usage)."
  type        = string
}

variable "ssh_public_key" {
  description = "SSH public key installed on every worker VM."
  type        = string
}

variable "ssh_ingress_cidr" {
  description = "CIDR allowed to SSH to the workers. Workers need no other ingress."
  type        = string
  default     = "0.0.0.0/0"
}

# --- fleet sizing -----------------------------------------------------------
# Always-Free caps per tenancy: 4 OCPU / 24 GB total across A1.Flex, plus
# 2x E2.1.Micro. Applies are additive: on "Out of host capacity", lower the
# failing count, apply what fits, and re-raise later. Never destroy working
# A1 instances to retry — freed capacity may not come back for days.

variable "sg_arm_count" {
  description = "A1.Flex workers in Singapore (1 OCPU / 6 GB each, max 4)."
  type        = number
  default     = 4
  validation {
    condition     = var.sg_arm_count >= 0 && var.sg_arm_count <= 4
    error_message = "Always Free allows at most 4x 1-OCPU A1 instances per tenancy."
  }
}

variable "sg_amd_count" {
  description = "E2.1.Micro workers in Singapore (max 2 per tenancy)."
  type        = number
  default     = 2
  validation {
    condition     = var.sg_amd_count >= 0 && var.sg_amd_count <= 2
    error_message = "Always Free allows at most 2 E2.1.Micro instances per tenancy."
  }
}

variable "to_arm_count" {
  description = <<-EOT
    A1.Flex workers in Toronto. Default 0: the existing Vaultwarden VM
    (instance-20220516-2257 — never managed here) consumes an unknown share of
    the 4-OCPU quota. Raise only after `terraform plan` shows headroom in the
    toronto_arm_availability output.
  EOT
  type        = number
  default     = 0
  validation {
    condition     = var.to_arm_count >= 0 && var.to_arm_count <= 4
    error_message = "Always Free allows at most 4 A1 OCPUs per tenancy."
  }
}

variable "to_amd_count" {
  description = "E2.1.Micro workers in Toronto (max 2 per tenancy)."
  type        = number
  default     = 2
  validation {
    condition     = var.to_amd_count >= 0 && var.to_amd_count <= 2
    error_message = "Always Free allows at most 2 E2.1.Micro instances per tenancy."
  }
}
