# Debug note: Railway production builds hang in BUILDING (2026-07-12)

## Symptom

Merging to the `prod` branch triggered a production backend deployment that
sat in `BUILDING` indefinitely (25+ min). All 12 Docker steps complete from
cache in ~1 s (visible in build logs), then the log stream goes silent —
the hang is in the post-build image export/publish phase on Railway's side
(`Metal builder production-builderv3-us-east4-2pbg`). No deploy logs are
ever produced. The dev environment built the same Dockerfile in ~1 min the
same day, and status.railway.com reported no incident.

## What was tried

1. Waited 25 min on the auto-triggered build — never left `BUILDING`.
2. Canceled + re-triggered via GraphQL (`deploymentCancel`,
   `serviceInstanceDeployV2`) — second and third attempts hung identically.

Useful commands (CLI token from `~/.railway/config.json → user.token`):

```bash
# status of a deployment
curl -s https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"query { deployment(id: \"<id>\") { status statusUpdatedAt } }"}'

# cancel a stuck one / trigger a fresh one from the connected repo
#   mutation { deploymentCancel(id: "<id>") }
#   mutation { serviceInstanceDeployV2(serviceId: "<sid>", environmentId: "<eid>") }
```

## Traps for the next person (or LLM)

- **Merging to `main` deploys NOTHING.** The Railway production env tracks
  the **`prod` branch**, dev tracks `dev` (see
  `docs/deployment-railway-dev-prod.md`). Release flow: PR dev→main, then
  PR main→prod (both branches are protected — direct pushes are rejected).
- **A stuck new deployment does not take prod down** — the previous
  deployment keeps serving (`/api/health` stayed 200 throughout).
- **Don't debug the Dockerfile for this signature.** If every build step is
  cached and completes within seconds and then nothing follows, the code is
  fine; it's the builder. Retry, and if retries hang too, wait it out or
  contact Railway support — there is no user-side fix.
- The environment name is `production`, not `prod`, in Railway API calls.
