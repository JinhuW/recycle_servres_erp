---
id: RS-178
title: SSD capacity offers 2TB and RAM class offers CAMM
type: story
status: in-progress
priority: P2
created: 2026-10-05
reporter: Jinhu
branch: feat/ssd-2tb-ram-camm
pr:
version:
related: []
---

## Ask

> Add 2T options.
>
> RAM, add CAMM ram type.
>
> Push to prod

(Attached screenshot: the SSD **Capacity** select on the PO line form, which
runs 120GB … 1.92TB, 3.2TB … 30.72TB.)

## Context

Both dropdowns are rows in `catalog_options`, served by `GET /api/lookups`.
There is no catalog editor in the app, so a new option is a migration, as it
was for 0071–0073 and 0078.

- "2T" is the SSD capacity list (`SSD_CAP`), which skipped from 1.92TB to
  3.2TB. HDD capacity already offers 2TB.
- "CAMM ram type" lands in `RAM_CLASS`, the form-factor list
  (UDIMM/RDIMM/LRDIMM/SODIMM), which the forms label **Class**. The field
  labelled **Type** is the fixed Desktop/Server/Laptop device list, and CAMM
  is a module form factor, not a device.

## Acceptance criteria

- [ ] The SSD Capacity select on every line form offers 2TB, between 1.92TB
      and 3.2TB.
- [ ] The RAM Class select offers CAMM, after SODIMM.
- [ ] The label scanner may read a module as CAMM, and types it Laptop.
- [ ] Both are live on prod.

## Out of scope

- Deriving a device type from CAMM when the scanner leaves it blank, and in
  web-submission intake: both stay unset and the user picks it.

## Notes

The prod release also carried v1.209.2 (RS-173), which was on dev and not yet
on prod.
