---
id: RS-116
title: Scanned RAM lines auto-save to the PO like confirmed lines, and scans run at the scanner's highest resolution
type: bug
status: done
priority: P1
created: 2026-09-26
reporter: jinhu
branch: feat/ram-sheet-autosave
pr:
version: 1.182.0
related: [RS-109, RS-115]
---

## Ask

> also there is one more issue. The auto scaned item does not auto save to the PO.

> which does not match the orginal workflow

> alwasy use the highest dpi that scanner support.

## Context

On the New-PO page, confirming a line saves it to the draft PO immediately. The first save creates the PO and later ones append, through `persistLines`. Sticks added from Scan RAM sheet only went into page state: nothing reached the PO until Submit, and leaving the page lost them.

Separately, the bridge scanned at a configured 300 dpi instead of asking the scanner for its maximum. For the office MF460 II the answer is the same (its flatbed offers 150/300), but it should hold for any scanner. The dialog also printed a hard-coded "300 dpi".

## Acceptance criteria

- [x] Adding scanned sticks saves every stick that passes the same checks as Confirm (required fields, brand confirmation, DDR5 serials) to the PO straight away. The first save creates the PO; the rest go onto the same one.
- [x] Sticks that can't be saved yet stay on the page unsaved. A message says how many were saved and what the rest still need, serial numbers included.
- [x] Saved lines show as Saved in the table. Deleting a saved line also removes it from the PO.
- [x] Saves are serialised: adding scans quickly, or clicking Submit while an auto-save is running, never creates a second PO or duplicate rows.
- [x] The bridge scans at the scanner's highest flatbed resolution, read from its eSCL capabilities, with a ceiling. The dialog shows the resolution actually used.

## Out of scope

Holding back duplicate part numbers at auto-save. The duplicate check still runs at Submit, as for Confirm.

## Notes

Bridge side: `auto_ram_scanner` 0.2.0 (`SCAN_DPI=auto`, `MAX_SCAN_DPI`, `/health` `dpi`).
