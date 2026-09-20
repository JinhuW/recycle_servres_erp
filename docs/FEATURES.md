# What the ERP does today

`CHANGELOG.md` says when things changed. This says what exists **now**, by
area, with the version each behaviour arrived in so you can read the entry
that introduced it.

Written for whoever — human or agent — has to change this system without
having watched it get built. It describes behaviour, not implementation:
`CLAUDE.md` covers conventions and tripwires, and the route files are the
source of truth for endpoints.

Keep it current: when a change adds, removes or reshapes user-visible
behaviour, edit the bullet here in the same PR and cite the new version.

---

## Roles and access

Three roles: **manager**, **purchaser**, and unauthenticated **vendors** who
reach a portal through a URL token.

- Managers see everything. Purchasers see the buying side — dashboard, submit,
  history, shipping, clients, market, settings — and their own POs.
- Desktop role gating is three-layered: the sidebar's `roles` list, a
  `DesktopApp` view bounce, and in-page filters. Missing one leaves the view
  invisible rather than forbidden.
- Auth is httpOnly cookies — a 60-minute `at` JWT plus a rotating `rt` refresh
  family (the access token was 15 minutes until v1.122.0, which made four out
  of five app loads open with a 401, a refresh and a retry before painting).
  No localStorage, no bearer tokens. Refresh-token reuse revokes the whole
  family.
- Every mutating request carries `X-Requested-By: recycle-erp`; the CSRF guard
  drops it otherwise. Exempt: safe methods, `/api/health`, and `/api/public/*`
  (vendor endpoints, which authenticate by URL token instead).
- Managers can reassign a PO's purchaser until it is Done (v1.84.0) and submit
  a PO on behalf of one (v1.82.0). The owner can be any active member,
  managers included — the picker lists purchasers first, then managers
  (v1.131.0).

## Purchase orders

The core object. A PO is a purchase from a vendor, built line by line, that
moves Draft → Submitted → In Transit → Reviewing → Ready to Pay → Done.

- **One PO can hold several categories** (v1.54.0), with its lines grouped by
  category and a per-category cost breakdown (v1.55.0).
- **On the phone a PO is two screens** (v1.154.0). The Orders list no longer
  unfolds a row in place: tapping the card, or the pencil on its right (an
  eye once the PO is Ready to Pay, Done or archived), opens
  `/purchase-orders/:id` — the order itself: the id as the title with the
  stage under it, the stepper, on a Draft a *Before you submit* list of what
  still blocks the hand-off (products and their cost, then whichever of
  paid-by / method / transaction ID / cash or chat screenshot the hand-off
  sheet would ask for, from the same rule, each row a link), a *Products · n*
  row, shipping, the cost card, warehouse, the **payment fields folded behind
  a header that reads back the answer**, notes, attachments and the activity
  log. The *Products* row opens `/purchase-orders/:id/products`: the line
  cards, the add-category dock and the goods total; the line form opens from
  there and returns there. A line removed on one screen is already gone on
  the other, unsaved fields survive the round trip, and the "back to Draft"
  warning is asked once per visit. Desktop keeps its single edit page; a
  products link opened there lands on the PO.
- **The desktop PO page is built around its status, with one home per fact**
  (v1.160.0). The page head and the items card with its cost-breakdown tape
  are unchanged. Under them, *Order status* is its own card: the stepper, and
  beneath it a **stage panel** whose body follows the stage — a Draft shows
  the *Before you submit* list (each unmet row a link to the section that
  fixes it, each met row reading back its answer) beside the one next step;
  In Transit shows the **linked package's Shippo state** — status chip,
  carrier · tracking number, the journey, the arrival date, when the carrier
  last reported — with a **Refresh** button that asks the carrier now (the
  message when tracking is not switched on appears inline), or *Collected by
  ‹name›* for a local pickup; Reviewing, Ready to Pay and Done show what the
  stage is about and the next move. **Every finished step is clickable**: it
  shows what that stage recorded — who submitted and how it was handed off,
  the final journey, who moved it on and when, the Done note and files — read
  from the activity log, read-only, with *Back to ‹current›*; a manager also
  gets *Move back to ‹stage›* there when the order allows it. The next step is
  the only forward click; a stage beyond it stays locked (a manager stages one
  move at a time now, and Save commits it — the footer's button reads *Save ·
  Mark as ‹stage›* while one is pending). After a stage move the page **stays
  put** on the new stage's panel instead of returning to the list. Below the
  status card, **five tabs**: *Delivery* (source, receiving warehouse, shipping
  label or local pickup, tracking number with the carrier recognised from its
  shape, or who collected it, plus a one-line live tracking state), *Payment*
  (paid by, method, transaction ID, proof files, and the manager's
  bank-payments ledger), *Commission* (purchaser, rate, and what the purchaser
  earns — the maths that used to sit in an aside titled "Payment detail"),
  *Notes & files* (notes and Submission receipts; proof of payment is not
  repeated here), *Activity*. No fact has an input in two places any more: the
  warehouse, purchaser, rate and paid-by that appeared in *Order details*,
  the hand-off dialog **and** the aside each live under one tab. Tabs carry an
  **amber dot** while a Draft still needs something under them and a **blue
  dot** for unsaved edits; the open tab rides in the URL
  (`#/purchase-orders/PO-1?tab=payment`) so a link lands on it. A sticky
  footer holds the total cost, what the purchaser earns, *Unsaved edits: …*,
  Discard and Save. **Delivery facts are the page's to edit until Ready to
  Pay**: source, pickup or label, collector and tracking number save through
  the order like any other field; a purchaser's change past Draft is
  material — back to Draft for the manager's change-review — and a new
  tracking number moves the linked package rather than minting a second one.
- **The desktop list opens on the orders card** (v1.147.2). The four KPI
  tiles and the subtitle that sat above it since the first release are gone:
  they were computed in the browser over whatever the stage and category
  filters showed, with no reporting window, and the dashboard now states
  those figures properly. The card head's line count and the per-row
  unpriced badge stay.
- **Two profits per PO for managers** (v1.149.0): **Unrealized** is the
  projection the PO always had — margin on the priced lines at "Sell / Unit",
  less other fees — and is what a purchaser still sees as plain "Profit".
  **Realized** is what the units earned on Done sell orders, at the
  sell-order price less what the unit cost — its share of a negotiated lot
  price when the header states one, else its unit cost, plus the fee share
  (v1.149.4) — net of the commission actually paid to the purchaser: the
  projected commission as the dashboard and spreadsheet show it, over priced
  lines, on the PO as bought and clamped at zero (v1.149.4 — an unpriced line
  contributes nothing to it, cost included); null until something sells, so
  a partly sold PO reads low until the rest goes and says so with a sold
  count. Desktop list:
  the Profit column toggle shows the pair. PO edit page: a realized block on
  the cost tape with a sold meter. Phone: the money card carries both and the
  list row a Realized line. Purchasers and a manager previewing as purchaser
  get none of it. Other fees amortize over the PO as bought (`qty_purchased`)
  from the same release, so a partial sale no longer moves the fee share.
- **Managers see each line's final sell price** (v1.147.0): the qty-weighted
  unit price over the Done sell orders that name the line, with the sold
  count after it when a partial sale left units on the PO. It sits beside
  "Sell / Unit", which stays the projection that feeds commission. Computed
  on read from sell orders, never stored or editable; purchasers and a
  manager previewing as purchaser get neither the column nor the value.
- **Purchasers edit until the review closes.** A material edit sends the PO
  back to Draft and raises a change-review dialog for the manager, showing the
  full field and line diff (v1.97.0). Notes, photos and attachments don't
  trigger it. A reverted order is a Draft that was already submitted, so
  deleting it archives rather than wipes. The window used to run until Done;
  it now ends at Ready to Pay (v1.132.0).
- **Ready to Pay sits between Reviewing and Done** (v1.132.0): the review is
  finished and the purchaser's commission is owed; Done means it was paid.
  The book closes at Ready to Pay — lines, costs, payment reference and
  ownership freeze, notes still append, line goods edits refuse
  — and the PO's lines read Done for every stock and sellable bucket. Managers
  and the owner are notified when a PO reaches it. The stage is a PO stage
  only: it can't be written as a line status.
- **Only the warehouse's manager takes a PO into Reviewing or Ready to Pay**
  (v1.132.0): the manager linked to the PO's warehouse in Settings, including
  stage-jumps that pass through either stage. Both shells lock the step for
  everyone else and say who can; the desktop lock follows the warehouse
  selected in the form. A PO with no warehouse, or a warehouse with no usable
  manager, is open to any manager. Ready to Pay → Done and every backward
  move stay open to every manager.
- **A company-paid PO names the payment that funded it before it leaves
  Draft** (v1.115.0) — the transaction ID is required, and the advance is
  refused without it for every actor, a manager stage-jump and carrier movement
  included. Self-pay POs are unaffected. The rule governs only orders created
  after it reached the environment, so POs already on file stay exempt. Mobile
  gained the field as an input; it used to be read-only there. **The ID must
  also be a payment our PayPal account made** (v1.150.0): at the same door,
  it is checked against the PayPal transactions the Payments sync holds, and
  an ID none of them carries is refused with the ID named — a typo or an
  invented ID used to be accepted and left the PO unable to reconcile. An
  unknown ID in PayPal's own 17-character shape first pulls PayPal once, so a
  payment PayPal already reports does not wait for the six-hourly sync; a
  placeholder such as `CASH` is refused at once, without the round-trip
  (v1.155.1). PayPal itself reports a payment up to three hours late, and
  the refusal says so. When the pull itself fails — PayPal down, key
  expired — the refusal says PayPal could not be reached rather than
  blaming the ID, and each user gets three pulls a minute before the guard
  judges the synced table as it stands (v1.157.1). The check is live only
  once a PayPal account has synced into the environment, so a dev box
  without keys is unaffected; a linked, ignored, pending or reversed row
  still counts as existing, and Mercury legs do not.
- **Leaving Draft is a hand-off, asked in one dialog** (v1.142.0; a
  *checkpoint* since v1.159.0 — each section the order already answers folds
  to a ✓ row with a *Change* button, only the unmet ones open, and a page that
  holds everything is one click; the body may omit any field and the server
  fills it from the order). Clicking In Transit on a Draft — the desktop
  stepper or the phone's advance button — opens *Mark as In Transit*: the
  receiving warehouse, the order's **source**
  (Facebook / Local / Reddit / Other, the same set tracked packages use), and
  how the goods get here: **Local pickup** (who collected it, from a member
  picker) or **Shipping label** (paste the tracking number; the carrier is
  recognised from its shape, as on Add-package). Then who paid. **Company
  card** names a method, PayPal or Cash: PayPal keeps the transaction-ID rule
  and offers the optional screenshot that reads the ID; Cash lifts that rule
  but needs its own proof (v1.153.0, below). **Self-paid** asks for no method
  and no ID — it is reimbursed from commission, not matched against the bank
  — but **requires the chat with the seller** as a Submission attachment (any
  Submission file on the order counts). Managers also see the purchaser and
  commission rate in the dialog.
  Confirming writes everything, creates the tracked package for a label
  (linked to the PO, carrying its source), and advances, in one transaction —
  a refusal leaves nothing behind. The hand-off is the owner's or a manager's;
  the desktop asks for unsaved page edits to be saved first. Every field it
  changes is on the activity log, beside a *Handed off* entry naming the
  collector or the package. The chat rule is enforced in the advance itself,
  so a manager stage-jump and the carrier poll hold to it too, and it is
  grandfathered by a cutoff stamped when the release reached the environment,
  exactly like the transaction-ID rule.
- **The desktop list's In Transit chip says how the goods are coming**
  (v1.155.0). A PO in transit by carrier reads `In Transit | UPS` (FedEx,
  USPS) and the chip links the carrier's tracking page for the hand-off's
  package, in a new tab; a local pickup reads `In Transit | Local`; a PO that
  left Draft before the hand-off existed keeps the plain chip. The phone list
  still shows the plain chip. **Under the chip, the box's own state**
  (v1.156.0): the tracking number, linked to the same carrier page, and
  `Est. Tue, Sep 22` once the carrier has given a date — *Delivered* or
  *Delivery exception* instead once it says so, because the PO itself stays
  In Transit until a person receives it.
- **The PO page shows the box's journey while the order is In Transit**
  (v1.156.0). Between the stepper and the order details a *Shipment* block
  reads the hand-off's package: its status chip, `UPS · 1Z…`, a
  Tracking added → In transit → Delivered timeline (a delivery exception
  stops the bar with the carrier's words under it), the arrival date, the
  carrier link, and when the carrier last reported. It comes from Shippo's
  webhook and the 45-minute poll. Since v1.160.0 it lives inside the status
  card's stage panel and carries a **Refresh** that asks the carrier now (the
  PO's owner may call it, not only the box's creator); a local pickup shows
  who collected it instead, and a PO that left Draft before the hand-off
  existed says so and points at the Delivery tab.
- **The desktop list has a Total cost column** (v1.156.0), after QTY: the
  goods figure the dashboard uses (the stored total, else the line sum on
  what was bought) plus other fees, with `incl. $12 fees` under it when fees
  exist; sortable, in the Columns picker, on by default. A user who had
  pinned the picker before this release ticks it on once — the saved set
  lists what is shown, and a new column is not in it.
- **One payment picker on every surface, and a cash payment needs a
  screenshot of the amount** (v1.153.0). The desktop Submit and Edit pages,
  the phone's Review and Detail screens, and the hand-off dialog and sheet
  all share one component: *Paid by* (Company card / Self-paid), then, under
  Company card, *Method* (PayPal / Cash), then a proof panel whose heading
  states what the chosen path needs before anything is typed — the
  transaction ID plus the optional screenshot that reads it; a **screenshot
  of the total amount handed over** for cash (the receipt, the counted cash,
  or the chat where the amount was agreed); the chat with the seller for a
  self-paid order. A company PO whose method was never asked is asked in the
  hand-off rather than assumed to be PayPal. The cash screenshot is the third
  proof-of-payment rule: a company-cash PO created after the release refuses
  to leave Draft — hand-off, manager stage-jump, carrier poll — until one is
  attached, with a 409 that names the fix; earlier POs are exempt by the same
  cutoff mechanism as the other two rules. Cash proof lives in a **`Payment`
  attachment bucket** of its own (the activity log calls it *Payment proof*),
  apart from Submission receipts and manifests, so a lot manifest cannot
  stand in for it. The method is saved from the create and edit pages
  (`paymentMethod` on POST / PATCH), logged, and cleared when the PO flips to
  Self-paid; `GET /api/orders/:id` reports `cashShotRequired` beside
  `txnRequired` and `chatShotRequired`.
- **A PO cannot be submitted without a cost** (v1.148.0). Leaving Draft is
  refused while the order's goods cost is zero, through every door — the
  hand-off, a manager stage-jump, the carrier poll. The rule is per order,
  read off the derived `orders.total_cost`: a $0 line inside a priced lot and
  a negotiated lot price over unpriced lines both pass; other fees do not
  count. No cutoff — a cost can always be added to an old Draft — but first
  submission only (v1.149.4): a PO that already left Draft and was sent back
  by a purchaser's edit re-submits as it was accepted, through every door,
  and the manager judges the edit in the change-review dialog. Clicking In
  Transit on a $0 Draft with no submission history, on the desktop stepper
  or the phone's advance button, raises a *Can't submit yet* dialog naming
  the fix instead of opening the hand-off.
- **Unit cost is required when a product line is saved** (v1.152.0). The
  shared line rule (`lib/lineRequirements.ts`) names Unit cost alongside the
  identity fields and quantity, so a blank or $0 cost is refused where the
  line is entered: the desktop drawer's Confirm (and the auto-confirm when
  the next line is added), the Submit Order blocker dialog, the phone's
  add-item form and draft sync, and the edit page's Confirm and Save. The
  edit page asks only of a line that is new or that the user touched — an
  untouched legacy $0 line does not block Save or a stage change. The
  per-order leave-Draft check above stays as the backstop, and the backend
  still accepts `unit_cost >= 0`.
- **The list's Payment cell says what the bank paid and opens it** (v1.138.0).
  On the desktop PO list a manager reads `Company | $1,279` or `Self | $2,829`
  on every PO with linked payments — the ledger's net, refunds subtracted,
  failed and reversed left out — and clicking it opens the Payments page
  focused on that PO. A PO nothing is linked to keeps the plain chip, and so
  does every purchaser, since the page it opens is manager-only.
- **The desktop list holds every PO in scope** (v1.140.1). It used to stop
  silently at the API's first page — the newest 50 — so older orders were
  unreachable and the stage counts, KPI cards, search and sort all ran over
  that slice. It now follows the API's pages to the end: the first page
  paints at once and older pages append behind a "Loading older orders…"
  row until the last one lands. The mobile PO list and the sell-order list
  still stop at 50.
- Managers can reopen a Done PO back to Reviewing (v1.81.0), and since
  v1.132.0 also Done → Ready to Pay and Ready to Pay → Reviewing. Since
  v1.138.5 a move back to Reviewing is refused only while a line sits on a
  Shipped or Awaiting-payment sell order — a Draft naming the line no longer
  blocks it, since the draft still promotes against a Reviewing line. A move
  to In Transit or Draft (including the purchaser-edit revert) is still
  refused by a Draft. The refusal names the sell orders involved.
- **Costs split into a goods total and other fees** (v1.43.0); a goods overflow
  can be moved into Other fees (v1.45.0). Fees amortize per line, which is what
  commission is calculated from. `orders.category` and `orders.total_cost` are
  **derived from the lines** — clients must not send `totalCost`.
- Line specs are per-category: RAM carries Part #, Chip #, Brand, Capacity,
  Generation, Type, Class, Rank and Speed; SSD/HDD carry Interface, Form
  factor, Health % and RPM; Other carries a free item type (v1.47.0).
  Rank covers the plain JEDEC grid plus the high-density packaging codes —
  dual-die (`4DRx4`, `8DRx4`) and 3DS stacks (`2S2Rx4`, `2S4Rx4`, `4S2Rx4`),
  which a label scan now keeps instead of flattening to the plain rank
  (v1.139.0).
- **Validation is shared between shells**, so desktop, mobile and the backend
  can't drift: all RAM spec fields required (v1.29.0); Chip # required only for
  Micron and Other, whose part numbers don't identify the module (v1.36.0);
  DDR5 lines must carry serial numbers, and once any line has serials their
  count must equal the line qty (v1.42.0); SSD lines drop health/serials and
  require brand above 800 GB (v1.76.0).
- **Part numbers are canonical** — one part number however it was typed
  (v1.104.0) — and the submit form suggests existing ones as you type
  (v1.101.0).
- Lines carry photos (v1.54.0). Submission attachments accept receipts and
  spreadsheets (`.xlsx`, `.csv`); `.xls` and `.xlsm` stay refused (v1.34.0).
- The PO list hides Done orders by default with a toggle (v1.89.0); mobile
  managers see the whole org's POs (v1.88.0). The stage filter lives in the
  table toolbar as status chips (v1.39.0).
- **Archiving a PO takes its goods out of stock** (v1.137.0). Archive still
  hides the order from the default list and is still reversible, but it now
  also moves every non-Sold line to the `Archived` line status, which drops
  it out of the inventory screens, the sellable picker, the vendor catalog
  and bids, and the MCP search the same way Sold does. Since v1.138.2 the
  order's archived flag itself keeps its non-Sold lines out of all of those,
  and out of sell orders, bids and transfers, whatever status a line holds —
  the pre-release backfill is finished by migration 0124, which pulls such
  lines off open sell orders the way the archive dialog does. Unarchive
  restores each line to the status it held. If a line sits on an open sell order
  (Draft, Shipped or Awaiting payment) the archive dialog names the sell
  orders and lines and asks whether to remove them from those sell orders
  first; the removal is audited on the sell order and is not undone by
  unarchiving. That question, and the removal, are the manager's: a
  purchaser who owns the PO gets a plain refusal naming no sell orders
  (v1.137.1). A line out on a pending transfer refuses the archive; one that
  was already out when the PO was archived (migration 0122's case) joins the
  archive on receive or discard, with the audit row unarchive reads, rather
  than landing at a stock status behind the flag (v1.138.4). An
  archived PO is frozen — edits, stage moves, delete and inventory line edits
  (Sold lines included) all refuse until it is unarchived — and both edit
  shells render it locked and say so. The Analysis tab leaves archived goods
  out of every aggregate (v1.137.1), Sold lines excepted — they are the sales
  record and keep counting (v1.138.4).
- **Removing a PO line is refused while an open, non-archived sell order
  names it** (v1.145.2), and the refusal names the sell orders. Open means
  Draft, Shipped or Awaiting payment — the same set the archive dialog
  above uses. A Closed, Done or archived sell order lets the line go: it
  keeps its own line as the snapshot it already carried (label, part number,
  qty, price) with the link to the source cleared. Until v1.144.1 the
  refusal was the database foreign key itself, so every sell order that had
  ever named the line blocked and the message named nothing; v1.144.1
  exempted archived sell orders only, so closing one did not help despite
  the dialog saying it would. A sale whose source line is gone drops out of
  the cost-based dashboard figures.
- **Every change is audited**, drafts included (v1.33.0), and each timeline
  opens with an "Order created" entry.
- Excel export carries the category's full spec set per line, one tab per
  category (v1.40.0). There is no PDF invoice — it was removed in v1.40.0
  because it had fallen behind the spreadsheet.
- **Both desktop PO pages hold together in a narrow window** (v1.134.0).
  Under 1100px the list's toolbar wraps inside its card with the search box
  giving up width first, the KPI tiles stay in one row while four fit, and
  The edit page is one column at every width since v1.160.0 — items, status,
  tabs, footer — so under 1100px only the details change: the item table
  scrolls inside its card, the editable fee's inputs drop under their label,
  the tab fields go two-up, the stage panel stacks its two boxes, and the
  status stepper keeps every stage as a numbered dot and names only the
  current one (each dot names itself on hover). The order ID never wraps at
  any width, and the Notes box stays inside its card at every width (it used
  to overhang at 1400px).

## Clients (the people we buy from)

Purchase orders had no counterparty until v1.108.0 — who we bought from
survived only as free text on `shipments.from_name`, `packages.seller_name` and
a blob in `orders.notes`, which is why payment reconciliation fuzzy-matches
strings. Now `suppliers` (**Clients** in the UI; 供货商, because 客户 is already
the sell-side customers) carries an owner, structured preferences, a contact
log and `orders.supplier_id`.

- **Standing is stored; tier, health and the follow-up date are derived** per
  read from order history — the same discipline `orders.category` and
  `total_cost` follow, because a stored status goes stale (v1.108.0).
- **Each client is judged against their own rhythm**: silent past twice the
  median gap between their POs is "gone quiet", past four times is "lost
  touch". A weekly seller quiet for three weeks is in trouble; a twice-a-year
  seller quiet for three weeks is fine (v1.108.0).
- Desktop page at `/clients`, both roles, opening on **Needs a call** rather
  than everything. No system vocabulary reaches the screen — tier A/B/C shows
  as Top seller / Regular / Occasional, health as On track / Gone quiet / Lost
  touch, a prospect as a New lead; the mapping lives in `lib/clients.ts`
  (v1.108.0).
- The **rhythm strip** draws each PO as a mark across a year, with the silence
  since the last one as a bar that goes amber past twice their own gap.
- **Logging a call is two taps and no typing**, and schedules the next one from
  the client's tier cadence — doing nothing is the correct action. A logging
  flow that costs more produces calls nobody logs, and a follow-up list that
  lies.
- Tracking a package **creates nothing**; sellers surface in a suggestion
  rail, which counts purchase orders rather than parcels — `packages` is one
  row per box, so a PO shipped in three cartons is one PO, not three
  (v1.114.1; the prepaid-label source of suggestions went with the label flow
  in v1.157.0).
- Attributing a PO to a client is bookkeeping, not a material edit: it is
  audited but does **not** bounce a submitted PO back to Draft. The client must
  be one of yours — a purchaser cannot attach a PO to someone else's book, and a
  client's name is scoped to the reader, so a book handed to another purchaser
  stops appearing on the previous owner's orders (v1.114.1).
- **Changing a client's owner goes through one endpoint only.** A handover has
  to leave a trace on the same timeline as the calls, so it is a reassign, never
  a field edit (v1.114.1).

## Inventory

There is **no inventory table**. Stock is `order_lines` whose PO is Done or In
Transit, and a line's qty can never be 0. Lines of an archived PO sit at the
`Archived` status and are out of every stock view until the PO is unarchived
(v1.137.0); like Sold, they are reachable through an explicit status filter.

- Flat and grouped views. Grouped is what goes outward to vendors and buyers,
  so it carries no cost, sell price or submitter (v1.51.0); flat keeps them for
  internal use.
- **The phone Inventory list shows each line's sell price to every role**
  (v1.144.2), under the status chip, the way the desktop table and the phone
  Orders list already did. Unit cost, profit and margin stay manager-only
  everywhere — the API does not send them to purchasers.
- Search matches part number, serial number, brand, description and item type
  (v1.42.0), and the PO number, whole or partial (v1.143.0).
- Export honours the row selection, one worksheet per category, with designed
  workbook styling (v1.30.0, v1.31.0). Select/unselect all lots in the current
  filter (v1.19.0).
- **The export and both screens read in the vendor bid sheet's order** — brand,
  then capacity, speed, numerically collated with blanks last (v1.107.0), and
  category rank ahead of it on the screens, which have no tabs to group by
  (v1.111.0). One implementation serves the workbooks and the lists. The screens
  still take the newest 200 rows from the database; only their arrangement
  changed. The bid sheet's RAM tab (and its packing tabs) put a device-group /
  DDR-generation grouping ahead of that order (v1.129.0); the export and the
  screens do not.
- Other-type stock can be filtered by Untyped (v1.49.0).
- Spec fields on an inventory line are editable in place on desktop.
- **Committed sell orders reserve the units they name**, not the whole lot.

## Sell orders and the vendor portal

- A **draft sell order is a proposal**; inventory is claimed only on promotion
  (v1.41.0). Drafts can move straight to Awaiting payment (v1.13.0).
- Orders carry a payment receiver, creator-only reopen (v1.15.0) and a receiver
  column with a managers-only receiver rule (v1.16.0). The receiver can be
  reassigned from the detail view in any status, Done and Closed included —
  the change saves at once and is logged in the order history (v1.135.0).
- **Negotiated final-price adjustment** with an order-summary breakdown card
  (v1.22.0, v1.23.0).
- **Vendor price round-trip**: export a bid-sheet XLSX, the vendor fills in
  prices, import it back (v1.21.0). The sheet ships pre-sorted the way the desk
  reads it, with an autofilter across the header row and no sheet protection
  (v1.51.2). Its header text is load-bearing for the import parser — don't
  move it. **Saving after a confirmed import records the accepted prices on
  the Market value board** as `bid:<order>` data points, USD at the saved
  rate, one per confirmed part (v1.138.3) from the lines in the condition the
  sheet priced (v1.138.4); hand-typed price edits record nothing.
- The price template splits into one worksheet per category with per-attribute
  spec columns and image URLs (v1.25.0, v1.27.0). **The RAM tab groups its rows
  with merged label columns left of `#`** — "Desktop & laptop" / "Server", then
  DDR3 / DDR4 / DDR5 — ahead of the brand/capacity/speed order; the filter
  dropdowns start at `#` because Excel won't sort across unequal merges
  (v1.129.0). Each label column carries its own light palette and each row a
  paler wash of its generation, so a group reads as a band; the yellow
  `Unit Price` column is untouched by it (v1.130.0).
- **The packing checklist is a separate download** — `Packing list` beside the
  bid-sheet button, `GET /api/sell-orders/:id/packing-list`, managers only. It
  carries per-warehouse `Pack - <warehouse>` tabs (v1.28.0) with tick boxes,
  quantities and subtotals but no prices, and it lived inside the bid-sheet
  workbook until v1.130.0, which meant the vendor's copy carried it. Its RAM
  sections repeat the bid tab's merged labels and colours on two reserved
  leading columns — reserved on every pack tab, so two warehouses on one order
  read alike. Both files come from one query and one sort, so a picker and a
  bidder find a product in the same place; uploading this one to the price
  import is rejected for having no price column (v1.130.0).
- **Vendor bids**: vendors reach a tokenised portal with faceted catalog
  filtering, submit bids, and managers review and promote them on a dedicated
  screen. Promotion picks and validates a customer for general links.

## Shipping

The Shipping page is a ledger of **inbound packages**: tracking numbers for
boxes sellers have shipped, moved by Shippo, each becoming a purchase order
when it arrives.  The system never buys a label.

- **Prepaid-label purchase was removed** (v1.157.0).  The ShipSaving-backed
  flow — rate quotes, buy, void, the label wizard, the per-PO *Shipping
  labels* panel, the seller-fill link (`/s/<token>`) and the label cost folded
  into a PO's other fees — never left the stub provider in production and is
  gone: routes, tables' readers, UI, i18n.  The `shipments` table stays in
  Postgres, unread.  `/api/health` reports `providers.tracking` only.
- **External labels** can be added with carrier detection, and a delivered
  package flows into creating a PO (v1.75.0).  The desktop page lists
  packages only — Order · Seller · Carrier · Tracking — and exports the same
  columns to CSV.
- **Adding a package requires its PayPal transaction ID** (v1.116.0). It is not
  paperwork: the ID carries onto the PO minted from the delivered box, and
  reconciliation auto-links a bank row to that PO on exactly this value — so a
  package added without one becomes a PO only a manager can reconcile by hand.
  Submitting without it is blocked by a dialog that names the one route a
  purchaser has, since the Payments page is manager-only: ask the manager who
  paid for the order. Dropping the payment screenshot still fills it for you.
- **Tracking is Shippo, driven by webhooks** (v1.102.0). A Shippo *test* token
  only tracks carrier `shippo`.
- Mobile label scan: look up, note, create a PO; managers get a Shipping tab
  (v1.95.0).
- **The Shipping page is unlisted** (v1.142.0): it left the desktop sidebar and
  the phone tab bar, because a tracking number is now pasted in the PO's own
  In Transit dialog, which creates the package already linked. The page still
  answers at `#/shipping`, and a PO minted from a delivered package inherits
  the package's source.  The purchaser's slot in the phone tab bar went back
  to Market in v1.145.0 (it had been Market until v1.80.0); managers keep
  Home · Orders · Capture · Profile.
- The phone Home card counts inbound packages from
  `GET /api/packages/inbound-counts` (v1.157.0; was `/api/shipments/…`).
- Owners get a default warehouse, and managers can create a package PO at any
  status (v1.85.0).

- **A package Refresh explains itself when tracking is off** (v1.125.0). It used
  to raise a blocking "Something went wrong" dialog carrying the backend's own
  `SHIPPO_API_TOKEN` message at whoever pressed it; both shells now say plainly
  that automatic tracking isn't switched on yet and the package won't update on
  its own.

> Tracking ships **dark until its keys are set** — `SHIPPO_API_TOKEN` /
> `SHIPPO_WEBHOOK_SECRET`. `/api/health` reports the provider mode so this
> state is visible from outside (v1.105.0).

## Payments and reconciliation

Manager-only. Links **Mercury and PayPal transactions to purchase orders**.

- Transaction ingest with auto-pair and auto-link (v1.90.0), a background sync
  loop behind a manager-only API (v1.91.0), and a Payments page (v1.92.0).
- **Internal Mercury↔PayPal transfers are classified out of the unlinked
  queue** (v1.93.0) by counterparty and Mercury kind rules (v1.94.0).
- Unlinked transactions get **suggested matching POs** (v1.99.0).
- The queue **opens on money out**, and the Unlinked and Suggested tiles take
  the same direction lens as the rows beneath them, so the count and the list
  can never disagree (v1.114.1).
- A **linked row shows the PO's cost beside the PO id** (v1.117.0), so the
  payment and what it was meant to cover read on one line. The figure is goods +
  `other_fees` — the PO's cost as its own page states it, and what the bank was
  actually asked to pay.
- Since v1.115.0 a company-paid PO cannot be submitted without its transaction
  ID — which is the key auto-link matches on — so those POs arrive already able
  to reconcile themselves, instead of landing in the unlinked queue for a
  manager to match by amount and date. Since v1.150.0 the ID must also be one
  of the synced PayPal transactions, so a PO cannot leave Draft naming a
  payment this table has never seen.
- **The link is made when a human makes it, in either direction** (v1.118.0).
  Saving a transaction ID on a PO — on edit, on create, or on the draft PO
  minted from a delivered package — claims the matching transaction on the
  spot instead of waiting out the six-hourly sync, and records it as a manual
  link. Linking on the Payments page fills the PO's transaction ID and logs the
  fill against the manager. Neither side overwrites the other: a PO already
  naming a different transaction keeps it, and a typed ID claims only
  transactions nobody has linked, ignored, or deliberately unlinked.
- **A PO's payments have an address** (v1.138.0): `#/payments/po/<id>` opens
  the page pinned to that PO — a banner names it, the feed holds only its
  payment groups (an exact `orderId` filter, not the substring search), the
  first is expanded, and the tiles and filter bar step aside. The banner also
  says the net paid — the chip's figure — so the rows below, reversed legs
  included, can be reconciled against it (v1.138.4). The manager's own
  filters are untouched; "Show all payments" hands the page back as it was.
  The PO list's Payment cell is what links here.
- **Internal transactions** (v1.119.0) are records that group the bank rows of
  one internal movement — a Mercury→PayPal transfer, a card-funding chain — and
  carry a title and a **note**, the first user-written text a bank row has ever
  had. Reachable from Payments; a filed row leaves the unlinked queue and names
  its record. Their totals read a transfer's two opposite-signed legs as two
  real movements (so a transfer nets to zero) while a payment pair — the same
  money seen twice — still counts once.
- **A row states one verdict and offers one action** (v1.120.0). The Status
  column was folded into the Purchase order column — they answered the same
  question — so a row now reads a linked PO with its cost, a suggested PO with
  the gap between the two dates, `Transfer`, `Ignored`, or `Unlinked`, and the
  freed column is an actions rail whose primary button sits at the same place on
  every row. `Ignore` and `Not the same` appear on hover or keyboard focus
  rather than standing on every row at once; a device without hover keeps them
  visible. The expanded row's own actions — Group with…, Mark as transfer,
  Add to internal…, Unassign and their counterparts — are outlined buttons in
  one bar under a hairline (v1.138.1), in two groups: what the money is, then
  which record or owner it belongs to. The two that open a picker carry a
  chevron. A row with nothing to offer shows no bar.
- **`Link…` always opens the picker; the manager chooses the PO** (v1.133.0).
  Until then a row with a single confident candidate linked to it on one click,
  with nothing on the button saying so. Now every row's `Link…` opens the PO
  picker — ranked suggestions first under a "Suggested purchase orders" heading
  (with "showing X of Y" when the pool is capped), "Search results" once the
  manager types — and the link happens when they click a PO in it. The
  per-suggestion button in the expanded row is labelled with its PO
  (`Link PO-1414`) because it does link on the click. `Not it` is gone; it
  existed only to escape the one-click path.
- **Owner is a column** (v1.121.0), between Amount and Status — avatar and first
  name, full name on hover, a dash where nobody owns it. Owner and PO are
  mutually exclusive by constraint, so the column is empty by design on the
  Linked tab and behind the Refunds tile. Assigning still happens in the
  expanded row.
- **A payment with no PO can be assigned to a member** (v1.119.0), and the queue
  filters by owner or by Unassigned. Assigning deliberately does *not* resolve
  the row: a payment that needs explaining still needs explaining, it just has
  someone to explain it. Linking that payment to a PO clears the owner, since
  the PO is the answer the tag stood in for; a row filed under an internal
  transaction refuses the link instead, because a note is attached to it.
- **An assigned payment's suggestions are the owner's POs** (v1.151.0). The
  owner gates the amount-and-date pool, so the expanded row's suggestion
  block, the `possible PO` badge, the `Has match` filter and the Suggested tile
  all agree; an unassigned payment still sees every PO. A PO carrying the
  payment's PayPal transaction id is offered whoever owns it — an identifier
  on a PO outranks a guess about who paid — and the picker's typed search is
  never gated. Assigning or unassigning an expanded row refreshes its
  suggestions in place.
- **A payment can carry a note** (v1.136.0). The expanded row has a note box
  with Save and Clear; the collapsed row shows the note under the payee, and
  a caption names who wrote it and when. Search matches note text. A note is
  allowed on any row — linked, ignored, transfer, failed or reversed — because
  it explains rather than classifies, so no "unlink first" guard applies. It
  is stored on every leg of a paired payment, like the owner tag; when the
  sync pairs a noted Mercury settlement with its PayPal charge it copies the
  note across, so the note survives on the row the feed shows (v1.137.1).
  Grouping by hand spreads a lone note and refuses two different ones. 280
  characters.

- **A disputed payment says so** (v1.124.0). The sync reads PayPal's Customer
  Disputes API alongside the transaction feed, and a payment we have opened a
  case against carries a red chip, appears behind a **Disputed** tile and
  filter, and shows the case's stage (inquiry → claim → pre-arbitration →
  arbitration) with its dated history when the row is expanded. Only cases *we*
  filed as the purchaser: PayPal names no filer, but a transaction's sign is its
  direction, so ours always sit on money going out. Message threads and evidence
  are not stored — the page answers "where has this got to", not "what was
  said".

- **Money that hasn't settled says so** (v1.127.0). Both providers used to drop
  every row that had not settled, so a payment in flight was indistinguishable
  from one that never happened — a $20,570 PayPal charge sat pending for
  fifteen days without existing in the ERP at all. Every state is now ingested
  and normalised across the two providers: **settled**, **pending**, **failed**
  (PayPal denied, Mercury cancelled/failed/blocked) and **reversed**. A row
  that has not settled carries a chip beside its source, and a settlement
  filter sits with the source and direction ones.
  - **Pending is chased.** It counts in the tiles, and auto-link claims it on
    an exact transaction-ID match so the PO stops reading as unpaid — it just
    says the money has not cleared, on the row and on the PO's payments ledger.
  - **Pending pairs like anything else** (v1.128.0). The common pending leg is
    the Mercury pull, reported days before it posts; holding the pair back
    until then showed one payment as two unlinked rows. A pending leg on either
    side is auto-paired, offered by the picker and accepted by Group. The group
    is badged *Pending* while any leg is, the settlement filter agrees with the
    badge, and the expanded row says which leg. A pair whose leg later *fails*
    lets go of it on the next sync — no tombstone — so the retried pull can
    take its place. Only failed and reversed legs never pair, and neither
    does an ignored one (v1.138.4); transfer pairing still wants both legs
    settled. The PO ledger reads the PayPal leg alone, so
    it says cleared while the pull is still pending.
  - **Failed and reversed are records, not tasks.** Out of the queue, out of
    every tile, no actions at all. Choosing one in the filter widens the tab to
    All, since asking for them from inside the queue would always answer empty.
  - **A reversed payment stops counting towards its order.** PayPal reverses in
    place, reusing the transaction id, so this lands on a row already linked to
    a PO. It stays on the ledger, badged, but leaves the PO's linked total.

> PayPal's Transaction Search lags ~3 hours. A fresh transaction missing from
> Payments is usually that, not a sync bug — check `last_refreshed_datetime`
> first. Since v1.127.0 the other answer is that it is **pending**: it is
> ingested and badged, not missing.

> **The sync window is `cursor − 5 days`, plus the oldest row still pending.**
> The overlap alone would let a payment that stays pending for weeks fall out
> of every fetch and freeze its badge; a Mercury pending row has no posted date
> at all. Transactions that were already pending when v1.127.0 shipped needed a
> one-off cursor rewind (migration `0119`) — the overlap could never have
> reached them.

> Disputes are a **separate PayPal app permission** from Transaction Search
> ("Disputes" under App feature options). Without it every dispute call returns
> `403 NOT_AUTHORIZED` while the money keeps syncing — the Payments header says
> *"PayPal disputes not authorised"* rather than showing an empty list. Any
> other sync failure says *"PayPal disputes didn't sync"* instead (v1.125.1):
> the permission is the only cause an admin can act on, so a timeout that
> claimed to be one sent them to fix a setting that was already right.

## Transfers

Internal stock movement between warehouses, with a manifest view and its own
status guard.

## Market values

Reference prices per part, readable and writable by managers, and reachable
over MCP.

- Paginated with infinite scroll (v1.12.0), sortable by clicking column headers
  (v1.67.0).
- A line can be priced while the buy can still change (v1.54.0).
- **Four feeds write `last_price`**, each tagged in the event's source: the
  scraper and MCP connectors (`scraper:`/`mcp:`), a manager's manual entry
  on the Market page (`manual:`), a sell order reaching Done (`sale:<order>`),
  and a sell-order save that follows a confirmed vendor price import
  (`bid:<order>`, v1.138.3). The Activity page shows the source per row; the
  Market page shows only the price and its age.

## Activity and audit

- **Manager-only Activity page** unioning four ledgers — `order_events`,
  `sell_order_events`, `inventory_events`, `ref_price_events` — into one
  reverse-chronological register (v1.37.0), filterable by area, action, person,
  date range and free text. Raw kinds normalise to one vocabulary so query and
  labels can't drift.
- Loads as you scroll, with a pinned column head (v1.38.0), and "Open record"
  opens the record (v1.51.x).
- Vendor bids and member/permission changes are **absent** — they write no
  audit rows anywhere today.

## Dashboard

Per-role. Purchasers see projected profit from their own Done POs (v0.1.10).

- **The reporting window is two calendar dates in the business time zone**
  (America/Denver), chosen on the desktop by a chip with presets (last 7 /
  30 / 90 days, this month, year to date, last 12 months, all time, or a
  custom pair of dates) or by dragging on the month strip under the page
  head: drag across it for a new window, drag the band to move it, drag a
  handle to resize it, to the day, with the date under the handle while
  dragging. Every tile, the chart, the contribution cards and the phone's
  ranking re-scope to it. `GET /api/dashboard?from=YYYY-MM-DD&to=…`;
  the `?range=` presets still resolve to the same dates, and `ytd` means
  since 1 January (it was 365 rolling days). The phone dashboard stays on
  the last 30 days (v1.146.0).
- **The cashflow chart** shows sales in above the baseline, purchases out
  below it, and the gross profit on what sold as a line, in day, week or
  month buckets that follow the span (overridable). Buckets are clipped to
  the window, so the series sums to the tiles. Hovering gives one tooltip
  with all three figures for the bucket (v1.146.0; it was a profit-only
  weekly chart labelled by ISO week number).
- **Three contribution cards** — Cost, Sell orders, Profit — say who drove
  each figure: cost by supplier, purchaser or category; sales and profit by
  customer, "sourced by" or category. Each lists every contributor, largest
  first, with its share of the total; past eight rows the list scrolls inside
  the card with the header pinned, so the three cards stay level (v1.149.1;
  before it the server kept the top seven and folded the rest into a
  "Remaining" row). Cost is the
  PO header total — goods plus other fees — over **every PO past Draft** (In
  Transit, Reviewing, Ready to Pay, Done), the same figure as the chart's
  purchases-out bars; money is committed when a PO is submitted, so the card
  is wider than the phone ranking's Total cost, which counts a PO only once
  commission is owed (v1.147.1; v1.146.0 used the ranking's rule). A
  mixed PO shows as "Mixed" under Category. The Sell orders total is the
  revenue tile and the Profit total the gross-profit tile, so a sell line
  with no inventory link is in neither; their "Sourced by" tab credits each
  sold line to the purchaser whose PO supplied it — purchasers never create
  sell orders, which is why the tab is not called Purchaser (v1.147.1). Each
  card states what it sums in a line under its title — realized wording for
  managers, "your … / projected …" for purchasers — because the Cost card
  and the leaderboard beside it count different sets of POs (v1.149.2). A
  purchaser sees their own POs by supplier and category only (v1.146.0).
- **The purchaser ranking lives on the phone dashboard only** (v1.149.3): the
  manager's "Top contributors" and the purchaser's "Your rank" cards. The
  desktop's full-width "Contributor leaderboard" table — sort toggle, category
  toggle, Orders / Total cost / Revenue / Profit / Commission columns — was
  removed at Jinhu's request, since the tiles, the chart and the contribution
  cards state the same figures with a reporting window. The ranking itself is
  unchanged: purchasers by the total cost of their POs in the selected range —
  goods total plus other fees, the figure the PO pages call "Total cost" — or,
  on a toggle, by the commission those POs earned (`?lb=cost|commission` on
  `GET /api/dashboard`, cost by default; v1.141.0, ranked by projected profit
  from v1.0.1). Both lenses count a PO from Ready to Pay on, when its
  commission becomes owed (v1.132.0). A purchaser sees every peer's rank but
  only their own money, so the ranking is computed server-side.

## Oversight extras

- **Tracker** — admin page and API proxy for the Reddit listing monitor, with a
  fleet status filter and infinite scroll (v1.64.0, v1.65.0).
- **Coordinator** — Facebook tracker page with live fleet, review stats and a
  filter prompt (v1.83.1).  The fleet view shows one row per Facebook account
  (liveness, state, session days left, last search, heartbeat, the week's
  alerts from its cities, the vault login and Facebook user id, expandable to
  cities, secrets by name, browser identity, backup age, proxy, session file
  and pacing), the literal search phrases per item with their title gate and
  reject rules, the shared search settings, a coverage map of every centre
  lit by whichever worker searches it now, and each worker's build; one
  search box filters accounts, cities and phrases at once.  The data is the
  rs-console facade's `/v1/fleet` document through the manager-only
  `/api/coordinator` proxy — until that facade is deployed the cards read
  "fleet view unavailable" and the rest of the page works (v1.140.0).

## MCP and OAuth connectors

`/api/mcp` is Bearer-only and CSRF-exempt. Tools: market read/write, sellable
inventory search, sell-order draft creation.

- Connectable from both Claude and ChatGPT (v1.46.0).
- **Interactive consent lets the user choose which permissions a connector
  gets** (v1.48.0), ceilinged by role: a manager can grant any scope, everyone
  else keeps `market:read` only (v1.67.x). Manager-minted service clients are
  exempt.
- Purchasers can reach the connect page (v1.66.0).
- Per-tool gating lives in `TOOL_SCOPES` and filters both `tools/list` and
  `tools/call` — a connector missing tools has a scope problem, not a missing
  tool.
- Tool failures answer as normal results with `isError: true`, not JSON-RPC
  errors; only protocol failures are errors. Every tool ships MCP
  `annotations`, without which clients label read-only tools destructive.
- DCR is open by default, rate-limited per IP and globally.

## AI scanning and OCR

- **Label scanner for SSD lines**, gated by `categories.ai_capture` (v1.96.0),
  with high-res capture and client-side MozJPEG compression (v0.1.1).
- Mobile QR/serial scanning: a button on the serial-number field (v1.83.0),
  single-shot — capture, confirm, auto-close (v1.83.2).
- **Serials are chips, in both shells** (v1.126.0): scanned, typed or pasted,
  each one deletes whole via its `×` or a two-step Backspace. The stored value
  is unchanged, and text typed but not yet chipped still counts toward the
  DDR5 / count-vs-qty rules.
- The scanner **says so when AI recognition is unavailable** and names the
  escalation (v1.97.2), and won't take a purchaser's name for a RAM brand the
  model couldn't read (v1.106.0). The confirm dialog's photo **opens
  full-screen** on tap, and the prompt **stops once a real brand is picked** in
  the line's own Brand select — `Other` and off-catalog still ask (v1.126.0).
- An item's specs are editable from the item itself, and a **blanked dropdown
  clears the field** — including the numeric ones, RPM and health (v1.114.1).
- Receipt auto-rename runs only on images, never spreadsheets or PDFs.
- **A scan that times out retries itself once** before showing the field an
  error (v1.123.1). A slow turn used to surface on the phone as "OCR failed",
  and the human re-shot the same label. Only timeouts retry; an error from the
  model still fails immediately. Every attempt on one scan shares a single
  45-second budget, so a scan cannot spend two full timeouts on the model.

> Provider selection is silent: OpenRouter (Gemma 3 27B) when
> `OPENROUTER_API_KEY` is set, otherwise a deterministic stub. A prod deploy
> missing the key looks healthy and quietly stubs.

## The three shells

One bundle, three lazy-loaded shells chosen in `App.tsx`: a vendor token in
`/v/<token>` → `VendorApp`; viewport under 720px → `MobileApp`; else
`DesktopApp`.

- The desktop shell runs down to 720px. **Under 900px its sidebar folds to a
  64px icon rail** (v1.134.0) — brand mark, nav icons with their names on
  hover, avatar and sign-out — where it used to disappear and leave a
  split-screen window with no navigation at all.
- **Menus and record references are real links** (v1.144.0). The sidebar,
  the Inventory ▸ Analysis strip, the phone tab bar and Home quick links, and
  every PO, sell-order or payment id shown on another page — the inventory
  lots table, the item page, payments rows and match suggestions, shipping,
  vendor bids, the sell-order list, the client drawer — are anchors with the
  hash written out. A plain click still routes in place (the back button keeps
  working); ⌘/ctrl/middle-click and "Open in new tab" open the record in a
  new tab. The PO page's "Open payments" lands on the list focused on that
  PO. Sell-order links stay desktop-only: the phone shell has no sell-order
  route.
- The mobile shell is a **PWA** with install onboarding, a service worker and a
  share target, scoped to mobile only (v0.1.1).
- Mobile PO lists colour-code warehouse, status and owner with stable hashed
  hues (v0.1.3).
- On mobile, the PO edit screen **docks the four category add-targets above the
  action bar** (v1.109.0), so adding a second item no longer means scrolling
  past every item already on the order — the screen reopens at the top after
  each line, which made the in-flow row recede a little further with every use.
- All strings go through `useT()`; the app ships English and Chinese.
- User preferences (theme, list-view modes) flow through `lib/preferences.tsx`
  and persist server-side.
- **A deploy no longer breaks tabs that were already open** (v1.121.1). A
  content-hashed chunk that a release has replaced now 404s instead of being
  answered with `index.html`, and a tab that asks for one reloads itself once
  onto the current build rather than stalling on a skeleton.
- **The load starts before the bundle does** (v1.122.0). A small boot script,
  injected ahead of the entry, preloads whichever shell the viewport is about
  to need and starts `/api/me`, `/api/lookups` and `/api/workspace` — none of
  which needs React — instead of leaving all four to be discovered after 255 KB
  of JavaScript has parsed.

## Observability

- Unhandled 500s write JSONL to `ERROR_LOG_DIR/errors.jsonl`, rotating at
  10 MB.
- **Client-side failures are reported** rather than lost: `ApiError` carries
  path, method and the backend's `X-Request-Id`, and `POST /api/client-errors`
  writes one greppable JSON line to stdout — capped at 5 per page load, deduped,
  and with vendor-portal tokens redacted (v1.105.0).
- **Load timing is reported too** (v1.122.0): `POST /api/client-timings` takes
  navigation timing, LCP, and the request/refresh counts for the page load, one
  report per load. Numbers only, no paths — it is the answer to "the page feels
  slow", which until then had no evidence behind it either way.
- `/api/health` reports version, build date, commit and provider modes.
