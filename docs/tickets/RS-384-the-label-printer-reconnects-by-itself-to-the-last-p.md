---
id: RS-384
title: The label printer reconnects by itself to the last printer
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/sardine
pr:
version: 1.330.0
related: [RS-374, RS-381]
---

## Ask

> This connection should auto connect the last connected device and paired device.

Sent with a screenshot of the Pack head. It showed *Label printer off*,
**Connect**, **Print label** and the *Auto* settings button.

## Context

`lib/labelPrinter.ts` (RS-374, v1.324.0) showed *Label printer off* in two
cases. In both, a printer this browser had already connected was close enough
to use again:

- **After a reload or in a new tab.** `resume()` reconnected only through
  `navigator.bluetooth.getDevices()`. In the office Chrome (155) on
  inventory-dev and inventory, `getDevices` and `watchAdvertisements` are both
  `undefined`. Chrome still keeps them behind a flag. inventory-dev had the
  CT221D's id saved under `rs.labelPrinter`, but `resume()` returned before it
  read the id. The page reloads often: from the update toast, from
  `chunkReload.ts` after a deploy, or from a plain refresh.
- **Within the tab.** A printer that slept, was switched off or went out of
  range fired `gattserverdisconnected`. The page set *off* and dropped the
  device. Nothing tried again, although `device.gatt.connect()` on the same
  object needs no chooser and no flag.

Chrome opens its device chooser only from a click, so a printer this site was
never allowed can't connect without one. Here "paired" means allowed through
the chooser before. The page cannot see a printer that is paired only to
macOS.

## Acceptance criteria

- [x] When a connected printer drops (sleep, power off, out of range), the
      page keeps it and tries again by itself, with no chooser. The chip reads
      *Waiting for <name>*. Once the printer is reachable, the chip reads
      *Label printer on* again.
- [x] While the page waits, Print label and Auto use the print dialog, as they
      do with no printer. Connect still opens the chooser to pick another
      printer, which calls off the wait. Disconnect calls off the wait and
      forgets the printer.
- [x] Where Chrome offers `getDevices`, a reload or new tab finds the last
      printer and waits for it the same way. Where Chrome can, the page listens
      for the printer's advertisements first. It doesn't give up after one try.
- [x] Where Chrome doesn't offer `getDevices`, the settings menu says the
      printer reconnects after a reload only once Chrome's Web Bluetooth
      permissions flag is on.
- [x] After Disconnect, the page doesn't reconnect, even after a reload.

## Out of scope

- Connecting a printer this browser was never allowed. Chrome requires the
  chooser, opened from a click.
- Turning on the Chrome flag. That is a one-time setting on the packing Mac.

## Notes

- The flag was traced in Chromium's source. `getDevices` and
  `watchAdvertisements` are the Blink features `WebBluetoothGetDevices` and
  `WebBluetoothWatchAdvertisements`, which `content/child/runtime_features.cc`
  turns on from `kWebBluetoothNewPermissionsBackend`. So
  `#enable-web-bluetooth-new-permissions-backend` alone is enough. The
  extension can't open `chrome://flags`, so the flag wasn't flipped from here.
- Turns. A chooser pick, a wait and Disconnect each take a turn, and a newer
  one ends the older one. A stale connect leaves the link alone. It drops its
  GATT connection unless the new turn wants the same printer, because picking
  the printer you are waiting for must not cut its own connection.
- A wait keeps the state `waiting`, not `connecting`. `useLabelPrint`'s
  `send()` drops a label outright while `connecting`, and a wait can last for
  hours.
- Unit tests (`labelPrinter.test.ts`) use a fake printer:
  - a drop is retried without the chooser
  - one drop starts one wait
  - Disconnect ends the wait
  - a cancelled chooser keeps the wait, and a picked one ends it
  - `getDevices` on load
  - advertisements before the connect
  - no `getDevices` keeps the printer off

  The tests caught a bug: aborting the scan inside the advertisement handler
  rejected the wait before it could resolve.
- Local e2e: Pack mode on SO-4009, with Playwright and a fake CT221D injected
  as `navigator.bluetooth`.
  - Connect led to *Label printer on · CT221D-4FD1 · Ready*.
  - A drop led to *Waiting for CT221D-4FD1*, with Connect enabled.
  - Print label went to the dialog, sending no Bluetooth job. Three tries
    were made while the printer was off.
  - Back on, it read *Label printer on* with the chooser still opened only
    once, and Print label sent a TSPL job.
  - After Disconnect, a drop made no tries and the saved id was gone.
  - A reload with `getDevices` reconnected with no click and no hint.
- Not yet tried on the real CT221D going to sleep. That needs the dev deploy
  and the printer in hand.
