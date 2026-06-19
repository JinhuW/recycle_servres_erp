# DNS records pointing the experimental Railway backends at clean custom
# domains (api.prod / api.dev.recycleservers.com). DNS-only (proxied=false):
# these are two-level subdomains that Cloudflare Universal SSL (covers only
# *.recycleservers.com) does NOT cover, so Railway issues and serves the TLS
# cert for the exact hostname. The backends stay gated by PROXY_SECRET, so the
# domains are just cleaner hostnames — not a bypass of the Worker.
#
# Isolated state (own backend key), separate from environments/prod so this
# never touches the production module/state.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment (account-scoped token with
  # DNS edit on the recycleservers.com zone — the same token used for
  # environments/prod, kept in your shell).
}

variable "cloudflare_zone_id" {
  type    = string
  default = "dd2a6dc1b973dc1f98b1cb009edae6d1" # recycleservers.com
}

# ── prod backend ─────────────────────────────────────────────────────────────
resource "cloudflare_dns_record" "api_prod" {
  zone_id = var.cloudflare_zone_id
  name    = "api.prod.recycleservers.com"
  type    = "CNAME"
  content = "mq67e4st.up.railway.app"
  ttl     = 1 # automatic
  proxied = false
  comment = "Experimental Railway prod backend (gated by PROXY_SECRET)"
}

resource "cloudflare_dns_record" "api_prod_verify" {
  zone_id = var.cloudflare_zone_id
  name    = "_railway-verify.api.prod.recycleservers.com"
  type    = "TXT"
  content = "railway-verify=2d3356495c8410f626a47d57c8b8f3f68cab2ef1a9b855babb7a6dfed9c4fd42" # pragma: allowlist secret
  ttl     = 1
}

# ── dev backend ──────────────────────────────────────────────────────────────
resource "cloudflare_dns_record" "api_dev" {
  zone_id = var.cloudflare_zone_id
  name    = "api.dev.recycleservers.com"
  type    = "CNAME"
  content = "7mnrcs5t.up.railway.app"
  ttl     = 1 # automatic
  proxied = false
  comment = "Experimental Railway dev backend (gated by PROXY_SECRET)"
}

resource "cloudflare_dns_record" "api_dev_verify" {
  zone_id = var.cloudflare_zone_id
  name    = "_railway-verify.api.dev.recycleservers.com"
  type    = "TXT"
  content = "railway-verify=01167d361b8471fa85db0282e3a741b443b79c0c65223359d07915b25a9e8114" # pragma: allowlist secret
  ttl     = 1
}
