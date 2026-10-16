# One VCN per region, shared by both worker pools there. Workers are
# outbound-only (Reddit, OpenRouter, Railway Postgres); the only ingress is
# SSH for the deploy script. Free tier allows 2 VCNs per region — Singapore
# has none after the OKE teardown, Toronto has one (Vaultwarden's), so one
# new VCN in each fits.

locals {
  networks = {
    singapore = { cidr = "10.20.0.0/16", subnet = "10.20.1.0/24" }
    toronto   = { cidr = "10.30.0.0/16", subnet = "10.30.1.0/24" }
  }
}

# --- Singapore --------------------------------------------------------------

resource "oci_core_vcn" "singapore" {
  provider       = oci.singapore
  compartment_id = var.sg_compartment_ocid
  display_name   = "reddits-tracker-vcn"
  cidr_blocks    = [local.networks.singapore.cidr]
  dns_label      = "rtracker"
}

resource "oci_core_internet_gateway" "singapore" {
  provider       = oci.singapore
  compartment_id = var.sg_compartment_ocid
  vcn_id         = oci_core_vcn.singapore.id
  display_name   = "reddits-tracker-igw"
}

resource "oci_core_default_route_table" "singapore" {
  provider                   = oci.singapore
  manage_default_resource_id = oci_core_vcn.singapore.default_route_table_id
  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.singapore.id
  }
}

resource "oci_core_default_security_list" "singapore" {
  provider                   = oci.singapore
  manage_default_resource_id = oci_core_vcn.singapore.default_security_list_id

  ingress_security_rules {
    protocol = "6" # TCP
    source   = var.ssh_ingress_cidr
    tcp_options {
      min = 22
      max = 22
    }
  }

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }
}

resource "oci_core_subnet" "singapore" {
  provider       = oci.singapore
  compartment_id = var.sg_compartment_ocid
  vcn_id         = oci_core_vcn.singapore.id
  display_name   = "reddits-tracker-public"
  cidr_block     = local.networks.singapore.subnet
  dns_label      = "workers"
}

# --- Toronto ----------------------------------------------------------------

resource "oci_core_vcn" "toronto" {
  provider       = oci.toronto
  compartment_id = var.to_compartment_ocid
  display_name   = "reddits-tracker-vcn"
  cidr_blocks    = [local.networks.toronto.cidr]
  dns_label      = "rtracker"
}

resource "oci_core_internet_gateway" "toronto" {
  provider       = oci.toronto
  compartment_id = var.to_compartment_ocid
  vcn_id         = oci_core_vcn.toronto.id
  display_name   = "reddits-tracker-igw"
}

resource "oci_core_default_route_table" "toronto" {
  provider                   = oci.toronto
  manage_default_resource_id = oci_core_vcn.toronto.default_route_table_id
  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.toronto.id
  }
}

resource "oci_core_default_security_list" "toronto" {
  provider                   = oci.toronto
  manage_default_resource_id = oci_core_vcn.toronto.default_security_list_id

  ingress_security_rules {
    protocol = "6" # TCP
    source   = var.ssh_ingress_cidr
    tcp_options {
      min = 22
      max = 22
    }
  }

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }
}

resource "oci_core_subnet" "toronto" {
  provider       = oci.toronto
  compartment_id = var.to_compartment_ocid
  vcn_id         = oci_core_vcn.toronto.id
  display_name   = "reddits-tracker-public"
  cidr_block     = local.networks.toronto.subnet
  dns_label      = "workers"
}
