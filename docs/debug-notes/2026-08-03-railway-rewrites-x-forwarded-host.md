# Railway rewrites `X-Forwarded-Host`, and a one-entry allowlist hides it

Two traps that cost a full production deploy cycle while making the MCP server
connectable from Claude and ChatGPT. Either one alone is survivable; together
they produce a fix that passes every check you think to run and still doesn't
work in prod.

## Trap 1 — the standard `X-Forwarded-*` headers do not survive Railway

`deploy/cloudflare/worker.js` reverse-proxies `/api`, `/oauth` and
`/.well-known` to Railway. Because `new Request(target, request)` rewrites
`Host` to the Railway origin, the backend can't tell which of our custom
domains the caller actually used — so `resolvePublicOrigin`
(`apps/backend/src/oauth/metadata.ts`) reads a forwarded header instead.

The obvious implementation is wrong:

```js
proxied.headers.set('X-Forwarded-Host', url.host);   // never arrives
```

**Railway's edge rewrites the standard `X-Forwarded-*` headers to its own
hostname before the backend sees them.** The Worker's value is silently
replaced. `resolvePublicOrigin` then finds nothing allowlisted and falls back
to `allow[0]` — the exact behaviour the change was meant to fix.

Use a private header, which passes through untouched:

```js
proxied.headers.set('X-Public-Host', url.host);
proxied.headers.set('X-Public-Proto', url.protocol.replace(':', ''));
```

and prefer it in `resolvePublicOrigin`. The allowlist check still applies, so a
forged value is still refused — the header is a *hint about which allowlisted
origin*, never a trusted origin in itself.

## Trap 2 — a single-entry allowlist can't tell "resolved" from "fell back"

This is why the broken version passed verification. The fallback is:

```ts
if (candidate && allow.includes(candidate)) return candidate;
…
return allow[0];
```

`inventory-dev` has **one** entry in `CORS_ALLOWED_ORIGINS`, so `allow[0]` *is*
the correct host. Probing dev returned `issuer: https://inventory-dev…` whether
or not the forwarded header arrived. The probe looked green and proved nothing.

Prod has **two** entries (`inventory-prod…` first, `inventory…` second), so it
is the only environment where the bug is observable at all.

**When verifying host resolution, the assertion must distinguish the resolved
path from the fallback path.** Either test against a multi-entry allowlist, or
assert that a *non-first* allowlist entry can be selected. `tests/oauth-endpoints.test.ts`
now does both, and injects `X-Forwarded-Host: backend-production-…up.railway.app`
alongside a correct `X-Public-Host` to reproduce the rewrite directly.

A good end-to-end check is cross-talk: each custom domain must report **itself**.

```sh
curl -s https://inventory.recycleservers.com/.well-known/oauth-protected-resource/api/mcp | jq .resource
# → https://inventory.recycleservers.com/api/mcp
curl -s https://inventory-prod.recycleservers.com/.well-known/oauth-protected-resource/api/mcp | jq .resource
# → https://inventory-prod.recycleservers.com/api/mcp
```

If both return the same host, resolution is falling back and only *looks*
right on whichever domain happens to sort first.

## Why it matters beyond cosmetics

MCP clients validate that the `resource` in the RFC 9728 document matches the
server URL they were pointed at. A mismatched host isn't a cosmetic wrong label
— it breaks the connector before the OAuth flow even begins.

## Deploy shape (the other reason this took two cycles)

The two halves ship through **different pipelines**:

- `deploy/cloudflare/worker.js` → GitHub Actions (`deploy-frontend.yml`), ~50s.
- `apps/backend/**` → Railway's own GitHub integration, several minutes, **not**
  visible in `gh run list`.

So a green Actions run does not mean the backend half is live. Confirm with the
commit the backend reports before concluding a fix didn't work:

```sh
curl -s https://inventory.recycleservers.com/api/health
# {"status":"ok","version":"1.46.1","commit":"4afe8d1…"}
```
