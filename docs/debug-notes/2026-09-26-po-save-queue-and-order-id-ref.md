# Saving lines from two places at once needs a queue and an order-id ref

**2026-09-26.** RS-116. Scan RAM sheet started saving lines by itself, straight
after **Add**. Until then the only saves on the New-PO page were a Confirm or
Submit that the user clicked and waited for.

## The trap

`persistLines` read `orderId` from React state: when it was null it POSTed a new
PO, otherwise it PATCHed. With an auto-save in flight, a Confirm, a second scan
or a Submit read the same stale `null` and POSTed a **second PO**. Submit could
also re-send the scanned lines, because `doSubmit` saves every line not yet
marked `_confirmed`, and they weren't marked until the auto-save returned.

## The fix (`DesktopSubmit.tsx`)

- Saves are chained through a promise queue (`saveQueue` ref), so they run in
  order.
- `orderIdRef` is set as soon as the create returns, before React re-renders,
  so the next queued save PATCHes.
- An `autoSaving` flag puts "Still saving the scanned lines" in `submitBlockers`.

The real-click smoke clicks Submit on the same tick as Add: it shows the blocker
dialog, and the database ends with exactly one PO and one row.

## Related

`removeLine` only dropped local state, so a saved line deleted from the page
stayed on the PO. It now PATCHes `removeLineIds` first.
