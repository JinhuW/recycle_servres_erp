---
id: RS-582
title: Chat bridge extensions enroll themselves and wait for approval
type: feature
status: done
priority: P2
created: 2026-11-12
reporter: jinhu
branch: feat/fb-chat-device-enroll
pr: 1193
version: 1.455.0
related: [RS-578, RS-579]
---

## Ask

> Stop configuration the client id and secret in the extension. For all
> extension it will auto connect to my system, i will apporve based on need.

## Context

Each Chrome profile running the Marketplace ⇄ Telegram bridge needed an ERP
address, a client ID and a client secret typed into its options page, and the
`fbchat:write` client had to be made by hand under Settings ▸ Connectors. On
dev the nightly copy from prod revokes every OAuth client
(`deploy/railway-sync/scrub.sql`), so this was redone every morning.

Decisions taken with the owner on 2026-11-12:

- The ERP address is built into the extension: a dev build talks to
  inventory-dev, a prod build to inventory.
- Approvals survive the nightly dev reset.
- The extension and the ERP both show a pairing code, so the owner can tell
  their own extension from a stranger's request on the open enroll route.

## Acceptance criteria

- [x] `POST /api/fb-chat/enroll` (no auth) returns a device id, a token and a
      pairing code, and records a pending device.
- [x] A pending device's bearer is refused on `/push/*` with `device_pending`;
      `/push/device` tells it its status.
- [x] Settings ▸ Chat bridge lists waiting requests with their code, name,
      Facebook user, version and IP; Approve lets the device push, Reject and
      Revoke stop it with `device_rejected`.
- [x] An `fbchat:write` service-client token still works on `/push/*`.
- [x] Enrollment is limited per IP and in the number of waiting requests.
- [x] Approved devices survive the nightly prod → dev sync.

## Out of scope

Signing extensions or binding a device to a Facebook account. The owner's
approval is the only gate.

## Notes

Devices are their own table (`fb_chat_devices`), not OAuth clients: the dev
scrub revokes all OAuth clients, and an approval is not a client. The bearer
is `fbd_<id>_<token>`; only the token's sha256 is stored, as with fleet host
tokens.
