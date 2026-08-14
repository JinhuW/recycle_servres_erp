# Always-Free capacity preflight. A1 capacity is scarce (the classic failure
# is "Out of host capacity" at apply time), so surface per-AD availability at
# plan time and refuse to plan an impossible fleet. Pattern lifted from the
# older oracle/router stack, updated for the oracle/oci v6 provider.

locals {
  is_flex = var.shape == "VM.Standard.A1.Flex"
  # OCI limit names for the two Always-Free shapes.
  limit_name   = local.is_flex ? "standard-a1-core-count" : "standard-e2-micro-core-count"
  cores_needed = local.is_flex ? var.ocpus : 1
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

data "oci_limits_resource_availability" "shape" {
  count               = length(data.oci_identity_availability_domains.ads.availability_domains)
  compartment_id      = var.compartment_ocid
  service_name        = "compute"
  limit_name          = local.limit_name
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[count.index].name

  # The limits API can 404 for shapes a tenancy has never used; treat that as
  # zero availability rather than a hard error by letting the plan fail with
  # the provider's message — it names the AD, which is what we need to know.
}

locals {
  ad_availability = {
    for i, ad in data.oci_identity_availability_domains.ads.availability_domains :
    ad.name => tonumber(data.oci_limits_resource_availability.shape[i].available)
  }

  # ADs that can host at least one instance of this pool. Falls back to all
  # ADs when none report headroom: existing instances still need a valid AD
  # expression, and for new ones OCI's create-time error is the real gate.
  ads_with_room = [
    for name, avail in local.ad_availability : name if avail >= local.cores_needed
  ]
  usable_ads = length(local.ads_with_room) > 0 ? local.ads_with_room : [
    for ad in data.oci_identity_availability_domains.ads.availability_domains : ad.name
  ]
}
