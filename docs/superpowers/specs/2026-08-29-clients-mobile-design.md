# Clients on the phone — design

Date: 2026-08-29
Branch: session/20260828-175116
Status: **designed, not built.** Deliberately deferred — the backend and the
desktop page shipped in v1.105.0; this is the follow-on.

Interactive version of this document (screens as live HTML):
https://claude.ai/code/artifact/9e9a2c30-1cb8-46af-bf7e-cbf132a46218

## Why bother

On a desk the Clients page is a report. In a hand it is a tool: the
conversation with a seller happens while a purchaser is standing in someone's
warehouse holding a phone. The desktop page already covers the manager's job
(oversight, reassignment, coverage). The phone covers the purchaser's, which is
the half where the follow-up habit actually forms or dies.

## The one idea

**The return-from-call prompt.** Tap Call → the OS dials → the purchaser talks →
they come back to the app and the log sheet is *already open* asking how it
went.

Logging stops being something you start and becomes something you dismiss.
Everything else here is a re-layout of what exists; this is the only part that
makes logging cheaper than not logging, and it is the reason the mobile shell is
worth building at all. Without it the phone is a smaller report.

## Where it lives

`PhTabBar` has five slots — Home, Orders, [Capture], Shipping, Profile — and the
middle is the camera, the most-used control in the app. There is no sixth slot,
and the file's own comment records the precedent: *"Market and Inventory both
live as quick links on Home instead."*

Clients follows that precedent, **but a link does not build a habit**, so the
count travels to the purchaser instead:

- A red **"2 to call"** card sits at the top of Home, above the quick links,
  carrying two actual client names. A number alone is a statistic; a name is a
  person you owe a call.
- A one-line reason underneath ("1 has gone quiet") — the thing that changed,
  not decoration.

Rejected: a sixth tab. Five is already tight at 320 px, and squeezing in a sixth
shrinks every target on the most-used surface to win one shortcut.

## Screens

Four, and no more.

1. **Home card** — the trigger. Not a screen of its own.
2. **The list** — one card per client, sorted by how late, so the top card is
   always the right next call and the purchaser never chooses. Card carries:
   name, city, what they deal in, health pill, the rhythm strip, a plain-words
   restatement of it (*usually every 3 weeks · silent 59d*), and the actions.
   **Call sits on the card** — the common case never opens anything.
3. **The client** — read, not operated, with a phone already against an ear.
   Order: why you are calling (one sentence), how to deal with them (pay, ship,
   when to call), then what they have sold you. No edit controls.
4. **The log sheet** — bottom sheet, thumb-zone, two taps.

## Rules

- **Two taps, no typing.** Kind pre-selected, outcomes are chips, next call
  already scheduled from their own rhythm. A purchaser who taps only Save has
  logged a complete, accurate contact. *Doing nothing is correct.*
- **"Not now" is a real option.** A sheet that cannot be dismissed is a sheet
  people stop triggering — they would just stop tapping Call.
- **46 px minimum targets, below the midline.** Used one-handed, sometimes with
  a glove on.
- **No table, ever.** Seven columns cannot survive 320 px.
- **Bottom sheet, not a side drawer.** A drawer on a phone is a full screen with
  extra steps; the sheet keeps the list visible behind it.
- **Native `tel:` / `sms:` handoff.** We do not build a dialler, and both work
  with no network.
- The rhythm strip survives the shrink to ~150 px. It is the one piece of data
  worth the width, because it answers "why am I calling this person" before the
  tap. It is always paired with the same fact in words.

## Not on the phone

Reassigning an owner, pinning a tier, editing preferences, the suggestion inbox,
and the manager's coverage view. All deskwork — done sitting down once a week,
not standing in an aisle.

Dropped from the list card specifically: owner, tier, spend. Manager questions.

## The open decision — offline

Half these conversations happen in a metal building or a basement.

Everything above is a re-layout of shipped code. **Queue-and-sync is genuinely
new work** — a local write, a sync pass, and conflict handling against
`next_follow_up_at`.

Two honest options:

- **Build it.** Log writes to the phone first and syncs after; the list still
  renders with the time it was loaded ("Showing what was loaded at 8:12"); the
  banner says "Saved on this phone — 2 calls will sync when you're back in
  signal."
- **Defer it.** Disable Save with "You're offline — try again in signal."

What is not acceptable is pretending it saved. A purchaser only has to lose one
logged call to stop trusting the feature, and after that they stop logging.

## 中文

**供货商**, never **客户** — 客户 already names the sell-side customers, and using
it twice would be the single most confusing thing we could ship. Chips stay 3–4
characters so they hold their width: 正常 / 好久没来 / 已失联 / 新线索. Dates and
money keep Latin numerals with tabular figures, matching the rest of the ERP.

Drafts need a native read before shipping — particularly 好久没来, which is warmer
than "gone quiet" and may be too soft.

## Build notes for whoever picks this up

- Shell: `apps/frontend/src/MobileApp.tsx`, tabs in `components/PhTabBar.tsx`,
  styles in `styles/phone.css`.
- The API is already done. `GET /api/suppliers` returns everything the list card
  needs including `rhythm`; `POST /api/suppliers/:id/notes` is the log endpoint
  and already schedules the next call. No backend work unless offline is built.
- Reuse `components/RhythmStrip.tsx` as-is (`size="row"`).
- Reuse the `cli*` i18n keys — both dictionaries are already complete in EN and
  ZH, and both are test-enforced for parity.
- The return-from-call prompt needs a `visibilitychange` listener plus a record
  of which client was last dialled; there is no callback from `tel:`.
