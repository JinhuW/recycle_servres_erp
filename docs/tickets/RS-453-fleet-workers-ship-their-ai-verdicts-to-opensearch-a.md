---
id: RS-453
title: Fleet workers ship their AI verdicts to OpenSearch again
type: bug
status: done
priority: P2
created: 2026-10-29
reporter: jinhu
branch: JinhuW/rainbowfish
pr: 991
version: 1.379.2
related: [RS-394]
---

## Ask

> How can i check the AI rating logs?

> I meant the Facebook fleets, i can not see any log of it.

> yes, file the ticket and make the change

## Context

The monitor writes one `ai_eval` event per listing the model rates (score,
conclusion, comment, model, units, what the model was shown) and ships it to
OpenSearch when `AIMM_OPENSEARCH_URL` is set (`opensearch_log.py` in the
vendored monitor). The compose workers got that variable from
`trackers/facebook/deploy/fleet-worker.env`.

Workers are now started by the ERP's fleet agent (`apps/fleet-agent`), whose
`docker run` passes only the `RS_FLEET_*` variables and `RS_VNC_PORT`. So
since the cutover nothing ships: the `fb-tracker-*` index on the homelab
OpenSearch (`10.10.10.73:9200`) has no event after 2026-10-27 15:41 UTC, and
no `ai_eval` at all. The verdicts survive only in each container's rotating
text log, about three hours deep. `worker-status.sh alerts` reads the
`rs-monitor` container, which no longer exists.

Measured on 2026-10-29: the homelab workers cannot resolve
`host.docker.internal` (the agent adds no `--add-host`), and `10.10.60.14`
runs no OpenSearch, but reaches the homelab's on `10.10.10.73:9200`. So the
address has to be one each host's agent is told, not a fixed default.

## Acceptance criteria

- [x] With `FLEET_OPENSEARCH_URL` set on the agent, every worker it starts gets
      `AIMM_OPENSEARCH_URL` with that value and `AIMM_OPENSEARCH_INDEX=fb-tracker`
      (`FLEET_OPENSEARCH_INDEX` overrides the index).
- [x] Unset, the `docker run` line is exactly what it is today.
- [x] The agent logs the OpenSearch target (or its absence) at start.
- [x] The agent README documents both settings and the run line.

## Out of scope

- Restarting or recreating workers to pick it up. Each start is a Facebook
  login; workers pick it up as the agent starts them for its own reasons.
- Delivering the address through the claim's `env` (`FLEET_WORKER_ENV`): the
  worker only accepts names its config template reads, so that path needs a
  facebook-tracker release as well.
- Fixing `worker-status.sh` for the agent's container names.

## Notes

Rolling it out means re-running each host's `fleet-agent` container with the
new image and `-e FLEET_OPENSEARCH_URL=http://10.10.10.73:9200`. Recreating
the agent is not a login: running workers are adopted by label.

Rolled out 2026-10-29: `fleet-agent:1.379.2` on both hosts with
`FLEET_OPENSEARCH_URL=http://10.10.10.73:9200` in `~/.config/fleet-agent.env`.
The events field is `kind` (`kind: ai_eval`), not `event`.

The 13 workers already running were started without the variable, so
`trackers/facebook/scripts/ai-verdict-bridge.py` rebuilds their verdicts from
the text log (listing from the `Listing(` block or the prompt line, model and
time from the response) every 5 minutes from cron on both hosts
(`~/fleet-ai-bridge/`), marked `bridged: true`. It skips any worker that has
the variable, so remove the cron lines once none is left without it.
