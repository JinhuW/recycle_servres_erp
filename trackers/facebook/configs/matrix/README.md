# Matrix router stack — setup

This directory holds the runtime config for the Messenger router: **Conduit** (a
private Matrix homeserver), **mautrix-meta** (the Messenger↔Matrix bridge), and
the **rs-router** worker that ties them to the coordinator. See the top-level
`README.md` section "Messenger router" for how the pieces fit and why.

Everything here that carries a token or the Facebook session is gitignored
(`config.yaml`, `registration.yaml`, `*.db`). Only this README and
`mautrix-meta.config.example.yaml` are committed.

Run it all on the **homelab VM** — same residential WAN IP the seller account
normally logs in from. Never a VPS.

## One-time bring-up (in order)

### 1. Conduit

```bash
docker compose -f deploy/docker-compose.matrix.yml up -d conduit
```

`server_name` is `rs.local` (set in the compose env). It is private and
non-federating; the name only has to be stable, never resolvable on the
internet.

### 2. The router bot user + its access token

Register one Matrix user for rs-router and grab its access token (Conduit ships
registration off, so mint it with an admin/registration token or the Conduit
console), then put the token in `configs/secrets.env`:

```
MATRIX_ROUTER_TOKEN=syt_...
MATRIX_HOMESERVER_URL=http://conduit:6167
```

Verify from the router image before wiring anything else:

```bash
docker compose -f deploy/docker-compose.matrix.yml run --rm rs-router rs-router status
# prints the homeserver, the coordinator, and whoami (the bot's mxid)
```

### 3. mautrix-meta

Generate its config + appservice registration, then edit the load-bearing keys
below. Start from the upstream default (`docker run ... mautrix/meta -g`) and
change only these — full defaults are in `mautrix-meta.config.example.yaml`:

- **homeserver** → Conduit:
  ```yaml
  homeserver:
      address: http://conduit:6167
      domain: rs.local
  ```
- **appservice** address the bridge listens on, reachable from Conduit by
  service name (`http://mautrix-meta:29319`). Copy the generated
  `registration.yaml` to `configs/matrix/conduit/` so Conduit loads it, and
  point Conduit at it.
- **bridge the Messenger/Marketplace side only.** The July 2026 split means this
  image is Messenger-only already; keep `network: messenger` (or `facebook`),
  not Instagram.
- **permissions** — make the router bot an admin so it can read every portal:
  ```yaml
  bridge:
      permissions:
          "rs.local": user
          "@rs-router:rs.local": admin
  ```
- **auto-invite the router bot to every portal** so it sees new conversations
  without being invited by hand (the bridge's `invite`/`autocreate` options),
  and enable **double-puppeting** so replies the router sends appear as the
  seller account, not a bot.

```bash
docker compose -f deploy/docker-compose.matrix.yml up -d mautrix-meta
```

Then DM the bridge bot from an admin Matrix account and log the **Facebook
seller account** in — the standard flow is a privacy-window `messenger.com`
login, copy the cookies to the bridge, then **close the window without logging
out** (logging out invalidates the session). Do not reuse the Playwright
`fb_state.json` jar; the bridge keeps its own session.

Confirm a real buyer DM shows up as a Matrix room before going further.

### 4. rs-router

Dry-run first — it reads, maps rooms, and prints; it sends nothing:

```bash
docker compose -f deploy/docker-compose.matrix.yml run --rm rs-router rs-router poll --dry-run
```

When that lists your portals and any new buyer messages, start the loop:

```bash
docker compose -f deploy/docker-compose.matrix.yml up -d rs-router
```

## Coordinator side (already deployed separately)

The coordinator needs the war-room chat configured so it opens one topic per
buyer and reads staff replies:

```
TELEGRAM_WARROOM_CHAT_ID=-100...   # a SEPARATE Topics-enabled supergroup
```

It reuses `TELEGRAM_TOKEN`. Restart rs-coordinator after setting it (a green
`scripts/deploy.sh` ships the monitor only — the coordinator is its own
`docker compose up -d`).

## Health checks

- `rs-router status` — homeserver reachable, whoami resolves, coordinator set.
- `rs-router poll --dry-run` — the room→thread map and any pending buyer messages.
- Coordinator `/healthz` `alert_backlog` — if it climbs, Telegram sends or topic
  creation are failing (check the war-room bot is an admin with "Manage topics").
