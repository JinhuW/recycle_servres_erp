---
id: RS-332
title: Pilot two Facebook workers per proxy on two Palo Alto IPs
type: story
status: in-progress
priority: P2
created: 2026-10-20
reporter: jinhu
branch: fb-shared-proxy-pilot
pr:
version:
related: [RS-331, RS-275]
---

## Ask

> This remind me how we need to manage the worker. Maybe we can create two wokers based on proxy instead of One by one match.
> AT some point we can use three worker map one proxy.

> One proxy could consider a location.

> Pls group them by the proxy

Asked what "group them by the proxy" should do, the requester picked
"Workers share a proxy". Then:

> I menat it may make snese, one ip have 2-3 facebooks account is that right?

## Context

Every worker has had its own Decodo IP since accounts died on the shared house
IP in 2026-08 (tracker changelog 0.5.4 and the 0.6.x second-account entry;
`deploy/README.md` → *Scaling notes*: "One account per IP"). A few accounts
on one residential IP is ordinary, since a household shares a router. What
links them is looking like one operator. The fleet already gives each account
its own device profile (user agent, screen, `datr`; README → *Device
identity*). Two gaps remained:

- **Same clock.** A device's timezone comes from its vault account's
  `region`. No vault account has one, so every device reports New York time,
  which is wrong for a Palo Alto exit.
- **Same minute.** `start_at` is fleet-wide. `rs_console/settings.py`
  `render` writes a saved one into every config, so two accounts on one IP
  would start their daily sweep in the same minute.

Nothing in the code limits a proxy to one worker. A config naming another
worker's `PROXY_*` var is all it takes.

## Acceptance criteria

- [ ] ca-1b runs on port 10014 beside ca-1, and ca-2b on 10015 beside ca-2.
      In `/v1/fleet`, each one's exit IP equals its partner's.
- [ ] A worker can have its own sweep times
      (`python -m rs_console.settings start-at <worker> HH:MM`). They survive
      a deploy and a fleet-wide settings save. ca-1b and ca-2b sweep at 17:00
      UTC; their partners keep 13:00 UTC.
- [ ] `/v1/fleet` gives each worker its own `start_at`, and its plan counts
      those times.
- [ ] The six Palo Alto vault slots carry region `rs_west`, so a device
      generated for them reports `America/Los_Angeles`.
- [ ] The ERP Fleet tab marks workers that share an IP and draws each
      worker's day from its own sweep times.
- [ ] No existing worker container is recreated by the deploy.

## Out of scope

- Pairs beyond 10014/10015, and a third worker per IP. Those follow the
  pilot's result.
- Editing a worker's sweep times from the ERP. The CLI is enough for the
  pilot.
- Moving the workers under `rs-fleetd`.

## Notes

Pilot rules:

1. Give the first accounts to ca-1 and ca-2 (and ca-3, ca-4). Give ca-1b and
   ca-2b theirs 24 hours or more later, so no IP sees two first logins in
   one day.
2. Partners never share cities. Edit cities already marks a city another
   worker searches.
3. If either account of a pair is checkpointed or locked, stop its partner
   and do not widen.
4. Widen (more pairs, then a third worker per IP) only after 14 days with all
   six accounts live, and only if the pairs have had no more checkpoints than
   ca-3 and ca-4, the single-account control on the same location.

Found while building it:

- The region reaches a device only on the generated path
  (`routers/identity.py` → `generate_profile`). An account assigned
  cookie-first, whose live cookie is sealed as the worker's session, gets a
  profile seeded from what its browser observed. That uses the browser's own
  timezone, or UTC when it reports none. Check `rsc identity list` after each
  Palo Alto account's first login. A UTC or Eastern device on a Palo Alto IP
  is a mismatch, and the next fix belongs in `seeded_profile`.
