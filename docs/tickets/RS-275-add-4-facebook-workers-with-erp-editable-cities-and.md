---
id: RS-275
title: Add 4 Facebook workers with ERP-editable cities and pool-assigned logins
type: story
status: in-progress
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-new-workers
pr:
version:
related: [RS-254, RS-261, RS-263, RS-268]
---

## Ask

> Pls check how many ISP proxy you have in your configuration.
>
> It should be 10. Pls increase the worker to 10.
>
> I download these before.
>
> You should no change the existing worker.
> only create new workers.

> 1. I hope the city can be edit on the ERP UI page.
> 2. The same as Facebook account. I can assign a account by using the account in the account pool/

> maybwe we can inject in the VNC control.

> but pls evaluate based on your knowledge

(The pasted list of the ten Decodo ports is left out: it carries the live
password. It matches the gitignored `trackers/facebook/configs/proxies.decodo.txt`.)

## Context

The Decodo plan has ten dedicated ISP ports (10001–10010), one sticky
residential IP each. The homelab VM ran six workers on 10001–10006, one per
`master.toml` region, so four exits sat unused — all East-coast (Brooklyn,
Folcroft PA, two in Leesburg VA).

Every region already had a worker, so a new worker could only share an
existing worker's cities or need its own. The user wants cities set from the
ERP rather than in a generated TOML. Until now that was out of reach by
design: `rs_console/settings.py` kept cities out of the overlay, and the
overlay was fleet-wide. `/v1/fleet` also took a regional worker's cities from
`master.toml` instead of the config the container actually runs.

The account pool's "Fleet worker" picker (RS-268) only labelled a row; the
login reached a worker by retyping it in Edit credentials (RS-254) and
pressing Re-login.

On "inject in the VNC control": a fresh password + 2FA login in the worker's
own browser, through its own proxy, gives the account a session born on the
IP it will keep. Replaying a pool cookie captured elsewhere is a location
change on an existing login — the pattern that got accounts revoked on the
shared house IP in 2026-08. So the pool pushes the login into the worker's
vault and queues Re-login; Watch (noVNC) stays the place a human finishes a
checkpoint.

## Acceptance criteria

- [ ] Four new worker containers on the VM use Decodo ports 10007–10010, each
      with its own id, token, session dir, cache volume and VNC target; the six
      existing containers are not recreated.
- [ ] The new workers appear on the Fleet tab and can be watched.
- [ ] A new worker starts on the catalog city at its exit and searches
      nothing until it has a login, so its cities can be set before an
      account is given to it.
- [ ] The worker page has an Edit cities form: cities are picked from the
      127-city catalog, grouped by region, or added by Marketplace slug or
      numeric id with a name and radius. Cities show as chips, and a city
      another worker already searches is marked. Save writes that worker's
      config only, and the worker picks it up between jobs.
- [ ] `/v1/fleet` shows each worker's cities from its own config.
- [ ] Picking a fleet worker for a pool account and saving pushes the login
      (user, password, 2FA key, e-mail and e-mail password) into that worker's
      vault account with password login allowed, then queues Re-login.
      Secrets never reach the browser, and an `assigned` event is logged.
- [ ] Setting the worker back to None does not touch the worker's vault.

## Out of scope

- Changing the six existing workers' cities, proxies or containers. The new
  form lets the user do that later.
- Cookie injection, and typing credentials over VNC.
- The stale `fleet.toml` worker ids (`se-1`, `wc-1` against the live
  `west-1`) and the wrong ports in the compose header comments.
- A warm-up schedule for fresh accounts.
- A paused, no-search mode. The vendored monitor refuses a config with no
  cities (`Config.validate_items`) and only opens the browser for a scheduled
  search, so an empty list would never log in.

## Notes

- Cities are not limited to the 127 in `master.toml`. All 127 are already
  searched by the six workers, and regional workers send alerts straight to
  Telegram, so a shared city means every alert twice. A new worker needs
  cities nobody else has. A wrong slug fails silently (Facebook falls back to
  the account's own location), so the form links each city to its Marketplace
  page to check by eye.

- New worker ids are named after their exit, since the proxy is fixed and the
  cities are not: `nyc-1` (10007), `phl-1` (10008), `va-1` (10009), `va-2`
  (10010).
