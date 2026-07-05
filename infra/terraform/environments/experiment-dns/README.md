# experiment-dns

DNS records mapping clean custom domains to the experimental Railway backends:

| Record | → | Notes |
|--------|---|-------|
| `api.prod.recycleservers.com` CNAME | `mq67e4st.up.railway.app` | prod backend, DNS-only |
| `api.dev.recycleservers.com` CNAME  | `7mnrcs5t.up.railway.app` | dev backend, DNS-only |
| `_railway-verify.api.prod` TXT | railway ownership token | cert validation |
| `_railway-verify.api.dev` TXT  | railway ownership token | cert validation |

**DNS-only (not proxied)** because these are two-level subdomains that
Cloudflare Universal SSL doesn't cover; Railway issues the cert directly.

The backends remain gated by `PROXY_SECRET`, so these hostnames are not a
bypass of the Cloudflare Worker — direct hits without the Worker's header still
return 403.

## Apply

Needs the account-scoped `CLOUDFLARE_API_TOKEN` (DNS edit on the zone) plus the
R2 state-bucket creds as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (same as
a prod `terraform init`):

```bash
cd infra/terraform/environments/experiment-dns
terraform init
terraform apply
```

After apply, Railway validates ownership (TXT) + routing (CNAME) and issues the
cert — check with `railway domain status api.prod.recycleservers.com`.

If the CNAME targets here ever change (re-created Railway domains issue new
`*.up.railway.app` targets), update `content` in `main.tf` and re-apply.
