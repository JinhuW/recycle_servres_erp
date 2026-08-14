# Ubuntu (not Oracle Linux): first-class cloud-init, single-step docker
# install, none of Oracle Linux's firewalld surprises. The shape filter makes
# OCI return the right architecture (aarch64 for A1, x86_64 for the micro).
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

data "cloudinit_config" "worker" {
  gzip          = true
  base64_encode = true

  part {
    content_type = "text/cloud-config"
    content      = file("${path.module}/templates/cloud-init.yaml")
  }
}

resource "oci_core_instance" "worker" {
  count = var.instance_count

  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-${count.index}"

  # Spread over ADs with capacity (single-AD regions still get fault-domain
  # spread below, so one bad host never takes the whole pool).
  availability_domain = local.usable_ads[count.index % max(length(local.usable_ads), 1)]
  # Pin fault domains only for flex shapes. Micro capacity is scarce enough
  # that pinning triggers "Out of host capacity" when one domain is full —
  # let OCI place those wherever there is room.
  fault_domain = local.is_flex ? "FAULT-DOMAIN-${(count.index % 3) + 1}" : null

  shape = var.shape
  dynamic "shape_config" {
    for_each = local.is_flex ? [1] : []
    content {
      ocpus         = var.ocpus
      memory_in_gbs = var.memory_gbs
    }
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }

  create_vnic_details {
    subnet_id        = var.subnet_id
    assign_public_ip = true
    hostname_label   = "${replace(var.name_prefix, "rtracker-", "")}${count.index}"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = data.cloudinit_config.worker.rendered
  }

  # NOTE: no quota precondition here on purpose. Availability drops to zero
  # once a pool fills its own quota, so a precondition on it would fail the
  # pool's EXISTING instances forever. The shape_availability output stays as
  # an advisory; OCI's own "Out of host capacity" error gates creation.
  lifecycle {
    # Cloud-init only installs docker; app updates ship via
    # scripts/deploy-workers.sh over SSH. Never let a template tweak or image
    # refresh replace a running VM — freed A1 capacity may be unrecoverable.
    # fault_domain is create-time-only: changing it REPLACES the instance,
    # which is how one micro got needlessly destroyed on 2026-08-14.
    ignore_changes = [metadata, source_details, fault_domain, availability_domain]
  }
}
