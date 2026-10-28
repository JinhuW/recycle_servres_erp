---
id: RS-443
title: Move proxy management from Account pool to the Proxies tab
type: story
status: done
priority: P2
created: 2026-10-28
reporter: jinhu
branch: JinhuW/langouste
pr:
version: 1.376.0
related: []
---

## Ask

> remove this as well, since already have a dedicated tab for it

(Sent with a screenshot of the Proxies card under the Account pool table:
Label, Exit, Timezone, Used by, Note, with Add proxy and per-row edit and
delete.)

Asked whether to move the edit actions or just remove the card, since the
Proxies tab only showed health, the answer was **Move edits to tab**: remove
the card, put Add proxy and per-row edit/delete on the Proxies tab's ERP rows;
homelab rows stay read-only.

## Context

The card (`ProxiesCard` in `fleet/FleetProxies.tsx`, rendered by
`FacebookAccountPool.tsx`) was the only place to add, edit or remove an ERP
proxy. The Proxies tab (`/#/fleet/proxies`, `FleetProxiesTab.tsx`, v1.368.0)
lists the same proxies with their health, plus the homelab's ports, but its
empty text and header comment sent the reader back to "Account pool ▸
Proxies" to edit.

## Acceptance criteria

- [x] Account pool no longer shows the Proxies card; Add to fleet still lists proxies.
- [x] Proxies tab has an **Add proxy** button beside Check all (not on a mirror).
- [x] Each ERP row has Edit and Remove next to its check button, opening the
      same `ProxyDialog` / remove dialog; homelab rows get neither.
- [x] ERP rows' Used by shows "n of max accounts" (warn at the limit), as the card did.
- [x] After a save or remove the tab reloads.
- [x] The empty text points at the Add proxy button, not Account pool.

## Out of scope

Timezone and note columns on the tab (both stay visible in the edit dialog);
any backend change.

## Notes

The card's `.fleet-proxies` rules (16px top margin, card-head padding) also
matched the tab's table, which carries that class; they went with the card.
On an ERP row the load line replaces "Nobody", since "0 of 2 accounts" says it.
