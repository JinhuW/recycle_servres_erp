---
id: RS-210
title: RAM and SSD spec selects cascade, so a line's options can't conflict
type: story
status: done
priority: P2
created: 2026-10-09
reporter: jinhu
branch: feat/ram-ssd-spec-cascade
pr: 567
version: 1.233.0
related: [RS-208, RS-178]
---

## Ask

> why my Cascade Query in the PO form does not works?

> I meant when i select desktop, it should be UDIMM.

> i believe we implement thsi feayure

> ok. So ultrathink Build an Cascade Query for the ram. SSD PO form. To make sure all options won't conflict.

First asked on 2026-10-08, in the session that shipped RS-208:

> I see. maybe good to map certai type of ram with the device. like UIDMM=Desktop, SODIMM=Laptop, etc.

> maybe also worth to create the rank - device type as well. cuz certain rank only available in the server.

> ultrathink Cascade Query for the form select for all PO type.

## Context

The cascade was designed on 2026-10-08 as the second half of the RS-208
plan. Only the select-all fix shipped, so nothing linked the spec selects:
a RAM line's Type (Desktop / Server / Laptop) and Class (UDIMM / RDIMM /
…) were two independent dropdowns. Only the label scanner's normaliser
derived one from the other.

Prod (read-only, 2026-10-09) holds about 60 RAM lines whose specs
contradict each other:

- UDIMM + Laptop: 2 lines.
- SODIMM + Server: 3 lines.
- x4 or quad ranks on UDIMM/SODIMM: 57 lines.

There are also 14 UDIMM + Server lines. These are real ECC UDIMMs, so
UDIMM stays switchable to Server. Prod's SSD lines hold no conflict.

The Type ↔ Class pair is a peer pair: whichever was picked last wins and
fixes the other. Filtering both lists by each other would deadlock: on a
SODIMM + Laptop line, no RDIMM could be reached without first blanking a
field.

## Acceptance criteria

- [x] In every PO line form (new PO, PO edit, Review mode, phone) and the
      inventory editor, picking Type fills or clears Class:
  - Desktop → UDIMM.
  - Laptop → SODIMM, unless DDR5 makes CAMM possible too.
  - Server clears a non-server Class.
- [x] Picking Class fills or fixes Type:
  - RDIMM / LRDIMM → Server.
  - SODIMM / CAMM → Laptop.
  - UDIMM → Desktop, which can still be switched to Server.
- [x] Server-only ranks are offered only with server memory: x4, quad and
      octal ranks, DR, and 3DS.
- [x] CAMM is offered only with DDR5.
- [x] An SSD's form-factor list follows its interface. SAS offers only 2.5",
      and it is filled in.
- [x] A label scan and a RAM sheet scan land on a consistent line. The Class
      read off the label wins.
- [x] The backend refuses these conflicts, but only for a rule whose own
      fields the save changes. A legacy conflicting line still saves on an
      unrelated edit.

## Out of scope

- HDD interface → RPM: the ask names RAM and SSD.
- RAM speed presets by generation. Speed is a typed field, and prod
  speeds mix MT/s with PC3 bandwidth codes (12800), so a preset list would
  only ever suggest.
- Backfilling the conflicting prod lines. Existing data is left alone.

## Notes

- Plan: `~/.claude/plans/encapsulated-soaring-metcalfe.md`. Earlier design:
  `tranquil-twirling-metcalfe.md`, "PR 2".
- The rules live in one module, `packages/shared/src/specCascade.ts`.
  The forms, the scan merges and the backend validators all use it.
