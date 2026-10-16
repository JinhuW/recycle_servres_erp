variable "compartment_ocid" {
  type = string
}

variable "subnet_id" {
  description = "Public subnet the workers attach to."
  type        = string
}

variable "name_prefix" {
  description = "Instance display-name prefix; -0, -1, ... appended."
  type        = string
}

variable "shape" {
  description = "VM.Standard.A1.Flex (arm64 flex) or VM.Standard.E2.1.Micro (amd64 fixed)."
  type        = string
  validation {
    condition     = contains(["VM.Standard.A1.Flex", "VM.Standard.E2.1.Micro"], var.shape)
    error_message = "Only the two Always-Free shapes are supported."
  }
}

variable "instance_count" {
  type = number
}

# Only used for flex shapes; the micro's size is fixed by Oracle.
variable "ocpus" {
  type    = number
  default = 1
}

variable "memory_gbs" {
  type    = number
  default = 6
}

variable "ssh_public_key" {
  type = string
}
