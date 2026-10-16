# Four worker pools: {Singapore, Toronto} x {A1.Flex arm64, E2.1.Micro amd64}.
# Modules cannot for_each over providers, so each pool is spelled out.

module "sg_arm" {
  source    = "./modules/oci-worker-pool"
  providers = { oci = oci.singapore }

  compartment_ocid = var.sg_compartment_ocid
  subnet_id        = oci_core_subnet.singapore.id
  name_prefix      = "rtracker-sg-arm"
  shape            = "VM.Standard.A1.Flex"
  instance_count   = var.sg_arm_count
  ocpus            = 1
  memory_gbs       = 6
  ssh_public_key   = var.ssh_public_key
}

module "sg_amd" {
  source    = "./modules/oci-worker-pool"
  providers = { oci = oci.singapore }

  compartment_ocid = var.sg_compartment_ocid
  subnet_id        = oci_core_subnet.singapore.id
  name_prefix      = "rtracker-sg-amd"
  shape            = "VM.Standard.E2.1.Micro"
  instance_count   = var.sg_amd_count
  ssh_public_key   = var.ssh_public_key
}

module "to_arm" {
  source    = "./modules/oci-worker-pool"
  providers = { oci = oci.toronto }

  compartment_ocid = var.to_compartment_ocid
  subnet_id        = oci_core_subnet.toronto.id
  name_prefix      = "rtracker-to-arm"
  shape            = "VM.Standard.A1.Flex"
  instance_count   = var.to_arm_count
  ocpus            = 1
  memory_gbs       = 6
  ssh_public_key   = var.ssh_public_key
}

module "to_amd" {
  source    = "./modules/oci-worker-pool"
  providers = { oci = oci.toronto }

  compartment_ocid = var.to_compartment_ocid
  subnet_id        = oci_core_subnet.toronto.id
  name_prefix      = "rtracker-to-amd"
  shape            = "VM.Standard.E2.1.Micro"
  instance_count   = var.to_amd_count
  ssh_public_key   = var.ssh_public_key
}
