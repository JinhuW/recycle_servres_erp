# A Bluetooth label printer belongs to one tab at a time

**Symptom.** The label printer is on in one ERP tab (Review or Pack mode).
Another tab shows *Waiting for <name>* forever, and its Connect chooser
doesn't list the printer.

**Why.** Web Bluetooth state lives in each tab. A BLE label printer (the
CT221D's ISSC module, Phomemo and the like) takes one central and **stops
advertising while connected**. The second tab's reload wait calls
`watchAdvertisements()` before `gatt.connect()` and never hears anything.
Chrome's chooser scans for advertisements too. Had a second tab got its own
GATT connection, which Chrome can share between frames, the two tabs' 128-byte
chunks would have interleaved on the one write characteristic.

**Fix (RS-617, v1.483.0).** `lib/labelPrinter.ts` makes one tab the owner: the
one holding the Web Lock `rs.labelPrinter`. Only the owner speaks Bluetooth.
The others follow over `BroadcastChannel('rs.labelPrinter')`, using these
messages:

- `hello`: a new tab asks for the status.
- `status`: the owner's status.
- `gone`: the owner let go.
- `req`/`res`: `print`, `check` and `disconnect` run on the owner's queue.

A follower queues on the lock (`resume()`), so it connects when the owner
closes. Connect steals the lock, and the old owner steps down to follow.
Requests to an owner that left are rejected (`disconnected`) when a new owner
speaks or `gone` arrives.

**Things to know.**

- The stand-in for a tab in tests is a fresh module instance (`vi.resetModules`)
  over a fake lock manager and channel. `resume()` in a follower settles only
  once that tab owns the printer, so tests call it with `void`.
- A hidden owner tab still prints for the others, but Chrome throttles
  chained timers in hidden tabs. Printers whose port takes only unacknowledged
  writes pause 20 ms every 16 chunks, and those pauses can stretch to 1 s
  (or a minute under intensive throttling, after 5 min hidden). Acknowledged-
  write printers such as the CT221D don't use those pauses. If that bites,
  hand ownership to the visible tab.
