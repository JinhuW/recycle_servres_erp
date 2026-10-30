# What the ERP does today

`CHANGELOG.md` says when things changed. This says what exists **now**, by
area, with the version each behaviour arrived in so you can read the entry
that introduced it.

Written for whoever — human or agent — has to change this system without
having watched it get built. It describes behaviour, not implementation:
`AGENTS.md` (root, plus one per area) covers conventions and tripwires, and the route files are the
source of truth for endpoints.

Keep it current: when a change adds, removes or reshapes user-visible
behaviour, edit the bullet here in the same PR and cite the new version.

## Words this file and the app use (v1.236.0)

- **Product** — a numbered row on a purchase order: one part bought, in one
  condition, at one cost. On a sell order, a product is what the packer
  labels: its lots share one `#`.
- **Product `#`** — a product's id on its order. Given when the product is put
  on the order, never changed or reused (POs since v1.234.0, sell orders since
  v1.235.0). "N products" counts `#`s.
- **Lot** — one inventory row: a PO product's units in one warehouse. A
  partial transfer splits a product into two lots under its one `#`. A sell
  order's rows are lots.
- Inventory's grouped view keeps **Product** for the same goods across POs —
  a part number with its lots under it.
- Not renamed: **Item type** (the Other category's attribute), **Extra item**
  (goods in the box that are not on the PO), physical **units** (件), and
  "line" where it means a line of text (serial numbers, address line 2).
- Code and the API keep their names: `order_lines`, `sell_order_lines`,
  `lines`, `addLines`, `lineCount`, `sourceLineNo`, the `line_*` event kinds.
  Chinese uses 产品 for a product and 批次 for a lot.

---

## Roles and access

Two roles: **manager** and **purchaser**. The unauthenticated vendor bid
portal was removed in v1.191.0; no bid had ever been placed through it.

- Managers see everything. Purchasers see the buying side — Home, Analysis, submit,
  history, shipping, clients, market, settings — and their own POs.
- Desktop role gating is three-layered: the sidebar's `roles` list, a
  `DesktopApp` view bounce, and in-page filters. Missing one leaves the view
  invisible rather than forbidden.
- **The API enforces every manager-only view, not just the UI.** A
  non-manager's JSON never carries a manager-only key — not even as `null`,
  since the name alone would advertise the feature. Whole-endpoint manager
  features (sell orders, customers, transfers, activity, members,
  bank and internal transactions, the RMB Flow (v1.310.0, named Accounting until v1.317.0), tracker,
  the WeChat market (v1.312.0), coordinator, connectors, FX rates, inventory export and analysis, a line's
  linked sell orders) answer 403. The
  Facebook account pool (`/api/facebook-pool`, v1.262.0) is the exception
  under Monitors: every role reads the rack and may take, return and report,
  while add, import, edit, retire and remove answer 403 to a purchaser;
  each account's sealed secrets — password, 2FA key, email password, session
  cookie and, from v1.307.0, the Facebook access token — are revealed only to a
  manager or the purchaser currently holding it; shared reads are scoped to the
  caller's own rows and leave the manager-only fields out: the PO figures `finalSellPrice`, `finalSoldQty`, `realized` and
  `sellOrders` (v1.177.1), and the linked-payment total, the pending
  change-review, the leaderboard peers' money and email, the warehouse
  manager's contact, and the sell-order ids in an edit refusal and the
  archive log line (v1.177.2), and the bank-link count on a saved or handed-off
  PO (v1.177.3 — a purchaser who saves a matching PayPal id now sees a plain
  "Saved", not "its bank payment is now linked"). "Non-manager" is the
  *effective* role, so a manager previewing as purchaser gets the purchaser
  shape — including on the advance and warehouse write responses (v1.177.3).
  Two deliberate exceptions: the 403s gate on the real role, since the
  preview is a viewing convenience, and the inventory reads (`/api/inventory`,
  `/products`, `/:id`, `/events/*`, `/export`) scope rows and strip cost on the
  real role too, so a previewing manager keeps the whole inventory.
- Auth is httpOnly cookies — a 60-minute `at` JWT plus a rotating `rt` refresh
  family (the access token was 15 minutes until v1.122.0, which made four out
  of five app loads open with a 401, a refresh and a retry before painting).
  No localStorage, no bearer tokens. Refresh-token reuse revokes the whole
  family. **Tabs refresh one at a time** (v1.200.0): the refresh runs under a
  `navigator.locks` lock, and a tab that sees another tab refreshed after its
  request began retries instead of presenting the rotated token. Two tabs
  waking together used to revoke each other's session.
- **Changing your password keeps you signed in** (v1.191.0) and signs out every
  other session. Until then it signed you out too, up to an hour later: the
  `rt` cookie is scoped to `/api/auth`, so `/api/me/password` never saw it and
  revoked every refresh family. The access token now names its family (`fid`).
- **A password change or reset ends every other session at once** (v1.193.0).
  `users.tokens_valid_after` is stamped, and any cookie access token or OAuth
  bearer token issued before it is refused (they used to keep working for up to
  60 and 15 minutes). The person changing their own password re-authenticates
  through one silent refresh.
- **Sign-in locks an email after 5 failures in 15 minutes, and a client IP
  after 30** (v1.195.0). Each attempt reserves its row before the password is
  checked, so parallel guesses can't all read "0 failures": 20 at once record
  at most 5. Refused attempts don't lengthen the lock. The per-IP lock counts
  across emails and only runs once the Worker's `X-Client-IP` is present.
  Password hashing runs at most 4 at a time; a caller that queues longer than
  5 seconds gets a 503 with `Retry-After`.
- Every mutating request carries `X-Requested-By: recycle-erp`; the CSRF guard
  drops it otherwise. Exempt: safe methods, `/api/health`, and `/api/public/*`
  (the website intake and quote forms and the Shippo webhook, none of which
  use cookies).
- Managers can reassign a PO's purchaser until it is Done (v1.84.0) and submit
  a PO on behalf of one (v1.82.0). The owner can be any active member,
  managers included — the picker lists purchasers first, then managers
  (v1.131.0).

## Getting started (purchasers)

- **A new purchaser gets a walkthrough on first sign-in** (v1.299.0), on both
  shells. Nine steps cover the home numbers, adding products (Submit order on
  desktop, the camera button on the phone), Mark as In Transit and what it
  asks for, the payment proof for Company card PayPal, Company card cash and
  Self-paid, the manager review and the edit window until Ready to Pay, the
  commission formula with a worked example, and the buying tools. A step with
  a place in the app spotlights it: the sidebar item on desktop, the tab-bar
  item on the phone. The card switches between English and 中文 in place, and
  the last step opens Submit or the capture flow.
- **Who gets it automatically.** A purchaser (the real role, so never a
  manager previewing as one) whose preferences lack `onboarding.done`.
  Finishing or skipping sets it, server-side, so it doesn't reappear on
  another device. Migration 0186 set it for everyone who had already signed
  in, so only members who never had get it.
- **Replay.** The Guide button in the desktop top bar, for every role, and
  Profile › Getting started on the phone. The phone's install card stays
  hidden while the walkthrough is open.

## Purchase orders

The core object. A PO is a purchase from a vendor, built line by line, that
moves Draft → In Transit → Reviewing → Ready to Pay → Done ("submitted" is
the event written when it leaves Draft, not a stage). Sold
is not a stage but a flag beside one, set once every line has sold
(v1.246.0).

- **Every product on a PO has a `#` that never changes** (v1.234.0). It is
  given when the product is put on the PO — a new PO numbers its products
  1..n in the order they came, and each one added later takes the PO's next
  `#` — and stored (`order_lines.product_no`), not worked out from the list.
  - **Removing a product leaves a gap.** `#1, #2, #3` with #2 removed reads
    `#1, #3`, and the next product added is #4: a `#` is never handed to
    another product, not even on a Draft.
  - **A partial transfer keeps its `#`.** The units moved to another warehouse
    become a second row with the source's `#`, so the PO page shows `#3`
    twice, each with its warehouse, right after each other. Discarding the
    transfer folds it back and leaves no gap. The second row keeps the
    source's Chip # too (v1.237.1).
  - **"N products" counts `#`s**, so the PO list, the page head and the
    category groups count a transferred product once.
  - A product not saved yet reads *new 1*, *new 2*… (in list order) where its
    `#` would be, and messages name it the same way with what it is ("New
    product 2 (M393A4K40DB3-CWE)", v1.236.0) until the save gives it a `#`.
    Saved products are named by `#` — "#5 is missing: Generation", "This
    Part # is already on #2, #7" — never by their place in the list. A
    transfer's two rows of one product are not flagged as a duplicate part #.
    The server names a product not saved yet the same way when it can: a new
    PO arrives with every row in list order ("new product 2
    (M471A2K43DB1-CWE): Laptop doesn't fit RDIMM"). A product added to a PO
    may arrive alone, so it is named by what it is ("new product
    (SSDSC2KB960G8): …", v1.236.0).
  - The `#` is the same on the PO page, the phone's Products screen, Review
    mode, the PO list's drawer, the PO workbook (a leading `#` column on every
    sheet, v1.234.0), each sell order's "From PO-1432 #3", Inventory and the
    sellable picker. Products that existed before v1.234.0 kept the number
    they showed.
  - Transfer refusals name the product the same way ("PO-1432 #3 only has 5
    units"), as does a sell order a lot can't go on.
  - **Everything says "product"** (v1.236.0) where it used to say line, line
    item or item: the PO and sell-order pages, the phone screens, Review and
    Pack mode, the activity log, error messages, and the PO workbook. Its
    sheet is *Products*, its cost column *Cost total* and its payment row
    *Subtotal (product costs)*. Chinese says 产品 throughout. See the word list
    at the top of this file.
- **One PO can hold several categories** (v1.54.0), with its lines grouped by
  category and a per-category cost breakdown (v1.55.0).
- **A new PO starts at a 50% commission rate** (v1.166.0). The column
  defaults to `0.5`, so a PO made anywhere — desktop form, phone capture, a
  package turned into a PO — carries 50% until a manager changes it. POs
  that existed with no rate keep NULL (read as 0%), and a manager clearing
  the rate still lands on NULL.
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
  cards — each leading with the line's first photo beside its number, the
  rest in a strip under the chips (v1.170.1) — the add-category dock and
  the goods total; the line form opens from there and returns there —
  at the bottom after adding a line, on the line after editing one, and at
  the top when opened by link; a round button above the dock jumps to the
  bottom or back to the top once the list outgrows the screen (v1.202.0). A
  line removed on one screen is already gone on
  the other, unsaved fields survive the round trip, and the "back to Draft"
  warning is asked once per visit. The capture flow's **Review screen is
  the product list and nothing else** (v1.169.0): header, the line cards or
  the empty state, and the RAM / SSD / HDD / Other targets docked above
  Cancel / Submit so they stay put as the list grows — no cost card, no
  folds (v1.166.0's kind-of-item sheet came and went). Submit sends the
  lines only and opens the PO's own page, not the Orders list (v1.166.0),
  whose folds own warehouse, payment, notes and fees. Desktop
  keeps its single edit page; a
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
  the only forward click; a stage beyond it stays locked. **A move is written
  on the click** (v1.227.1): *Mark as ‹stage›*, the stepper's next step, *Move
  back* and the Done dialog's Confirm save the move right away, along with any
  other unsaved edits on the page. A move that is cancelled or refused leaves
  the page on the stage the order is at. After a stage move the page **stays
  put** on the new stage's panel instead of returning to the list. Below the
  status card, **five tabs**: *Delivery* (source, receiving warehouse, shipping
  label or local pickup, tracking number with the carrier recognised from its
  shape, or who collected it, plus a one-line live tracking state — laid out
  one fact per row since v1.172.1: source, then warehouse, then the delivery
  switch beside what that choice needs, a hairline between them), *Cost
  Payment* (paid by — the Business Account, or the person who paid, since
  v1.317.0 — method, transaction ID, proof files, the manager's
  bank-payments ledger and the Accounting card — named *Payment* until
  v1.163.0, when the second payment below got a home), *Commission* (purchaser, rate, and what the
  purchaser earns — the maths that used to sit in an aside titled "Payment
  detail" — and **Commission payment**, v1.345.0).
  Managers choose **RMB Flow** or **Business Account**. **RMB Flow** offers
  **Create payment** and its recorded commission payments (v1.345.1, RS-397), without
  transaction search. A short hint explains that the PO is already linked;
  the primary action has a larger phone touch target. Create opens the payment form with this PO's commission
  selected, including its order/AI amount sources. Saving refreshes the ledger
  and payer. **Business Account** searches unlinked, settled outgoing USD
  Mercury/PayPal transactions and confirms a selected transaction to link it
  as the commission. Transfers, ignored rows and internal transactions are
  excluded; a bank row already linked is refused if a search result becomes
  stale. The payer follows the RMB entry's manager or the Business Account.
  A live bank commission must be unlinked in Payments before a paid-out RMB
  commission can be created. Linking the Business Account voids existing
  paid-out RMB commission entries under the book's existing rules.
  The panel shows linked bank payments and their net, with links to Payments
  on desktop. Existing commission screenshots remain readable; the old payer
  select and upload box have been replaced by these two source options on
  both shells. Purchasers see the payer and legacy screenshots read-only.
  **Ready to Pay → Done recognizes linked payments** (v1.345.0): a live
  paid-out RMB commission or settled outgoing bank commission skips the
  screenshot prompt, as an existing screenshot already did. With neither,
  the Done dialog still offers its legacy screenshot upload and optional note;
  it remains a prompt, and Confirm works without a screenshot. A legacy
  screenshot upload can record its uploader as payer when nobody is on file,
  or offer a confirmed change to the uploader when someone else is recorded
  (v1.302.0). Commission payer changes are recorded in Activity.
  *Notes & files* (notes and Submission receipts; proof of payment is not
  repeated here), *Activity*. No fact has an input in two places any more: the
  warehouse, purchaser, rate and paid-by that appeared in *Order details*,
  the hand-off dialog **and** the aside each live under one tab. Tabs carry an
  **amber dot** while a Draft still needs something under them and a **blue
  dot** for unsaved edits; the open tab rides in the URL
  (`#/purchase-orders/PO-1?tab=payment`) so a link lands on it, and the
  stage suggests one otherwise — Delivery while In Transit, Commission at
  Ready to Pay — until the user picks another (v1.161.1). A sticky
  footer holds the total cost, what the purchaser earns, *Unsaved edits: …*,
  Discard and Save. Save greys out while nothing is unsaved, including right
  after the checkpoint moves the PO, and its tooltip says why. With unsaved
  edits it stays clickable even when something blocks the save, and the
  click lists what to fix (v1.203.1). **Delivery facts are the page's to edit until Ready to
  Pay**: source, pickup or label, collector and tracking number save through
  the order like any other field; a purchaser's change past Draft is
  material — back to Draft for the manager's change-review — and a new
  tracking number moves the linked package rather than minting a second one.
- **The phone PO page carries the same stage panel and a Delivery fold**
  (v1.161.0). Its status card keeps the two-screen structure of v1.154.0;
  under the dots, In Transit shows the linked package's Shippo journey with
  **Refresh** (or who collected a local pickup), and a finished dot, tapped,
  swaps the card body for what that stage recorded, with a way back. The
  *Before you submit* list gains a *How the goods get here* row.
- **The phone's *Order details* are the desktop's five tabs, as folds**
  (v1.162.0): Delivery (source, warehouse, label or pickup, tracking),
  Cost Payment, **Commission** (RMB Flow Create / Business Account transaction search
  under the maths since v1.345.1; the summary reads *· Paid* once a linked
  payment or legacy screenshot is on file), Notes & files, Activity —
  same order, same names.
  Each is one card (`PhFold`): closed, the title with its answer read back;
  open, a tinted header ruled off from the fields in the same card. An amber
  mark means the next step is waiting on the section, a blue one that it has
  unsaved edits. Commission is a manager's to edit until Ready to Pay and
  read-only for everyone else, with the projected earnings under it; the
  Cost card no longer repeats the rate or the PayPal id. The stage opens its
  fold (Draft → the first amber one, In Transit → Delivery, Ready to Pay →
  Commission) and any fold can be opened by hand. (The **Review order** step
  of the capture flow carried the same folds and Cost card from v1.162.0 to
  v1.169.0; it is products-only now.) On the phone, a manager's Reviewing →
  Ready to Pay opens a **Commission sheet** — Delivery and Payment read back
  as ✓ rows, purchaser and rate to confirm — that saves and advances in one
  tap.
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
  count. Desktop list: Unrealized rides the Profit column toggle; Realized
  has its own **Realized profit** toggle in the Columns picker (v1.171.0),
  on by default and offered to managers only — until then it hid with
  Profit. PO edit page: a realized block on
  the cost tape with a sold meter. Phone: the money card carries both and the
  list row a Realized line. Purchasers and a manager previewing as purchaser
  get none of it — since v1.177.1 the API leaves the `realized` and
  `sellOrders` keys out of their responses rather than sending null.
  Other fees amortize over the PO as bought (`qty_purchased`)
  from the same release, so a partial sale no longer moves the fee share.
- **Managers see each line's final sell price** (v1.147.0): the qty-weighted
  unit price over the Done sell orders that name the line, with the sold
  count after it when a partial sale left units on the PO. It sits beside
  "Sell / Unit", which stays the projection that feeds commission. Computed
  on read from sell orders, never stored or editable; purchasers and a
  manager previewing as purchaser get neither the column nor the value, and
  since v1.177.1 not even the `finalSellPrice` / `finalSoldQty` keys in the
  API response.
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
  only: it can't be written as a line status. One field survives the lock:
  a manager can still change a line's **sell price** from the desktop PO
  page's line drawer while the PO is at Ready to Pay, so the commission
  projection can be corrected during payment review; Save stays on the PO
  (v1.191.1).
- **Sold is a flag beside the stage, not a stage** (v1.246.0). A PO at In
  Transit, Reviewing, Ready to Pay or Done whose every line with units is at
  the `Sold` line status is sold; a Draft never is. Nobody sets it: it is
  read off the lines each time (`soldFlagSql` in `services/orderSold.ts`), so
  a line added, transferred, re-counted or walked off Sold changes it with
  nothing else to do, and the stage never moves because of a sale. A PO that
  sells out at Ready to Pay is "Ready to Pay · Sold" and still waits for the
  commission; reaching Done it reads "Done · Sold".
  - **Where it shows.** A Sold badge beside the stage pill on the desktop and
    phone PO lists and beside *Order status* on both PO pages. The desktop
    list's stage chips count every PO under its real stage, and a separate
    Sold); the phone has a Sold chip after the stages. The Sold chip's count
    includes Done POs before it is clicked, and is what the click shows
    (v1.247.1). `GET /api/orders` takes `status=Sold` as the flag;
    `excludeStatus=Sold`, which an older phone bundle sends beside Done,
    excludes nothing (v1.247.1). `status=Done` means the stage, sold or not.
    The spreadsheet's Status cell reads `Done · Sold`.
  - **Managers only.** `sold` is sent to managers alone; everyone else,
    a manager previewing as a purchaser included, gets no key and an empty
    Sold filter. A Sold chip left on drops when the desktop list is
    previewed as a purchaser, instead of emptying it (v1.247.1).
  - **Before v1.246.0** Sold was a lifecycle after Done (v1.164.0): the
    desktop chip rail split Done in two and the inventory editor refused to
    walk a line off Sold. Migration 0173 moved those POs back to Done; their
    old `Done → Sold` activity rows are no longer shown, on the PO or on the
    Activity page (v1.247.1), and a reopen from Sold reads as one from Done.
    A `sold` written after 0173 — by the old instance still serving through
    a deploy, or after a rollback — lands as `done` (0174, v1.247.1).
  **The Sold-out panel names the sell orders that sold it** (v1.174.0): each
  Done sell order naming one of the PO's lines is shown with its customer and
  units, and on desktop it links to the sell order. On the desktop PO page it
  sits above the stage panel at whatever stage the PO is sold (v1.246.0); the
  Done panel shows the same list while the PO is only partly sold, and the
  phone lists the ids beside the sold count. Managers only.
- **Any manager takes a PO into Reviewing and Ready to Pay, whatever its
  warehouse** (v1.168.0). The v1.132.0 rule that reserved those two moves for
  the manager linked to the PO's warehouse is gone, on both shells and in the
  API; the warehouse's manager in Settings is a contact, not a gate.
- **A PO has a manager: the manager who took it into review** (v1.203.0).
  - **How it is set.** A manager who moves a PO with no manager into
    Reviewing, Ready to Pay or Done becomes its manager, without being
    asked.
  - **Taking over.** When a *different* manager later moves the PO, forward
    or back, a dialog asks first: *‹X› is the manager of PO-n*. There are
    three choices:
    - **Make me the manager** moves the PO and takes it over.
    - **Keep ‹X›** moves the PO and leaves X in charge.
    - **Cancel** moves nothing.
  - **Where it asks.** Every door that moves a PO asks the same way:
    - the desktop PO page's Save
    - Review mode's *Move to Reviewing* and *Approve for payment*. One
      review-mode visit asks once: *Keep ‹X›* given on the way in carries to
      Approve while X is still the manager (v1.203.2).
    - the phone's next-step button, whose answer rides through the Ready to
      Pay and Done sheets
  - **A page that is out of date still asks the right question** (v1.203.2).
    Each move sends the manager the page showed. If another manager has taken
    the PO since, the server refuses the move, the page asks about the
    manager it named, and then moves.
  - **Where it doesn't ask.** The hand-off (Draft → In Transit) never asks.
  - **It sticks.** The manager stays through a send-back to Draft, so a
    re-submission returns to the same manager. It changes only through a
    takeover; there is no picker.
  - **Only while still a manager** (v1.203.2). A user who is demoted or
    deactivated stops counting. Their POs read as having no manager, and the
    next manager move stamps the mover without asking.
  - **Who sees it.** Everyone, purchasers included. It shows as *Manager
    ‹name›* in the desktop PO header and in the phone Order status card.
  - **The record.** Each set or takeover is a *Manager changed* entry in the
    activity log, right after the move that made it.
  - **Existing POs** were filled in from history: each got the manager who
    last moved it into Reviewing or, failing that (v1.203.2), into Ready to
    Pay or Done. Only users who are still managers count. POs a manager
    jumped straight from Draft have no such record, so they start empty and
    fill in on their next manager move.
- **Review mode: a manager counts a PO against the box that arrived** (v1.188.0,
  desktop only; called *Box check* until v1.189.2). **Review mode** in the PO
  page header, primary at Reviewing and present at every stage, opens `#/purchase-orders/<id>/check`: a full-width
  page with no sidebar.
  - Each row of the desktop PO list has its own Review mode button (package
    icon, left of the download button), for managers only. It's hidden in
    purchaser preview (v1.201.0).
  - Opening it on a Draft or In Transit PO asks *Move PO-n to Reviewing?*,
    because Approve is only offered at Reviewing (v1.201.0). The choices are
    **Move to Reviewing** (moves the PO, then opens), **Open without moving**,
    and **Cancel**.
    - Reviewing and later stages, and archived POs, open with no question.
    - The question names the stage in the reader's language, from the PO's
      lifecycle (v1.202.1).
    - Only the stage the question named moves. The server checks it under the
      row lock (`fromStage`, v1.202.1). A PO that has since passed Reviewing
      just opens. One sent back to Draft is asked again, and the list row or
      PO page shows its real stage.
    - Moving a Draft needs everything the hand-off would have collected:
      source, delivery, tracking, payment method and the proof rules
      (v1.202.1). A Draft missing one stays Draft, and the server says what is
      missing.
    - A move the server refuses, such as the proof rules for leaving Draft,
      shows its message, and the page stays put.
  - Opening and leaving the check re-reads the PO, so neither page works from
    the other's stale copy. A PO page with unsaved edits refuses to open it
    (v1.189.1).
  - Each row carries its product's `#` on the PO (the stored one since
    v1.234.0, so regrouping the rows never touches it), and a RAM row shows
    its device type (Desktop / Server / Laptop) beside the class, rank and
    speed chips (v1.190.0).
  - Every line's count starts at its full qty (v1.188.1). Ticking the
    checkbox confirms the line at the count it shows, and a ticked line sinks
    below a *Checked* divider, newest first, with an Undo.
  - Checked is its own state, never inferred from the count. Lowering a line
    with − turns it amber and takes its tick away; ticking it then confirms
    the short count (v1.190.0). Finish review lists the lines checked short.
  - **The count can be typed as well as stepped** (v1.260.0). Clicking the
    number between − and + selects it. Enter or leaving the field saves it,
    and Escape restores it. The count is held between 0 and qty and meets
    the same rules as −, and − / + still step it; inside the field the + −
    keys step the typed number. A switch to another window
    mid-edit saves nothing. A scanner firing into the field goes to the scan
    box instead.
  - **A line lowered to 0 is *Not in the box*** (v1.212.0). It shows in red
    with its own legend chip, not as partly counted. It still needs its own
    tick, and the row keeps the tag once ticked.
  - **Edit** (pencil, or lowercase e) opens the PO page's line drawer on that
    line, so the manager fixes the specs, qty or cost to what actually
    arrived. Confirm writes it with the same rules as the PO page (brand
    confirmation, required fields, serial checks). An edit that changes the
    qty clears that line's tick, since the new units were never counted
    (v1.190.0). Photos are still edited on the PO page.
  - Flags, extra items and *Send flags to purchaser* are gone (v1.190.0):
    a problem is fixed with Edit instead of reported. Past
    `box_check_flagged` events still show in the PO history.
  - **Check all remaining** ticks every line still at its full count, and a
    line already at qty 0 (v1.213.0). It leaves amber and red lines for their
    own tick.
  - The scan box takes a label scanner. It matches an exact part number, then
    a prefix, then a recorded serial, then any part number holding the text
    (v1.222.0), and ticks the line it lands on at its count. A scan goes to a
    matching line still open first, then an amber one. A prefix that fits
    lines with different part numbers ticks nothing and names them. A scan
    that lands on a line counted 0 ticks nothing and asks for the count to be
    raised first (v1.212.0). On a line already at qty 0 it says so instead:
    only an edit can put units back (v1.213.0).
  - **Typing in the scan box filters the list** (v1.222.0).
    - Once typing pauses (150 ms), only the lines Enter could land on stay:
      a part number holding the text anywhere, ignoring separators and case;
      one a label extends; or a whole recorded serial. A scanner's burst ends
      in Enter inside the pause, so a scan never flashes a filter.
    - Enter follows the order above, so the filter can show two part numbers
      while Enter ticks the exact one (`M393A4K40DB3` beside
      `M393A4K40DB3-CWE`).
    - A fragment that fits several part numbers ticks nothing. The text and
      its list stay up, the box lets go so ↑↓ and Space pick a row, and the
      message names the first five parts. Space, + − and e ignore a selected
      line the filter hides.
    - × clears the filter. Escape in the box clears the text and then
      leaves the box. On the page, Escape clears a leftover filter before it
      leaves Review mode.
    - The filter changes only the rows shown. The tally, Finish review and
      Approve always count the whole PO, and *Check all remaining* is
      disabled while a filter is up.
  - A scan works with nothing focused: a character typed onto the page that
    is not a shortcut starts the scan in the box, so a label never runs as
    shortcuts. The shortcuts are ↑↓/j k, Space, + −, lowercase e and /; a
    scanner sends uppercase. Escape closes the drawer or a dialog first
    (v1.189.1).
  - Progress is saved on the server (`order_line_checks`), so a reload or a
    second manager sees the same count. Last write per line wins; there is no
    live sync. Nothing can be changed until the saved count has loaded, and
    changes still waiting to save go out when the page is left (v1.189.1).
  - Once every line is checked, **Approve for payment** at Reviewing moves
    the PO to Ready to Pay (re-reading the stage first). Short lines don't
    block it.
  - **Approving prints the box's label** (v1.327.0, RS-378). It is drawn
    and printed as Pack mode's labels are (see *Sell orders* → *Each packed
    product prints its label*), and prints before the page leaves for the PO
    page. It reads
    *Purchase order · <warehouse>*, the date, the PO number, *Purchaser
    <the PO's purchaser>*, and the counts: the products with a unit counted,
    by #, and those units. A line counted 0 is in neither.
    - It goes over Bluetooth when the label printer is on, else through the
      print dialog. *Print when approved* in the label settings turns it off.
      It is Review mode's own setting (`review.labelAuto`, v1.329.0, RS-382);
      until then it was Pack mode's (`pack.labelAuto`). Approve stays busy
      until the label is out (v1.332.2, RS-389). Before that it came back
      while the label printed, and a second click tried to approve a PO that
      had already moved.
    - The page head carries Pack mode's printer bar: status, Connect, Print
      label and the settings menu, whose button shows *Auto* or *Manual*.
      Both pages share one connection, the stock and the language. A refused
      or cancelled approval prints nothing.
  - **Lines ticked at 0 are set to qty 0 on Approve** (v1.213.0; in v1.212.0,
    which never reached prod, Approve deleted them). They stay on the PO, so
    every line keeps its `#`.
    - Finish review lists them and the button reads *Set n to 0 & approve*.
      A line already at qty 0 isn't sent again.
    - They are zeroed first, through the PO page's own line PATCH, and then
      the PO moves. Ready to Pay is closed-book. A line committed to a
      Shipped or Awaiting-payment sell order can't drop below that, and then
      nothing moves.
    - If the move is refused or a manager re-ask is cancelled, the lines stay
      at 0, and the page re-reads the PO with the PO still at Reviewing.
    - A goods total that follows the lines drops by their value. A negotiated
      lot price stays, and Finish review warns about that.
    - When every line is at 0, Approve is disabled: nothing arrived, so there
      is nothing to pay for.
    - Only Review mode's Approve zeroes them. Moving the PO from the PO page
      or the phone leaves 0-counted lines at their full qty.
  - **A payment that doesn't match the total cost is called out** (v1.225.0).
    See *A manager is warned when the bank paid something other than the
    PO's total cost* below for the banner and the question at Approve. Here
    the comparison is against the total the PO will have after Approve, so
    ticking a line at 0 can raise the warning or clear it before the click.
  - The side panel (the selected line and Finish review) stays beside the
    list as it scrolls and is never taller than the window; on a short screen
    it scrolls by itself (v1.230.1). At 1100px wide and below it drops under
    the list.
  - The endpoints (`/api/orders/:id/checks…`) 403 anyone whose real role is
    not manager. The page and button are hidden from a manager previewing as
    purchaser, and the route bounces them without leaving a Back entry
    (v1.189.1).
  - **Review mode prices the PO for the commission** (v1.296.0). Each row
    has a *Sell / Unit* field beside the count: the line's sell price, the
    projection the commission is paid on. Enter or leaving the field saves
    it straight to the line (the inventory line PATCH, audited as `priced`),
    Escape puts it back, and a blank unprices the line. A comma counts only
    as a thousands separator (v1.310.1), so `12,50` is refused rather than
    saved as 1250. Lowercase `p`
    focuses the selected row's price; the key legend says so.
    - An unpriced line whose part number is on the Market board shows the
      board's value as a ghost in the field — the last recorded price, else
      the average sell, else the team's own 30-day average, the same figure
      the line drawer offers as *Suggested sell* — and Enter on the empty
      field takes it, as does the *Use $n* link under it. **Fill from
      market** in the tally bar prices every unpriced line that has a value
      in one click and says how many it priced.
    - A priced row shows its margin under the price; one priced below cost
      reads *below cost* in red and the save toasts a warning.
    - The tally bar's right half counts the priced products with its own
      meter and shows **Purchaser earns** live, by the Commission tab's
      formula (goods or negotiated lot price plus fees, revenue over priced
      lines, the rate, the cost back on a self-paid PO) and over the qty
      Approve will leave, so a line ticked at 0 earns nothing.
    - A **Commission** card in the side panel carries the rate (editable at
      Reviewing and earlier, read-only once the book closes at Ready to
      Pay), revenue, cost with the fee broken out, profit, commission and
      the total, with the unpriced count. The Compare card shows the
      selected product's sell price, its market reference with the basis
      and age, and the final sell price once it has sold. Finish review
      lists the unpriced products, which count as $0 until priced; they
      don't block Approve. The pure maths lives in `lib/reviewPricing.ts`.
  - **A sell order sheet prices the PO** (v1.313.0, RS-347). Drop the
    buyer's filled sheet (`.xlsx`) anywhere on the product list, or pick it
    with **From sheet** beside *Fill from market*; while a file is dragged
    over the list the shared dropzone shows. Only the Part Number and Unit
    Price columns are read, by the Market import's reader, and each PO line
    is matched by canonical part number — every line with that part gets
    the price. Nothing is written until **Apply**.
    - While the sheet waits, one strip in the list's head (where the scan
      hint was) holds the file, a **USD / CNY** switch that re-reads the same
      file (a price that names its own currency keeps it), the FX ledger's
      rate when yuan were converted, the counts — to apply, repriced,
      unchanged, kept, skipped (hover for not in the sheet / can't be matched
      / parts the sheet prices that this PO lacks) — and **Cancel** /
      **Apply n prices**. Escape cancels it; counting keeps working. Another
      file dropped meanwhile is refused; Cancel first (v1.313.1).
    - Each row says what the sheet would do: the incoming price in blue,
      with the yuan and the sheet row under it; a typed price it would
      replace struck through beside it, with **Keep $x** to hold that one
      out of Apply; *Already at the sheet price*; *Not in sheet*; or why it
      can't be matched — no part number on the line, no price or an
      unreadable one on the row, another currency, or the part listed at two
      prices, or at a price and at 0 (all shown; the manager types it;
      v1.313.1).
    - The incoming price is a field like any other (v1.313.1): a price typed
      over it, or a blank, is saved at once and held out of Apply as *Keep*
      holds one; a line held unpriced reads *Left unpriced*.
    - The tally's **Purchaser earns** reads current → with the sheet, its
      meter shows the incoming prices striped, and the Commission card shows
      the figures with the sheet applied.
    - Apply writes each price through the inventory line PATCH, as a typed
      one goes, so each is audited as `priced`; the toast says how many were
      priced and repriced and **Undo** puts every previous price back,
      except on a line retyped since (v1.313.1). The
      Compare card names the file and figure a price came from, until the
      page reloads. Sheet prices are not market data points; the Market
      page's import is for that.
- **AI review checks every product of a PO in Review mode** (v1.245.0, desktop,
  managers). Off by default; **Settings → General → AI review of purchase
  orders** turns it on and sets a per-PO cost cap, the OpenRouter model, and
  whether part numbers may be looked up on the web.
  - Moving a PO to Reviewing queues a review in the same transaction. A
    background loop runs it within seconds. Moving the PO back to Draft or In
    Transit cancels a review that hasn't run yet, and so does archiving it
    (v1.247.1). **Re-run** in the card runs one on demand, even with the
    automatic review off. The card keeps the last finished review's findings
    however many runs failed after it (v1.247.1).
  - Each line is checked against four sources:
    - its **part number**, decoded by the makers' schemes;
    - its **label read**: the scan's own extraction, or the photo read again
      when there was no scan or the part number disputes the line. A RAM read
      goes through the same part-number correction the scan form applied, so
      a part # the scan already fixed is not disputed with its misread
      (v1.247.1). Only RAM, SSD and HDD photos are read again;
    - the **web**, only for a RAM part number no scheme decodes, or a drive
      with no label read, and cached per part number. Never for a placeholder
      (`N/A`) or a Mixed lot's synthetic part number, and a listing's brand
      (often the server maker's) is not taken (v1.247.1);
    - its **market value**, the Market board's basis: the last price, else
      the average sell (v1.247.1).
  - The part number and the label agreeing against the line is an error. One
    source alone is a warning. A blank field gets a suggestion. When the label
    backs the line against its part number, the part number is flagged as a
    possible misread (HMAA/HMA8, PZ/PDZ, O/0) instead of the spec. When one
    such reading fits every spec the line names, the specs are judged by
    that reading, so only the part number is flagged (v1.247.1).
  - DDR3 speeds stored as the PC3 rating and kit part numbers' per-module
    capacity are not flagged.
  - The **AI review** card in Review mode shows the run's state and the
    selected product's findings, with a jump to other flagged products. Rows
    with open findings carry an *AI n* chip.
  - **Apply** writes the suggestion through the ordinary line edit, so it is
    audited as `line_edited`. It goes through the editors' spec cascade, so a
    Form fix brings its Device along (and answers that finding too) instead
    of being refused half-way (v1.247.1). **Dismiss** hides the finding, and a
    re-run keeps it dismissed. Nothing changes a line without a manager.
  - A finding whose line has been edited since the review shows as changed
    and can't be applied; Apply reads the findings again first, so an edit
    made in another tab is not written over (v1.247.1). A cost finding goes
    stale once the unit cost changes (v1.247.1).
  - When a review finishes, the PO's manager is notified (all managers if the
    PO has none) and an `ai_review_done` event joins the PO's history, worded
    on the PO and on the Activity page and shown to managers only (v1.247.1).
    Each run records its cost.
  - The manual sweep it automates is written up in
    `docs/po-spec-audit-runbook.md`.
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
  recognised from its shape, as on Add-package). Then who paid. The
  **Business Account** (*Company card* until v1.317.0) names a method, PayPal
  or Cash: PayPal keeps the transaction-ID rule and offers the optional
  screenshot that reads the ID; Cash lifts that rule but needs its own proof
  (v1.153.0, below). **A person** — any active manager by name, or the
  purchaser (*Self-paid* until v1.317.0) — asks for no method and no ID — it
  is reimbursed, not matched against the bank — but **requires the chat with
  the seller** as a Submission attachment (any
  Submission file on the order counts). The dialog asks for nothing else —
  the purchaser and commission rate left it in v1.162.0 for the Commission
  tab / fold and the phone's Ready-to-Pay sheet.
  Confirming writes everything, creates the tracked package for a label
  (linked to the PO, carrying its source), and advances, in one transaction —
  a refusal leaves nothing behind. The hand-off is the owner's or a manager's;
  the desktop asks for unsaved page edits to be saved first. Every field it
  changes is on the activity log, beside a *Handed off* entry naming the
  collector or the package. The chat rule is enforced in the advance itself,
  so a manager stage-jump and the carrier poll hold to it too, and it is
  grandfathered by a cutoff stamped when the release reached the environment,
  exactly like the transaction-ID rule. Since v1.171.1 the **receiving
  warehouse is a blocker** too (`missingWarehouse`, first in the list, held
  against every door — a PO with no warehouse is stock with no location),
  a pickup needs its collector on the page as well as on the server, a
  section of the checkpoint that was ever open stays open (no more folding
  mid-typing), the transaction id follows the method (handing off, or
  saving, as Self or Cash clears a saved PayPal id), and both shells ask for
  unsaved page edits to be saved before the checkpoint or any other stage
  move (the phone used to open the sheet over them and lose them).
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
  existed says so and points at the Delivery tab. The box is the order's
  for good once the carrier marks it delivered (v1.171.1): a flip to pickup
  or a re-typed number is refused with a 409 rather than putting a delivered
  box back on the Shipping page's *Needs you* (where Create PO would mint a
  second PO for the same goods). A number that sits on another member's
  standalone box is refused too — one's own, the PO owner's, or a manager's
  pull still links it — and a PO minted from a tracked box is born knowing
  it came by label.
- **The desktop list has a Total cost column** (v1.156.0), after QTY: the
  goods figure the dashboard uses (the stored total, else the line sum on
  what was bought) plus other fees, with `incl. $12 fees` under it when fees
  exist; sortable, in the Columns picker, on by default. A user who had
  pinned the picker before this release ticks it on once — the saved set
  lists what is shown, and a new column is not in it.
- **The desktop list has a Paid by column** (v1.301.0), after Commission:
  who paid the purchaser their commission, the same record as the Commission
  tab's *Paid by*. Since v1.302.0 it is read-only for every role; v1.301.0
  had a picker in the cell. The record is made on the PO page, by the
  linked commission transaction (v1.345.0) or a legacy screenshot upload. A manager sees a PO
  with a bank payment linked as its commission as a *Business Account* chip
  (*Company paid* until v1.317.0) that opens that payment. It is sortable,
  in the Columns picker and on by default. Unlike Total cost above,
  migration 0188 added it to every saved column list, so nobody has to tick
  it on.
- **The cost's Paid by names who paid the supplier** (v1.317.0): the
  **Business Account** — the company's Mercury and PayPal money, the only
  kind the Payments page links to a PO — or **a person**, any active manager
  by name, or the purchaser when they are not one. The picker is a select on
  every surface the payment picker already had (below); picking a person
  keeps the chat-screenshot rule, the Business Account keeps Method and the
  transaction-ID and auto-link rules. Stored as the same `payment`
  (`company` / `self`) plus `orders.paid_by` (migration 0198), which named
  the purchaser on every self-paid PO that existed. The list's Payment cell
  and its filter chips read *Business* or the person's name; a change is one
  *Paid by: ‹from› → ‹to›* Activity line. **The cost comes back to whoever
  paid it**: the Commission tab adds it to the purchaser's earnings only when
  the purchaser paid, and reads *Cost reimbursed to ‹name›* when a manager
  did; Review mode's money panel follows the same rule (v1.317.3). The
  spreadsheet export's *Payment method* row names the payer too. **A new
  owner takes over a payer that was the old owner** (v1.317.3): reassigning
  a self-paid PO, on the PO page or at hand-off, moves Paid by with it, with
  its Activity line, as Self meant before it named a person. A manager who
  paid stays the payer, and so does a payer the same save picked. Since
  v1.317.4 a save that hands the PO over can't pick the old owner, who no
  longer paid for their own PO, and the Paid by select offers the new owner.
  **Once a manager has booked the cost, Paid by is a manager's** (v1.318.2).
  A purchaser's PO save or hand-off that would change the payment or Paid by
  of a PO with a live paid-out cost entry in the RMB Flow is refused (403),
  because the payer sync would void or move the manager's entry. Saves that
  leave the payer alone go through. The purchaser's Paid by select is
  disabled on both PO pages and both hand-off surfaces, with *A manager has
  booked this PO's cost*; a voided entry, or a commission entry alone, locks
  nothing.
  Only a payer a save picks is checked: the one on file passes as it is,
  even a manager deactivated since, so a hand-off or a save never fails on a
  field nobody touched.
- **The Actions column is pinned to the right edge** (v1.294.1). When the
  desktop list is wider than its card and scrolls sideways, the Actions
  header and cells stay put at the right while the other columns slide
  underneath them, with a soft edge on the cell's left while anything is
  hidden there. Sell orders and the inventory lot table pin theirs the same
  way. A table that fits its card shows no edge and looks as before.
- **One payment picker on every surface, and a cash payment needs a
  screenshot of the amount** (v1.153.0). The desktop Submit and Edit pages,
  the phone's Review and Detail screens, and the hand-off dialog and sheet
  all share one component: *Paid by* (the Business Account or a person since
  v1.317.0; Company card / Self-paid before), then, under the Business
  Account, *Method* (PayPal / Cash), then a proof panel whose heading
  states what the chosen path needs before anything is typed — the
  transaction ID plus the optional screenshot that reads it (since v1.167.0
  that screenshot is itself a `Payment` attachment on the PO — listed as a
  chip beside the drop box, still there after a reload, shown read-only when
  the PO is locked, and the ID is read off it in the same upload — and since
  v1.170.0 appended to the stored file name, so a chip reads
  `<date>-paypal-<amount>-<TXNID>.jpg` and matches its ledger row on sight); a
  **screenshot of the total amount handed over** for cash (the receipt, the
  counted cash, or the chat where the amount was agreed); the chat with the
  seller for a self-paid order. A company PO whose method was never asked is asked in the
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
- **`payment` is `company` or `self`, at every door** (v1.191.0): create, draft,
  PATCH and hand-off refuse anything else with a 400, and a CHECK constraint
  backs it. Every proof rule above keys on one of the two values, so a third
  string used to skip all of them.
- **A Draft with a linked bank payment can be deleted** (v1.191.0). The delete
  unlinks the payment first — it used to fail with a 500 — and leaves it free
  to auto-link to the PO it really paid for.
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
  does every purchaser, since the page it opens is manager-only. On the PO
  page itself, each row of the Cost Payment tab's *Bank payments* ledger is a
  link to that transaction — the Payments page pinned to the PO with that row
  open (v1.167.0).
- **A manager is warned when the bank paid something other than the PO's
  total cost** (v1.225.0).
  - **What is compared.** The same net the Payment cell shows, against goods
    + other fees, exact to the cent. Prod had 13 of 46 linked POs off, e.g.
    $2,415 paid on a $70 PO.
  - **The warning.** An amber banner names both figures and the difference,
    with *Open Payments*. It shows in Review mode, and in the desktop PO
    page's Order status card, at any stage.
    - The PO page compares against its live cost, so a fee typed to cover the
      gap clears the warning before Save.
    - The desktop PO list puts a red circled `!` ahead of the order id of
      every such PO, so the off rows stand out without opening each one
      (v1.258.0). Hovering or focusing it opens the banner's note at once:
      both figures to the cent, the difference and *Open Payments* — the
      list's cells are whole dollars, so a cents gap is invisible without it
      (v1.258.1).
  - **Asked again at approval.** Moving a PO from before Ready to Pay into
    Ready to Pay or Done asks *Continue anyway?* first. That covers Review
    mode's Approve and the PO page's Save.
    - Cancel writes nothing.
    - Except when the same PO-page click also edits the Cost Payment section
      (paid by, method or PayPal id) (v1.227.2). Those edits can link or
      unlink a bank payment, so the page writes them first and asks against
      what the bank paid then: a newly linked payment that is off asks, and a
      corrected id that now matches doesn't. Cancel keeps the edits, leaves
      the stage and reloads with the banner up.
    - Cancel has the focus, because a label scanner ends each read with
      Enter.
  - **What it leaves alone.**
    - Person-paid POs (self-paid): their bank money is the payer's
      reimbursement plus commission.
    - POs with nothing linked.
    - Moves between Ready to Pay and Done.
    - The phone.
  - **Who sees it.** Managers only. `GET /api/orders/:id` now carries
    `linkedPaid` for them, and leaves the key out for everyone else, a
    manager previewing as purchaser included.
- **Every list holds every row in scope** (v1.199.0). The phone PO list, the
  sell-order inbox and the internal transactions walk the API's pages, as the
  desktop PO list has since v1.140.1. Until then they each stopped at the
  first 50 with no sign more existed. The sell-order status tiles come from
  `GET /api/sell-orders/stats`, so they count every order rather than the
  loaded ones. The phone Market list shows its true total, with a Load more
  button. Paging also no longer skips or repeats rows created within the same
  millisecond, such as a bank sync or an import.
- **The desktop list holds every PO in scope** (v1.140.1). It used to stop
  silently at the API's first page — the newest 50 — so older orders were
  unreachable and the stage counts, KPI cards, search and sort all ran over
  that slice. It now follows the API's pages to the end: the first page
  paints at once and older pages append behind a "Loading older orders…"
  row until the last one lands. The mobile PO list and the sell-order list
  followed in v1.199.0.
- Managers can reopen a Done PO back to Reviewing (v1.81.0), and since
  v1.132.0 also Done → Ready to Pay and Ready to Pay → Reviewing. A Draft
  sell order naming a line stopped blocking the move back to Reviewing in
  v1.138.5, since the draft still promotes against a Reviewing line. **Since
  v1.238.0 a shipped one doesn't block it either**: a line on a Shipped or
  Awaiting-payment sell order stays at Done while the rest of the PO goes back
  to Reviewing, so one shipped product no longer freezes the others. That held
  line is view-only — the PO page, its drawer, Review mode and the phone show
  it locked with the sell order named, `PATCH /api/orders` refuses a change to
  it, and the inventory editor keeps its qty and unit cost, locked up front with
  its own hint (v1.238.1) — until the sell order is Done or Closed. (A line not sold out then stays Done until the PO
  advances again.) A move to In Transit or Draft (including the purchaser-edit
  revert) is still refused by any open sell order, Draft included. The
  refusal names the sell orders involved.
- **Costs split into a goods total and other fees** (v1.43.0); a goods overflow
  can be moved into Other fees (v1.45.0). Fees amortize per line, which is what
  commission is calculated from. `orders.category` and `orders.total_cost` are
  **derived from the lines** — clients must not send `totalCost`.
- **A pinned lot price says so, and a manager can let go of it** (v1.197.0).
  When the stored goods total no longer matches the lines, the cost card on
  desktop and phone labels it "Negotiated lot price". A manager's **Follow line
  total** button resets it to the line sum, at any stage, logged as a
  total-cost change. Which totals count as pinned is the server's call: the
  page's lines show what is left, while the comparison is against what was
  bought. Judged in the browser, every partly sold PO looked negotiated.
- **Blanking a field in the PO editor clears it** (v1.197.1). It used to be
  saved as "no change", so the value came back after a Save that reported
  success. That covered brand, capacity, type, generation, class, rank, speed,
  interface, form factor, description, item type, chip #, health and RPM; the
  inventory editor had the same fix in v1.192.1. Part # and serial # keep their
  stored value when sent blank. A save that changes nothing no longer sends a
  purchaser's submitted PO back to Draft.
- **Every line is checked the same way on the way in** (v1.197.1): qty a whole
  number of at least 1 (0 allowed on an existing PO line, v1.213.0), unit cost and sell price 0 or more, health 0–100, RPM a
  whole number above 0, and text fields within a length limit. That holds for
  a new PO, the PO editor and the inventory editor alike. Negative unit costs
  and goods totals are also refused by the database.
- **A qty edit keeps the sold units sold** (v1.197.0). On a partly sold line,
  a recount in the PO editor or the inventory editor moves the purchased count
  by the same amount, so the PO's cost and the units sold stay put. The PO
  editor also refuses a qty below what committed sell orders hold, naming them
  to a manager.
- **A line already on the PO can be counted down to 0** (v1.213.0), when none
  of its units arrived: the product stays on the PO as ordered and never
  received. (Removing it no longer renumbers anything — a removed product
  leaves a gap since v1.234.0 — but a 0 keeps the record.) The PO page drawer, the Review-mode drawer and the
  phone line form on an existing order all take 0. A new line still needs at
  least 1: a new PO, *Add item*, and a line being captured on the phone. The
  inventory editor keeps 1 as its floor. For a purchaser past Draft, setting
  0 is a qty edit like any other and sends the PO back to Draft. A DDR5 line
  at 0 needs no serials. A 0-qty line costs nothing, isn't stock, and doesn't
  keep a PO from reading Sold.
- Line specs are per-category: RAM carries Part #, Chip #, Brand, Capacity,
  Generation, Type, Class, Rank and Speed; SSD/HDD carry Interface, Form
  factor, Health % and RPM; Other carries a free item type (v1.47.0).
  Rank covers the plain JEDEC grid plus the high-density packaging codes —
  dual-die (`4DRx4`, `8DRx4`) and 3DS stacks (`2S2Rx4`, `2S4Rx4`, `4S2Rx4`),
  which a label scan now keeps instead of flattening to the plain rank
  (v1.139.0).
- **A Micron line's Chip # is the 3-letter die code** (v1.231.0, RS-209).
  - **What's stored:** the FBGA code's last three letters, VPP, TBH or CJV.
    The price list buckets Micron sticks by this code.
  - **What the chip shows:** a date/lot code above the FBGA code
    (`8KE75` / `D9VPP`). Typing, pasting or scanning both lines stores `VPP`.
  - **When it collapses:**
    - The desktop drawer and the phone form collapse the value when the field
      loses focus.
    - The server applies the same rule on every write, and a label scan
      arrives already cut. A brand change to Micron cuts the chip the line
      already holds, even when the save names only the brand (v1.238.1).
  - **Recognised by shape, not from a list:** a value ending in
    `D9`/`D8`/`C9`/`Z9` + three letters.
  - **Left as typed:** anything else, and other brands' chip numbers (only
    upper-cased).
- **RAM and SSD spec selects cascade, so a line's specs can't contradict each
  other** (v1.233.0, RS-210). One table (`shared/specCascade.ts`) drives the
  desktop drawer (new PO, PO edit, Review mode), the phone form, the RAM sheet
  scan, the inventory editor and the API.
  - **Type and Class follow each other**, and whichever was picked last wins:
    - Desktop → UDIMM.
    - Laptop → SODIMM, but only on DDR3/DDR4. On DDR5 a laptop module can be
      SODIMM or CAMM, so Class is left for you.
    - Server clears a SODIMM/CAMM.
    - RDIMM/LRDIMM → Server and SODIMM/CAMM → Laptop.
    - UDIMM → Desktop, which may still be switched to Server (ECC UDIMM).
  - **Neither list is filtered by the other.** Picking against the current
    value fixes the partner field instead, so a SODIMM + Laptop line can still
    become RDIMM in one pick.
  - **Filtered lists:**
    - CAMM is offered only on DDR5.
    - Rank follows the module, judged by Class and by Type, whichever is
      stricter (v1.237.0, RS-217):
      - UDIMM / Desktop: 1–2 ranks of x8, x16 or x32, plus the full-size
        ranks its generation sold:
        - DDR3: 1Rx4 and 2Rx4 ("AMD only" high-density modules).
        - DDR5: 4Rx8 (CQDIMM).
        - DDR4: none.
        - With no generation yet, both are offered. Picking the generation
          clears a rank that doesn't fit it.
      - SODIMM / CAMM / Laptop: 1–2 ranks of x8, x16 or x32.
      - Triple rank, 4Rx4, 4Rx16, octal, dual-die and 3DS are
        registered-only.
      - RDIMM / LRDIMM / Server: anything.
    - An SSD's form factor follows its interface:
      - SATA: 2.5", 3.5" or M.2.
      - SAS: 2.5" or 3.5"; 2.5" is filled in.
      - NVMe: anything but 3.5".
      - U.2: U.2 or 2.5".
      - 3.5" is new in v1.237.0, for HPE's LFF SAS SSDs and native 3.5"
        drives.
  - **Fixed or cleared, never left contradicting:** a value a new pick rules
    out. A label scan lands the same way, and the Class read off the label
    wins over a scanned Type.
  - **The API refuses a conflict**, but only for a rule whose own fields the
    save changes. Prod holds lines from before the rules (SODIMM + 2Rx4,
    UDIMM + Laptop), and a price edit on one still saves. Values the table
    doesn't know (legacy `type: 'DDR4'`, a bare `M.2`) restrict nothing.
- **Validation is shared between shells**, so desktop, mobile and the backend
  can't drift: all RAM spec fields required (v1.29.0); Chip # required only for
  Micron and Other, whose part numbers don't identify the module (v1.36.0);
  DDR5 lines must carry serial numbers, and once any line has serials their
  count must equal the line qty (v1.42.0); SSD lines drop health/serials and
  require brand above 800 GB (v1.76.0).
  - **A DDR3 line needs only Capacity and Type** (v1.253.0, RS-244): brand,
    class, rank, speed, chip # and part # are optional, because DDR3 trades
    by capacity and module form. The red stars follow the same rule as the
    "Still needed" list (`lib/ramRequired.ts` `ramFieldRequired`), so a star
    is always a field the save will ask for. A DDR3 line left without a part
    number is filed as `DDR3_<capacity>_<type>` (`DDR3_8GB_Server`) by the
    same synthetic-id path as a Mixed SSD: previewed in the Part # field,
    offered at Submit, applied by the API for the PO editor. Only the two
    required fields make the id, so lots filled to different depths group as
    one inventory product, and both are needed (v1.255.1): a line with one
    of them blank gets no synthetic id rather than a one-field one that
    would be a product of its own. A typed or scanned part number still
    wins. Box check matches scans by part #, so such a line is counted by
    hand.
  - **Condition is optional on every category** (v1.253.0). It never was
    enforced — the label's star was the only thing that said so.
- **Part numbers are canonical** — one part number however it was typed
  (v1.104.0) — and the submit form suggests existing ones as you type
  (v1.101.0).
- Lines carry photos (v1.54.0). Submission attachments accept receipts and
  spreadsheets (`.xlsx`, `.csv`); `.xls` and `.xlsm` stay refused (v1.34.0).
- **On a phone, every file drop box opens the OS chooser — camera, photo
  library or Files** (v1.172.2). The payment and commission screenshot boxes
  and the line-photo "+" tile used to jump straight into the rear camera, so
  a screenshot already on the phone could not be attached from it; the
  line-photo tile now also takes several library photos at once.
- The PO list hides Done orders by default with a toggle (v1.89.0); mobile
  managers see the whole org's POs (v1.88.0). The stage filter lives in the
  table toolbar as status chips (v1.39.0).
- **Warehouse and payment chips** under the desktop list's stage rail
  (v1.252.0): a Warehouse group (All, one chip per warehouse the loaded POs
  use, No warehouse when some PO has none) and a Payment group (All,
  Business, one chip per person who paid a loaded PO — since v1.317.0; All,
  Company, Self-paid before), for every role. Each chip's count is what its click
  would show given every other filter — search, Done, stage, Sold and the
  other group; the active chip clicked again clears its group. The filter is
  client-side, so the table swaps in place with no refetch, and the picks
  persist across the open-PO → back round-trip. A remembered warehouse
  that the current scope has no PO in (after a category or role switch)
  reads as All rather than leaving the table empty, and comes back with
  the scope that has it (v1.255.1). The phone list has no equivalent.
- **Archiving a PO takes its goods out of stock** (v1.137.0). Archive still
  hides the order from the default list and is still reversible, but it now
  also moves every non-Sold line to the `Archived` line status, which drops
  it out of the inventory screens, the sellable picker and the MCP search the
  same way Sold does. Since v1.138.2 the
  order's archived flag itself keeps its non-Sold lines out of all of those,
  and out of sell orders and transfers, whatever status a line holds —
  the pre-release backfill is finished by migration 0124, which pulls such
  lines off open sell orders the way the archive dialog does. Unarchive
  restores each line to the status it held. If a line sits on an open sell order
  (Draft, Packing, Shipped or Awaiting payment) the archive dialog names the sell
  orders and lines and asks whether to remove them from those sell orders
  first; the removal is audited on the sell order and is not undone by
  unarchiving. A sell line held at 0 holds nothing, so it is neither named
  nor removed, nor counted in the sell order's line count (v1.220.2): it stays,
  with its #, pointing at the archived lot. That question, and the removal, are the manager's: a
  purchaser who owns the PO gets a plain refusal naming no sell orders
  (v1.137.1). A line out on a pending transfer refuses the archive; one that
  was already out when the PO was archived (migration 0122's case) joins the
  archive on receive or discard, with the audit row unarchive reads, rather
  than landing at a stock status behind the flag (v1.138.4). An
  archived PO is frozen — edits, stage moves, delete and inventory line edits
  (Sold lines included) all refuse until it is unarchived — and both edit
  shells render it locked and say so. Analysis ▸ Inventory leaves archived goods
  out of every aggregate (v1.137.1), Sold lines excepted — they are the sales
  record and keep counting (v1.138.4).
- **Removing a PO line is refused while an open, non-archived sell order
  names it** (v1.145.2), and the refusal names the sell orders. Open means
  Draft, Packing, Shipped or Awaiting payment — the same set the archive dialog
  above uses. A Closed, Done or archived sell order lets the line go: it
  keeps its own line as the snapshot it already carried (label, part number,
  qty, price) with the link to the source cleared. Until v1.144.1 the
  refusal was the database foreign key itself, so every sell order that had
  ever named the line blocked and the message named nothing; v1.144.1
  exempted archived sell orders only, so closing one did not help despite
  the dialog saying it would. A sale whose source line is gone drops out of
  the cost-based dashboard figures. A sell line held at 0 doesn't block
  either (v1.220.2): it becomes a hand-typed line, no longer capped by a
  lot's stock — and, as a different product now, it takes a hand-typed
  line's place and # in the packing-list order (v1.220.3).
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

- **A client link opens that client** (v1.258.7): `/#/clients/<id>` drives
  the drawer, a row click writes the id to the URL and closing returns to
  the list, so a copied link and Back/Forward land on the same client.
- **The list filters and counts the whole book, then pages it** (v1.258.5).
  Follow-up and health were applied after a 200-row cap, so a book whose
  "soon" clients all sat past the cap showed none and counted none.
  `GET /api/suppliers?limit=&offset=` answers `nextOffset`; the Clients page
  walks the pages. A box from a non-Latin seller lands on the right client:
  package → PO matches the seller on the same name key every other client
  lookup uses, where it had read every all-Chinese name as the same.
- **Clients named in other scripts no longer collide** (v1.198.3). A name's
  key kept only A–Z and 0–9, so every Chinese or Vietnamese name keyed as
  empty. A second such client at the same zip was refused, and every
  non-Latin package seller "matched" every non-Latin client. Such names now
  key on their own text; Latin names key exactly as before. Since v1.200.1
  that covers any name with a non-ASCII character: a mixed name kept only its
  Latin part, so 'Đức' keyed as 'C' and '王 RAM' and '李 RAM' as one client.
- **A purchaser's client card counts their own POs** (v1.198.0). Spend, PO
  count, rhythm, gap and the items list cover only the POs the purchaser
  owns, where they used to sum every colleague's POs onto the purchaser's
  own client. The tier stays company-wide, because it ranks business value.
  A client's items list counts what was bought, not what is left.

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
Transit. A line counted down to 0 stays on its PO but is never stock: the list,
the export, the grouped view and Analysis ▸ Inventory leave it out (v1.213.0). A PO whose every line has sold carries
the Sold flag beside its stage (v1.246.0); nothing about its lines changes. Lines of an archived PO sit at the
`Archived` status and are out of every stock view until the PO is unarchived
(v1.137.0); like Sold, they are reachable through an explicit status filter.

- Flat and grouped views. Grouped is what goes outward to vendors and buyers,
  so it carries no cost, sell price or submitter (v1.51.0); flat keeps them for
  internal use.
- **RAM carries a market short code** (v1.347.0): Samsung's three characters
  before the part number's dash (`M393A2G40DB0-CPB0Q` → `DB0`), SK Hynix's
  die/package segment (`HMA42GR7MFR4N-TF` → `MFR`), or Micron's recorded
  three-letter chip die (`D9VPP` → `VPP`). Recognized separator-free spellings
  read the same. A Micron lot with no recognizable chip stays *Not recorded*;
  its module number alone does not prove a die. Other brands and unsupported
  part schemes, including Hynix HMC DDR5, have no short code.
  - Desktop and phone RAM forms show it live from Brand, Part # and Chip #.
    The inventory RAM editor also offers Chip #, so existing stock can gain a
    missing code, normalized on save and recorded in its audit log.
  - Inventory, Quick View, the sell-order builder, picker and order lines
    show it. A product group lists its distinct codes and any unknown member;
    its lots keep their own. Warehouse scope applies to the shown codes too.
  - Inventory exports, PO workbooks and vendor bid sheets include **Short
    code**. Short codes are calculated from current data. Inventory grouping
    and market-price identity stay unchanged; the vendor bid sheet uses the
    short-code grouping described below.
- **The grouped view groups RAM by module family** (v1.244.0). Part numbers
  that differ only in the maker's trailing packaging or marking code
  (`M393A2K43BB1-CTD` / `-CTD7Q` / `-CTDQ`, Micron `-2G1A2II` / `-2G1A2KJ`)
  are one product, shown as `M393A2K43BB1-CTD*`. Hovering lists the member
  part numbers, and the lots table adds a Part # column. A dashed tail
  (`HMA82GR7CJR8N-VK-TF`) groups with its dash-free spelling (v1.247.1). Lots
  picked in the grouped view carry their own part number into a sell order
  or Quick View, never the family's `…*` (v1.247.1), and their own spec too,
  never the group head's: "Mixed" groups unrelated modules (v1.374.1). Module form, dies,
  organisation and speed still separate products, so RDIMM `M393…` and ECC
  UDIMM `M391…` are two. Samsung, SK Hynix DDR3/4 and Micron are read; other
  part numbers group by exact canonical part number as before. The export
  groups the same way.
- **DDR5 RAM groups by spec, not part number** (v1.254.0). A DDR5 lot keys
  on Brand + Type + Capacity + Rank + Speed + Class — what a DDR5 buyer asks
  for — so part number and chip # never split a product, and a lot with no
  part number joins the group its spec names. A lot with one of the six
  blank is its own product. A group whose lots carry different part numbers
  shows no single number in its Part # cell, just the "N part numbers" line
  with the members on hover (the export lists them comma-separated); the
  lots table and anything picked from it keep each lot's own part number.
  DDR3 and DDR4 stay on the family rule above.
- **A product's lots table names each lot by PO and line** — `PO-1343 #2`, the
  number the PO page shows for that line, with the PO id still the link
  (v1.232.0).
- **The warehouse pill scopes the grouped view's lots, not just its products**
  (v1.252.1). With one warehouse picked, a product opens to that warehouse's
  lots alone, and its row — qty and the in-stock split, lot and PO counts,
  cost range, Warehouses — sums those alone. The attribute chips still show
  a matching product whole, so a mis-typed lot stays findable.
- **The desktop Inventory table sorts by any column** (v1.332.0): Product,
  Part #, Qty, Lots, Warehouses, Cost, Sell. A click goes high → low → low →
  high → back to the bid-sheet order. Blanks sort last, and ties keep the
  bid-sheet order. The server ranks every matching product before it caps
  the list at 200, so the top of a sort is the top of the whole stock. A
  hidden sorted column, or Cost for a non-manager, falls back to the
  bid-sheet order. The export keeps the bid-sheet order.
- **The phone Inventory list is one category → brand → capacity order across
  every page it loads** (v1.258.9), the order the exports use.
- **The phone Inventory list shows each line's sell price to every role**
  (v1.144.2), under the status chip, the way the desktop table and the phone
  Orders list already did. Unit cost, profit and margin stay manager-only
  everywhere — the API does not send them to purchasers.
- Search matches part number, serial number, brand, description and item type
  (v1.42.0), and the PO number, whole or partial (v1.143.0).
- **`#30` finds every lot that is product #30 on its PO** (v1.240.0), as an
  exact match, so `#3` does not also bring back #30. `PO-1483 #22`, as the lots
  table prints it, narrows to that one product.
- **A lot's PO link opens the PO at that product** (v1.240.0): the page
  scrolls to the row with the lot's `#` and highlights it for a few seconds.
  A sell-order line's "from PO" link does the same. The `#` is in the link
  (`?line=22`), so a copied link lands there too.
- After a transfer or add-to-order, the list and its facets reload with every
  active filter, including Show sold, Hide pending and the attribute chips
  (v1.179.0).
- The **Refine** panel of attribute chips folds away on a click outside it.
  Since v1.318.0 it folds on the click itself, not the press, so the click
  still lands on the row it was aimed at. A picked chip keeps its label under
  the mouse. Monitors ▸ WeChat uses the same panel.
- Export honours the row selection, one worksheet per category, with designed
  workbook styling (v1.30.0, v1.31.0). Select/unselect all lots in the current
  filter (v1.19.0). Select all takes every sellable lot the filters match,
  including products past the 200 the list shows, and the bulk actions and
  export receive the whole set; export posts the selection, up to 5000 lots
  (v1.230.2). Each lot is held to the warehouse and the attribute chips on its
  own, so a lot typed differently inside a matching product stays out, and a
  lot sold, archived or emptied since the list loaded doesn't join. Such a lot
  also leaves the set Select all counts, so it can still finish and clear
  (v1.238.1). The grouped view reads up to 5000 lines, enough for Show sold
  (v1.237.1).
- **The export and both screens read in the vendor bid sheet's order** — brand,
  then capacity, speed, numerically collated with blanks last (v1.107.0), and
  category rank ahead of it on the screens, which have no tabs to group by
  (v1.111.0). One implementation serves the workbooks and the lists. The
  screens read the whole book in pages of 200 (`GET /api/inventory?limit=&cursor=`,
  v1.258.5); until then they took the newest 200 rows and ended there with no
  sign that they had, the phone's totals included. The bid sheet's RAM tab (and its packing tabs) put a device-group /
  DDR-generation grouping ahead of that order (v1.129.0); the export and the
  screens do not.
- Other-type stock can be filtered by Untyped (v1.49.0).
- Spec fields on an inventory line are editable in place on desktop.
  **The inventory editor saves whatever stage the PO is at** (v1.192.1):
  sell price, status, condition, part #, health, RPM and specs land on a
  Ready to Pay or Done PO too, sold or not. Only qty and unit cost freeze from
  Ready to Pay on. They show dimmed, with a line linking the PO and saying
  to move it back to Reviewing. A save sends only the fields that changed.
- **Committed sell orders reserve the units they name**, not the whole lot.
  Since v1.197.0 one rule computes them everywhere. That covers the sell-order
  picker, a sell order's max qty, the transfer limit, the inventory list's
  `committed_qty` (managers) and both editors. A recount in the inventory
  editor may go down to the committed units, not below. A status change waits
  until nothing is committed; until v1.197.0 any qty edit was refused once a
  single unit was committed.

## Sell orders

- **A sell order is a full page** (v1.194.0), `#/sell-orders/:id`, rendered
  in place of the list as a PO's page is. It was a popup before.
  - **An open order is the editor** (v1.375.0): anything short of Done or
    Closed opens with the stepper, line inputs and customer ready to change;
    there is no read-only page or Edit order button any more. The old
    `/:id/edit` address opens the same page. Done and Closed orders stay
    read-only, with Reopen.
  - The line items and editing controls are on the left. The order summary,
    payment receiver, evidence and internal notes are on the right; under
    1100px everything stacks into one column.
  - The page head carries the downloads, Pack mode, After-sales, Discard
    (close the order), Reopen, and Archive / Unarchive.
  - A sticky Cancel / Save footer appears once something is changed
    (v1.375.0). Cancel confirms before putting the saved order back
    (v1.377.2); Save stays on the order, reloads it and shows a toast.
    Controls stay disabled through Save and its reload, so a delayed response
    cannot erase fresh edits (v1.377.2). Sign / Withdraw sign-off hide while
    there are unsaved edits, since a sign-off approves the order as saved.
  - A line can grow to what its lot still has free. A line whose lot has
    nothing left to offer reads "No longer available — set it to 0 or remove
    it" (v1.194.1, v1.219.0). That covers a lot that left Reviewing or Done,
    one whose PO was archived, and one that other committed orders hold in
    full. Saving refuses such a line above 0.
  - **Add inventory sits in the products toolbar while editing** (v1.250.0),
    the accent button beside the search box, where it was a small button
    under the last line. Adding clears the search, scrolls to the first line
    added and flashes each new one.
  - **Internal notes can be written at any time** (v1.249.0), Done and
    Closed included: on those the notes box saves on its own, with Save /
    Cancel once it differs from what is saved; leaving the page with it
    unsaved asks first (v1.255.1). An open order folds notes into the
    editor's own Save.
  - **The order keeps its own files in an Attachments card** (v1.294.0),
    between Internal notes and History, in view and edit mode alike. A
    manager drops or picks the marketplace sale record, the invoice sent or
    a packing list there (PDF, images, XLSX, CSV, within the workspace upload
    cap); each lands as a row with its name, size, and who uploaded it when,
    with a remove control. Images open in the lightbox, other files in a new
    tab. Uploads and removals save at once, so a file dropped mid-edit
    survives a cancelled edit, and the History records each one. These are
    the order's files; the per-status evidence stays with its transition.
  - **The order's History is the last card in the right-hand column, folded**
    (v1.248.0; in the side column since v1.248.2); a click on its heading
    opens it.
  - **The Vendor price import card is gone** (v1.297.0, RS-324). It sat at
    the top of the right-hand column from v1.248.3 (first in the left card in
    v1.248.1, under the products before that). A sell order's prices come
    from its lots' sell prices now; see *Vendor bid sheet* below. The filled
    sheet is dropped on the PO's Review mode instead (v1.313.0), which sets
    those sell prices.
  - **A search box over the products narrows the list** (v1.248.0), in view
    and edit, like Pack mode's: a part #, serial or PO number matches with or
    without its dashes, and words match the item's name and spec chips
    (`sodimm 2666`), every word somewhere in the row. `/` jumps to it and Esc
    clears it. It changes only what is listed — the line count, the order
    total and what Save sends still cover every line.
- **Every line shows its product's # on the order** (v1.219.0; one per
  product since v1.220.3; stored and never renumbered since v1.235.0) — `#3`
  before the item name, in view and edit: the number the packer labels the
  items with and the receiver checks the box by. Lines of one product
  (several PO lots of one part) share its #, and **the order lists its lines
  in # order**, so the page and Pack mode read alike.
  - **A new order numbers its products once, 1..N, in the order the Packing
    list shows them** — warehouse tab, then category, device, DDR
    generation, brand / capacity / speed — through the whole file.
  - **Every product added later takes the next #, in any status** (v1.235.0;
    past Draft only from v1.230.0). A Draft no longer sorts a new product in
    among the others: a # never moves once given. Products added in one save
    are numbered among themselves in packing-list order, and a later save's
    go after them. A new lot of a product already on the order — same
    warehouse tab, same part / label / condition — joins that product's #.
    Both packing lists keep their sorted rows, so a later product prints in
    its sorted place with its later # (`#1, #2, #9, #3`).
  - **Removing a packed line asks first** (v1.387.0). Its ✕ opens *Remove a
    packed item?*, naming the part, because the save drops the line's Pack
    mode tick for good. A line not yet packed, or one added in this edit,
    goes at once. The editor learns which lines are packed from
    `GET /api/sell-orders/:id/pack`; if that read fails, nothing asks.
  - **Nothing renumbers** (v1.235.0). Removing a lot leaves a gap. A lot
    removed and added back in a later save is a new product with the next
    #; within one save it keeps its #. A spec edit, a transfer, a warehouse
    change or archiving the source PO moves no #. A lot that moves to
    another warehouse prints under that warehouse's tab, so a product can
    show its one # on two tabs. A lot whose spec or part # is corrected — or
    a hand-typed line re-worded — keeps its product's # (its items may
    already carry the label) but prints as a row of its own under that #,
    so the sheet never shows one lot's spec for another's items. Setting a
    line to 0, editing a price, or saving the order as shown never did.
  - The # is stored (`sell_order_lines.product_no`), and so is the order's
    next one (`sell_orders.next_product_no`); the editor sends each saved
    line's row id, so a line keeps its # through the save's rewrite (by its
    lot, or a hand-typed line by its text, when an API caller sends no id).
    Orders that existed before v1.235.0 kept the numbers they showed: the
    backend froze them on its first boot, and an order the previous release
    saves while a deploy rolls shows — and on its next save keeps — the
    numbers that release showed. A line with no # stored yet always shows
    the one it will get. A line added while editing reads *new* until the
    save numbers it. A hand-typed line joins a product only in its own
    warehouse. "N products" on the order, the sell
    orders list and its export count #s.
  - A product's place on the sheet comes from its first line by PO and
    product # — 0s included — and a tie on everything the sheet sorts by goes
    by part # (v1.221.0).
- **A line that can't ship can be set to 0** (v1.219.0), keeping a record
  that it was on the order. (Removing it renumbers nothing either since
  v1.235.0: it leaves a gap.) Any line already on the order may go to 0 in the
  editor, including one whose lot is gone; a line being added still needs at
  least 1, as does a new order (and the MCP create tool). Since v1.220.2 the
  server holds that rule too: a save may hold at 0 only a lot already on the
  order, and a 0 for any other lot — or an id no lot has — is a 400. A line at 0 holds
  nothing: it reserves no stock, sells nothing on Done, records no market
  price, is left off the bid sheet and both packing lists (its product keeps
  its #, which the sheet then skips),
  and keeps its price through a negotiated total. An order whose lines are
  all 0 can't move to Shipped, Awaiting payment or Done, and has nothing to
  pack: both packing-list buttons are off for it (v1.220.2). A hand-typed line is
  no longer capped at its saved qty. Archiving a PO leaves a sell line held
  at 0 alone (v1.220.2): it is not a conflict and is not removed. Removing
  the PO line it names doesn't block either: the sell line becomes a
  hand-typed line and keeps its # (v1.235.0).
- **Products group By warehouse or By PO, or show Combined** (v1.194.0;
  Combined since v1.375.0). The switch on the Products header is remembered
  per user (preference `sellOrders.lineGroup`: `warehouse`, `po` or `none`,
  default by warehouse).
  - Combined is one table in the order's # order, with a Warehouse column and
    the "From PO-…" reference under each line.
  - By PO orders the groups numerically and puts hand-typed lines last under
    "No PO", matching the "Packing list by PO" download. It shows a Warehouse
    column. Inside a group, either way, the lines keep the order's # order
    (v1.220.3; By PO went by the PO page's line # before).
  - By warehouse groups on where each line's lot is now — the warehouse the
    packing lists file it under (v1.221.0; the warehouse the line was saved
    with before, which a transfer left behind) — and shows the "From PO-…"
    reference under each line. By PO's Warehouse column reads the same.
  - PO references are links, while editing too (v1.375.0): leaving with
    unsaved edits asks first.
- **A line carries its number on the source PO** (v1.196.0): the `#` the PO
  page shows for that line.
  - By PO shows it as a grey `PO #3` badge after the item name, in view and
    edit mode (v1.198.2). Hovering reads "Line 3 on PO-1432". Each card lists
    its lines in the order's # order (v1.220.3), so the badges need not run
    in sequence, and a hand-typed line has no badge. It is a badge,
    not a column, on purpose: a leading `#` column (v1.196.0) read as the sell
    order's own row number, and an "ID in PO" column (v1.197.3) was tried and
    dropped.
  - By warehouse's reference reads "From PO-1432 #3".
  - Lines picked in edit mode, from the picker or Inventory → Add to sell order,
    show the number before saving.
  - The number is the product's stored `#` on its PO (v1.234.0; a live rank
    before). Removing a PO product renumbers nothing on either page, and a
    lot split off by a partial transfer shows its source's `#`.
- **Each line shows its spec as tags** (v1.194.0).
  - RAM: Desktop / Server / Laptop, classification, rank and speed (rank and
    speed accented).
  - SSD / HDD: interface, form factor and health.
  - The tags are read live from the line's lot, so a line added while editing
    shows them before the save. A hand-typed line, or one whose lot is gone,
    shows its saved spec text instead.
  - `GET /api/sell-orders/sellable` and the `search_sellable_inventory` MCP
    tool return the same fields plus `sourceOrderId`.
- **Only a Done or Closed sell order can be archived** (v1.193.0). Shipped and
  Awaiting-payment orders still reserve their units, and an archived order
  leaves the inbox, so archiving one would hide stock it holds; the API refuses
  it and the Archive button is offered only on Done and Closed. An archived
  order can't be moved back into either committed status.
- **The add-inventory picker says when it is cut off** (v1.193.0): it shows the
  first 200 sellable matches and asks for a narrower search when there are more
  (`/sell-orders/sellable` returns `hasMore`).
- **Inventory lots can be added to an existing sell order** (v1.175.0). The
  desktop Inventory selection bar and toolbar offer "Add to sell order" beside
  Create sell order.
  - The picker lists the open orders (Draft, Packing, Shipped, Awaiting payment; not
    archived), searchable by order number or customer.
  - Picking one opens that order's edit page with the selection appended
    (a modal until v1.194.0).
  - Lots already on the order are skipped, with a notice when that is all of
    them. A new line takes the price the order already has for that product,
    else 0.
  - Saving clears the Inventory selection; leaving the page without saving
    keeps it (v1.194.0). The page offers no Archive or Discard on this path.
- **Each line links back to its PO** (v1.174.0). The sell order view shows a
  "From PO-…" link under a line that was picked from inventory. A free-typed
  line has no PO.
- **Done needs every active manager's sign-off** (v1.226.0). The order page
  carries a Sign-off card under the summary: each manager signed (with when),
  waiting, or needing to sign again, and the viewer's own Sign off / Sign
  again / Withdraw. Managers sign in Draft, Packing, Shipped or Awaiting payment, each
  for themselves.
  - `POST /api/sell-orders/:id/status` to Done answers 409 naming who is
    missing, and the stepper's Done step is locked with the same names.
    Signing only unlocks Done; a manager still moves the order there.
  - A sign-off approves the order as it stood: the customer, the currency and
    each line's item, qty, native price and lot. Changing any of them — in the
    editor, by a negotiated total, or by a PO archive taking a line off —
    leaves earlier sign-offs reading "needs to sign again". Notes, the
    receiver, warehouse moves and evidence don't, nor does reordering lines
    or re-saving at a new FX rate. The edit page warns before such a save.
    A sign-off names the version the manager read: if the order changed in
    between, `POST /api/sell-orders/:id/signoff` answers 409 and the card
    re-reads the order.
  - Who is required is worked out live: every active manager. Reopening a
    Closed order clears its sign-offs; reopening a Done one keeps them
    (v1.311.0), so an order put back unchanged goes straight to Done again. History logs each sign-off and
    withdrawal, and a sign-off notifies the managers still to sign. Orders
    Done before v1.226.0 carry none.
- A **draft sell order is a proposal**; inventory is claimed only on promotion
  (v1.41.0). Drafts can move straight to Awaiting payment (v1.13.0).
- **Packing sits between Draft and Shipped** (v1.230.0). It marks a Draft whose
  goods are being boxed.
  - **Getting in and out.** Opening Pack mode moves a Draft there; any other
    status stays as it is, and if the move is refused, packing goes on
    quietly. The stepper can also set it. A Packing order can step back to
    Draft, the only backward move besides reopening.
  - **Like a Draft, it reserves nothing.** Leaving it for Shipped, Awaiting
    payment or Done runs the promotion stock check. Entering it therefore
    never fails on a rival's claim, but a rival Draft promoted meanwhile can
    still take units already in the box. Mark shipped then says so.
  - **It counts as open** wherever a Draft does: hide-pending, the Add to sell
    order picker, sign-off, and the PO archive and line-removal checks.
  - **What it doesn't do.** It asks for no evidence, and it can't be archived.
  - **Numbering.** Being past Draft, inventory added to it appends its #
    (above).
- **A Done order can be reopened to Awaiting payment** (v1.311.0, RS-343), to
  correct a sale marked Done by mistake or with a wrong line or price. Any
  manager can do it from *Reopen* on the order page with a note; the note
  lands in History and is appended to the order's notes, as a Closed reopen's
  does. The request has to name the order as Done (`from: 'Done'`), so a save
  from an editor opened before the order went Done can't reopen it
  (v1.312.1). The editor's own saves name the status they were opened on too,
  and a move someone else made since is refused.
  - **The stock comes back.** Every unit the sale consumed returns to its lot,
    and the order holds it again as any Awaiting-payment order does, so no
    other order can take it meanwhile. A lot gets back what the sale actually
    took, never more than it had before the sale (v1.312.1). A sold-out lot
    leaves Sold for the status it was sold from, read off its `sold` event's
    `priorStatus` (v1.312.1; a sale recorded earlier falls back to its PO's
    line status), holding what this order took, since another sale may have
    taken the rest. Each lot's history reads "Sale reopened +N". The PO's
    goods total doesn't move.
  - **So does the rest of Done.** The sale's market data points are
    withdrawn, and a part whose last price came from them falls back to its
    previous one. History lists the withdrawn prices on the reopen (v1.312.1).
    The order leaves the dashboard and contributions until it is Done again.
    It keeps its sale date throughout, so a corrected sale stays in the
    period it was made in (v1.312.1).
  - **Refused, changing nothing,** for an archived order (unarchive it first),
    while an after-sales case on it is open (v1.312.1), and when a lot can't
    take its units back: its PO is archived or no longer at Reviewing or
    Done, or the lot was archived. The refusal names the lot or the case.
  - Done reopens to Awaiting payment only. Draft would drop the reservation,
    and an after-sales case can't be opened on a Draft. A reopened sale goes
    back to Done: it can't be Closed, and its page offers no Discard
    (v1.312.1). Taking its goods back is an after-sales return.
- Orders carry a payment receiver, creator-only reopen (v1.15.0) and a receiver
  column with a managers-only receiver rule (v1.16.0). The receiver can be
  reassigned from the detail view in any status, Done and Closed included —
  the change saves at once and is logged in the order history (v1.135.0).
- **The detail view lists the bank payments linked to the order**
  (v1.257.0), under the payment receiver: each row a link back to the
  Payments page pinned to this order, with the net received. Nothing shows
  until a manager links a payment there.
- **The managers' RMB receipts sit under them** (v1.310.0): an *Accounting*
  card with the order's Sale entries and its cases' refunds, the net received
  against the order total, and *Record receipt*, which starts on the payment
  receiver. A receiver no longer active falls back to the manager recording
  it (v1.310.2). Its suggested amount is what the order itself still lacks,
  so a case's refund no longer reads as owed. See [RMB Flow](#rmb-flow).
- **The desktop list flags an order with internal notes** (v1.239.0): a note
  icon beside the customer on each row whose note isn't blank.  Hovering or
  tabbing to it shows the note in a card (line breaks kept, clamped at 14
  lines); clicking or tapping it pins the card until the next click, and never
  opens the order (v1.239.1).  To copy from a note, open the order — the card
  takes no pointer, so it never blocks the icon on the row below, and a press
  on it only dismisses it (v1.239.1).
- **Negotiated final-price adjustment** with an order-summary breakdown card
  (v1.22.0, v1.23.0).
- **Vendor bid sheet**: export a bid-sheet XLSX for the vendor (v1.21.0).
  The sheet ships pre-sorted the way the desk reads it, with an autofilter
  across the header row and no sheet protection (v1.51.2). **It prices a
  part once, not per condition**: there is no Condition column, and a part
  held in two conditions is one row with its qty summed (v1.242.0). **RAM
  bids group by short code and spec** (v1.347.0): Brand + Short code + Speed +
  Rank, with Capacity, Generation, Type and Class also kept separate. Matching
  lots across POs, warehouses and part numbers share one row with their qty
  summed. Equivalent speed spellings compare in MT/s. The Part Number cell
  lists every live member, comma-separated; a zero-quantity lot stays out.
  Without a recognized code or a complete spec, the earlier grouping applies:
  DDR5 by Brand + Type + Capacity + Rank + Speed + Class (v1.255.0), other RAM
  by part number and label. Known and unknown chip codes never share a bid
  group. Packing lists and product `#` keep their existing grouping.
  - **The import half of the round trip was removed in v1.297.0** (RS-324).
    From v1.21.0 to v1.296.x the vendor filled the sheet's Unit Price column
    and the manager dropped it back on the order's edit view: the preview
    matched rows by canonical part number, confirming filled the form's
    prices, and the save that followed recorded them on the Market board as
    `bid:<order>` data points (v1.138.3). Since Review mode sets each PO
    line's sell price (v1.296.0) and a sell order line starts at its lot's
    sell price, the returned sheet is read on the PO's Review mode instead
    (v1.313.0). Since v1.347.0 its preview expands grouped part-number cells
    and matches any Short code column as well, so Micron VPP and WSM under one
    module number can take different quoted prices. Sheets without that
    column still match by part number. The retired sell-order
    `price-import/preview` route, the `bidParts` save field (an old bundle
    sending it is ignored) and the `bid:` feed are gone; `bid:` events
    already on file still show on the Activity page. The Market page's own
    price-list import stays and still reads these sheets. A lot added to an
    existing order's edit view starts at its sell price too, in the order's
    currency (a CNY order's prefilled lots still start at 0, since the rate
    loads after them); before v1.297.0 it started at 0 unless the product was
    already on the order.
- The price template splits into one worksheet per category with per-attribute
  spec columns and image URLs (v1.25.0, v1.27.0). **The RAM tab groups its rows
  with merged label columns left of `#`** — "Desktop & laptop" / "Server", then
  DDR3 / DDR4 / DDR5 — ahead of the brand/capacity/speed order; the filter
  dropdowns start at `#` because Excel won't sort across unequal merges
  (v1.129.0). Each label column carries its own light palette and each row a
  paler wash of its generation, so a group reads as a band; the yellow
  `Unit Price` column is untouched by it (v1.130.0).
- **The packing checklist is a separate download** — `Packing list` in the
  Download menu (a button beside the bid sheet until v1.293.0),
  `GET /api/sell-orders/:id/packing-list`, managers only. It
  carries per-warehouse `Pack - <warehouse>` tabs (v1.28.0) with tick boxes,
  quantities and subtotals but no prices, and it lived inside the bid-sheet
  workbook until v1.130.0, which meant the vendor's copy carried it. Its RAM
  sections repeat the bid tab's merged labels and colours on two reserved
  leading columns — reserved on every pack tab, so two warehouses on one order
  read alike. Both files come from one query and one sort, so a picker and a
  bidder find a product in the same place. **Every row names
  its source in a `From PO` column after Part #** (v1.216.0): `PO-1442 #3`,
  the line's # on that PO's page; a row of hand-typed lines alone reads `—`.
  **A product is one row with one tick box** (v1.220.3): a product from
  several PO lines stacks them in its `From PO` cell, a line each with its
  share — `PO-1445 #2 × 13` above `PO-1460 #3 × 12` (`No PO × n` for a
  hand-typed share) — POs in numeric order, hand-typed last, and the row grows
  to show them. v1.220.0 had split such a product into a bold product row and
  a tickable row per PO line; that went back to one row once the # became one
  per product. A product from more PO lines than one row can show (Excel
  caps a row at 409pt) goes on over further rows, its #, tick box and other
  cells merged down them (v1.221.0). Its per-lot details — health, rank, the
  part # spelling, the bid sheet's Image URL — come from its first line above
  0, so a lot held at 0 never speaks for what ships; its place, device and
  generation stay with the line that numbers it (v1.221.0).
- **The packing lists carry no photos** (v1.220.1). v1.220.0 embedded a
  thumbnail of each lot's label scan in a `Photo` column after the tick box,
  fetched at export time; it was taken out the same day as not needed on the
  sheet, so Part # sits right after the tick box again and the export fetches
  nothing. The photo is on screen in Pack mode instead, and the bid sheet keeps
  its Image URL links. The download buttons stay disabled while a file is
  being prepared.
- **Both packing lists number their rows by the product's # on the order**
  (v1.219.0; per product since v1.220.3): a `#` column first, before the tick
  box, so the label on an item matches its row. A new order's count runs
  1..N down the file and never restarts on a new tab. A product added later
  keeps its row in its sorted place and carries its later # (v1.230.0; in
  any status since v1.235.0), and a removed one leaves a gap. The by-PO file and a one-warehouse
  download show each product the same # as the full list, and a product held
  at 0 leaves a gap. The bid sheet's own `#` column is a plain row index per
  tab, not this number.
- **The packing list also comes cut by PO** (v1.189.0) — `Packing list by PO`,
  the same route with `?groupBy=po`: one tab per PO per warehouse
  (`PO-1442 - DEN`), POs in numeric order, hand-typed lines on a
  `No PO - <warehouse>` tab. Each tab is a warehouse tab in miniature —
  category sections, the RAM device / DDR-generation labels and tints, tick
  boxes, subtotals and a PO total. Each tab adds a **PO #** column after
  Part # (v1.197.3; "ID in PO" until v1.236.0): the product's # on that PO. A row that folds several
  lots of the PO stacks their IDs in that cell the same way (`#2 × 13` above
  `#3 × 12`, v1.220.3); the tab already names the PO, so it has no `From PO`
  column. A tab is cut from the numbered products, so its rows run in the
  plain list's order under the same device and generation labels, with
  its own lots' details (v1.221.0). A warehouse picker at the foot of the
  Download menu (beside the buttons until v1.293.0; shown when the order's
  lines above 0 span more than one — a warehouse
  holding only 0 lines isn't offered, v1.220.2) narrows either packing list to
  one warehouse (`?warehouse=<short>`); the bid sheet always covers the whole
  order. Both packing lists place a line by where its lot is *now* — the lot's
  own warehouse, else its PO's — not the warehouse the line was saved with,
  so a lot transferred after it went on the order is picked where it sits
  (v1.189.1).
- **The three exports share one `Download` button** (v1.293.0): a dropdown
  in the page head with a row each for the bid sheet, the packing list and the
  packing list by PO, each row carrying its explanation as a subline, and the
  warehouse picker at the foot when there is one to make. The rows for the
  packing lists are greyed when every line is at 0; the button is disabled
  while a file is being prepared; Escape and an outside click close it.
- **Pack mode: a manager ticks the order into the box** (v1.218.0, desktop
  shell, built for an iPad). **Pack mode** in the sell order's page head opens
  `#/sell-orders/<id>/pack`, a full-window page with no sidebar, top bar or
  tweaks button. It is the on-screen form of the Packing list, and the
  outbound twin of the PO's Review mode, laid out like it since v1.227.0: a
  page head, a progress card, a table with the scan box over it, and a side
  panel with the selected item and a **Finish** card.
  - **Opening it moves a Draft to Packing** (v1.230.0), once per visit.
  - **The progress card maps the order** (v1.317.5). It has one cell per
    product, in # order, labelled with its #:
    - green once packed, amber while short, red at 0;
    - a dashed slot while waiting.

    A long order's cells drop their labels. The count beside it says what it
    counts: *products packed*, or *products packed, DAL only* under *Packing
    from*. The units sit at the end of the legend.
  - **The selected row is framed in ink** (v1.317.5): the row Space and a
    scan act on. Green only ever means packed. A product with no photo gives
    the Selected card one line, not an empty frame.
  - **Products run in the order's own list order**, # order (v1.220.3; by #
    since v1.219.0, grouped by source PO in v1.218.0). That is the Packing
    list's order, except for products added once the order was past Draft,
    which come last here. The packed ones sink to the bottom (v1.228.0,
    below). Each row leads with its product's `#`, the label the packer
    writes on the item, and names the lot it comes from (`From PO-1111 #1`,
    or *Typed in*). When
    the order's lots sit in more than one warehouse, a *Packing from* switch
    narrows the list without renumbering it. Space, the arrows and a scan act
    only on the picked warehouse's lots; a scan that finds a waiting lot only
    in another warehouse clears the switch and asks for a tap (v1.239.2).
  - **A product from several lots is one fold row** (v1.227.0). It shows the
    product's #, part, specs, how many lots and their PO tags
    (`PO-1111 #4, PO-1203 #1 +1`), and the summed count. It starts closed.
    The chevron (or ← / →) opens it to one row per lot, each with its own
    photo, count and tick — and its own part # and condition when they differ
    from the product's, as a lot corrected after it was numbered does
    (v1.235.0; the packing list prints such a lot as a row of its own). Ticking the product row packs every lot still at
    its full count. A lot that was lowered keeps waiting for its own tick, and
    the fold opens to show it. Once every lot is packed, the same tick unpacks
    them all. A product with some lots packed shows a dash in its tick. A lot
    held at 0 is left out of its product. A product whose lots are all at 0
    keeps one greyed row: *Qty 0 · nothing to pack*, with no counter or tick.
  - **Each row shows its lot's photo** (v1.220.0), loaded lazily; a tap zooms
    it, and Esc closes the zoom before it leaves Pack mode. A product row
    shows the first lot that has one. A line with no real scan (typed, or a
    stub scan) keeps an empty slot. The photo comes from
    `GET /api/sell-orders/:id` as each line's `imageUrl`.
  - A lot's count starts at its qty. − / + record a short pick (amber, *Short*)
    or none at all (red, *Not packed*), and lowering a packed lot unticks it.
    The tick confirms the count as shown. Undo reverses the last tick, a whole
    product's included, from a toast.
  - **Unpacking asks first** (v1.387.0). Taking the tick off a packed lot,
    or off a packed product (every lot), opens *Unpack this item?*; Unpack
    does what the tick did before, Undo toast included, and Cancel leaves it
    packed. Packing and scanning ask nothing.
  - **A packed product sinks under *Packed*** (v1.228.0), newest first, as
    Review mode's checked lines do. The products still to pack stay on top in
    # order, and *Hide* / *Show* folds the group away (hidden rows leave the
    ↑ / ↓ order). A partly packed fold stays up until its last lot is ticked.
    A product packed at 0 keeps its place: nothing of it went in the box.
    Ticking the selected product moves the selection to the next one still to
    pack, and a row that changes group slides there. From v1.219.0 to
    v1.227.0 a ticked row stayed in its place.
  - **On a Draft or Packing order the tick writes the count onto the order**
    (v1.228.0; Packing since v1.230.0). Ticking
    a lot below its qty sets that sell-order line's qty to the count:
    - it is an in-place edit, so the line keeps its id and its #;
    - History records it as the editor's own qty edit would be;
    - it clears a price adjustment, as an editor save does;
    - an editor opened before it can't save over it: a save whose lines
      changed since the editor loaded them is refused with "reload"
      (v1.239.2).

    A short pick then reads as packed in full and no longer blocks Mark
    shipped. One packed at 0 becomes the product's *Qty 0* row at the same #,
    and no product is renumbered. Unticking, Undo, or lowering such a line
    puts its qty back and keeps the count. That is refused if its lot was
    archived or sold meanwhile. A line at 0 can only be put back from the
    Undo toast; after that, Edit order does it. Shipped, Awaiting payment and
    Done orders keep their qty: the tick there is progress only.
  - **Apply sends every flagged count at once** (v1.229.0). A lot lowered
    with − and not yet ticked is only flagged (*Short*, *Not packed*). While
    any is, the Finish card on a Draft or Packing order lists each one by #, part and lot
    (`#12 PO-1111 #4 · Counted 0 of 2`), even while products are still left
    to pack, with **Apply n to the order**:
    - Apply ticks them all at their counts in one request, in one
      transaction. Each line goes to its count as its own tick would set it,
      a 0 included, keeping its id and its #.
    - A lot applied at 0 stays on the order at qty 0. Products packed in
      full sink under *Packed*.
    - One Undo puts every line's qty back, and the selection moves on as a
      tick's does.
    - A lot that is no longer lowered on the server (another iPad ticked it,
      the order was edited) is skipped.
  - **The side panel** shows the selected row: its photo large, part, From
    PO, warehouse, qty and count, and the serials on file. For a product it
    lists each lot's count. Tap a row to select it, or use ↑ / ↓; Space packs
    the selected row. The **Finish** card says what is left to pack. On a
    Draft or Packing order it lists the lots flagged short with **Apply**
    (v1.229.0), and the
    lots ticked short before v1.228.0 with **Edit order**. It also holds
    **Mark shipped**. The panel stays beside the list as it scrolls and is
    never taller than the window: on a short screen it scrolls by itself, so
    Apply and Mark shipped are in reach mid-list (v1.230.1). Below 1024px wide
    (an iPad in portrait) the panel drops under the list and the selected-item
    card is hidden.
  - The scan box takes a Bluetooth or USB label scanner, with nothing focused,
    and matches a part number, a prefix, a recorded serial, then any part
    number holding the text, as Review mode does. Typing filters the list
    the same way too (v1.222.0), with ×, Escape and a fragment that fits
    several parts behaving as in Review mode. The filter searches the whole
    order, packable lines only, even with a *Packing from* warehouse picked,
    so it never hides the line Enter would pack. A product holding a match
    is listed whole, opened while the filter is up. Progress stays on the
    warehouse view. When the part is still waiting on more than one lot, the
    scan ticks nothing: it opens those products, highlights the lots, names
    them by # and asks for a tap on the one that was packed.
  - **The filter also takes a PO number** (v1.241.0): `PO-1343`, `po1343` or
    `1343` lists the lots that came from that PO. Enter on one keeps the
    filter up and packs nothing, since a PO names lots, not one unit.
  - Progress is saved on the server (`sell_order_packs`), so a reload, a second
    iPad or coming back from another app picks up where the count stands; the
    page re-reads when it returns to the foreground. Last write per line wins.
    Progress is kept by the line's lot (or a hand-typed line's text), not its
    row, so saving the order keeps it. A line whose qty changes comes back
    unpacked, unless it was packed short and edited down to exactly the count
    packed. If the order itself can't be loaded, the list says so with *Try
    again* instead of loading forever (v1.220.2).
  - Every control is at least 44px; nothing needs hover. Below 900px the
    condition moves under the item.
  - On a Draft or Packing order with every lot packed at full count, **Mark shipped** opens the
    Shipped dialog (note, packing photos) and moves the order to Shipped.
    Unpacked lots block it, flagged ones included until Apply or their own
    tick sends their counts. Since v1.228.0 a short tick on a Draft has already
    set the line to its count. A short pack from before that release still
    blocks, and the Finish card offers Edit order to match the order to the
    box first. A refused move (a lot taken meanwhile) says
    why and stays on the page.
  - **Each packed product prints its label** (v1.329.0, RS-382; Bluetooth
    since v1.324.0, RS-374). In Auto, the tick that packs a product prints
    that product's label: a row, a whole product, a scan or Apply. Several
    packed at once print in # order, and labels asked for while one prints
    wait their turn. From v1.323.0 (RS-371) the tick that finished the box
    printed one label for the whole box instead; the box label is Review
    mode's now.
    - The label carries the SO number and the date, the product's # large,
      its part number, and the units of it packed. It is the # the packer
      used to write on each item, so the receiver matches an item to its
      line by it.
    - It prints once per product per visit. Ticking a product back and on
      again doesn't print another, a product packed at 0 prints none, and a
      second device packing the order prints nothing on this one.
    - In Manual, ticks print nothing, and **Print label** prints the
      selected product's label. Its tooltip names the product.
    - **The page head shows the label printer** (v1.324.0). It reads *Label
      printer off* with **Connect**, *Connecting…*, or *Label printer on ·
      <name> · Ready*. Where the printer reports a problem, the chip says
      *Out of paper*, *Cover open*, *Busy* or *Needs attention*. In a browser
      without Web Bluetooth it reads *No Bluetooth in this browser*.
    - Connect is Chrome's Web Bluetooth chooser. It works on the Mac, not in
      iPad Safari. The page asks for the five services label printers put
      their serial port on. It speaks the language the service implies:
      Zebra's is ZPL, FF00 is ESC/POS raster, the rest TSPL. The label
      settings can set the language by hand (`pack.labelLanguage`).
    - **Each service's port is named** (v1.327.1, RS-381): the characteristic
      a job is written to, and the one the printer answers on. Until then
      the page took the first characteristic that takes a write. On the
      office's CLABEL CT221D (Microchip's ISSC service) that one goes
      nowhere, so nothing printed. An unknown service's port is guessed,
      preferring a characteristic that acknowledges writes. Jobs go as
      acknowledged writes wherever the port takes them.
    - The status is asked on connect, every 15 s, and before each print, by
      TSPL's `ESC ! ?` or ESC/POS's paper sensor. A Zebra shows only
      connected, and so does the CT221D, which answers neither query. A
      printer out of paper, open or faulted gets no label, and a toast says
      why.
    - The printer stays connected across Pack and Review mode visits in the
      tab. **It reconnects by itself** (v1.330.0, RS-384). When the printer
      sleeps, is switched off or goes out of range, the chip reads *Waiting
      for <name>* and the page tries again, backing off to every 10 s, with
      no chooser. Meanwhile labels go through the print dialog. Connect
      still picks another printer, and Disconnect ends the wait and forgets
      the printer. A printer that comes back without a port the page knows
      is forgotten rather than waited for (v1.332.2).
    - A label asked for while the printer is *Connecting…* waits for the
      connect. It goes over Bluetooth once the printer is on, or through the
      dialog if the connect fails (v1.332.2, RS-389); until then it was
      dropped without a word. Labels and the bar's 15 s status checks reach
      the printer one at a time, so a check can't break a label mid-write.
      The dialog counts as done when the browser leaves print media, as well
      as on `afterprint`. A label that fails to draw shows a toast. Either way
      the labels queued behind it go on.
    - After a reload, the page can reach the printer without the chooser
      only through `getDevices()`. Chrome (155) keeps that behind
      `chrome://flags/#enable-web-bluetooth-new-permissions-backend`. With
      the flag on, the remembered printer is waited for on load the same
      way, and the page hears it advertise first. With the flag off, the
      label settings menu says so.
    - **Print label** sits beside the chip. With a printer on, it and the
      automatic print send the label over Bluetooth, with no dialog, and a
      toast confirms each one.
      Without one, they open the print dialog. The settings menu holds *Print
      when packed* (on by default), the stock (50 × 25 mm, the default since
      v1.327.1 and the CT221D's; 4 × 6, 4 × 3 or 2.25 × 1.25 in), the
      language, *Print with the dialog* and *Disconnect*. TSPL gets each
      stock's size and gap in its own unit (`SIZE 50 mm,25 mm`).
      Its choices are saved preferences (`pack.labelAuto`, `pack.labelSize`,
      `pack.labelLanguage`). The settings button shows *Auto* or *Manual*
      (v1.329.0).
    - The label is one drawn picture (v1.324.0). The printer gets it as 1-bit
      dots at 203 dpi, and the dialog prints it as an image at 300 dpi, at
      the stock's size, one label to a page. It is black on white for thermal
      stock. Stock under 1.6 in tall drops the date and the caption and sets
      the rest larger (v1.327.1, v1.329.0).
  - The endpoints (`GET /api/sell-orders/:id/pack`,
    `PUT /api/sell-orders/:id/pack/:lineId`, and
    `POST /api/sell-orders/:id/pack/apply` on a Draft or Packing order only) 403 anyone whose
    real role is not manager. An archived or Closed order opens read-only and its writes 409; a
    Done order can still be packed, since an order can be paid before it ships.

- **After-sales** (v1.251.0). A Shipped, Awaiting payment or Done order's
  page has an **After-sales** button that opens the new-case form with the
  order preselected, and a card in the side column listing the order's
  cases with their status, issue and amount. See [After-sales](#after-sales).
  The list has the same button in each eligible row's Actions column
  (v1.256.0), so a case can be opened without visiting the order first.

## After-sales

Managers only. A case is the record of a customer coming back about goods
on a sold order: what they report, which products and how many, and how it
ends — the goods come back (**Return**) or the customer keeps them at a
lower price (**Discount**). Purchasers never see the page or the API.

- **Opening a case** (v1.251.0). `#/after-sales/new`, or the After-sales
  button on a sell order's page or its row in the list (v1.256.0). The form loads the order, refuses one that is
  Draft, Packing or Closed (nothing has shipped, or nothing was sold), and
  lists its products with a checkbox and a quantity capped at the line's
  qty (typed freely, clamped when the field loses focus — v1.255.1). The
  issue is required; resolution, amount and assignee are optional
  at this point. Cases are numbered `AS-1001`, `AS-1002`… from their own
  counter. The products are snapshotted (label, part #, qty, unit price):
  a sell-order save rewrites its line rows, so the case keeps its own copy
  and the link to the live line only while that row exists.
- **The workflow.** Open → In progress → Awaiting return → Resolved.
  Cancel is allowed from any open stage; Reopen (to Open) from Resolved or
  Cancelled; Awaiting return can step back to In progress. Awaiting return
  needs the resolution set to Return (a discount has no goods to wait for),
  and keeps it: while the case awaits its goods an edit cannot change or
  clear the resolution (409; the select is disabled on the page), so step
  back to In progress first (v1.255.1). Resolved needs the resolution and
  the amount (0 is allowed). An illegal move is a 409 with the stages
  named. Each move takes an optional note; a blank one is no note. Resolved
  and Cancelled stamp `closed_at`; Reopen clears it.
- **The case page** (`#/after-sales/AS-1001`): issue, products, resolution
  / amount / assignee (managers only), the stage buttons for the moves the
  case allows (each asks for an optional note), and a timeline of every
  event — opened, moved (from → to), edited (which fields), noted — with
  who and when. A Resolved or Cancelled case is read-only until reopened;
  the timeline still takes notes.
- **The list** (`#/after-sales`): five tiles (one per status, clicking one
  filters) counting every case and summing its amounts, a status select, a
  search over case id, sell order id, customer and issue, and a table with
  case, sell order (a link), customer, issue, units, resolution, amount,
  assignee, status and last update. A row opens the case.
- **Record only.** The amount is stored on the case and summed on the
  tiles; nothing moves stock back to a PO, changes the sell order's revenue
  or the dashboard's realized profit. Restocking a return is an inventory
  edit.
- **The money a case pays out is booked in Accounting** (v1.310.0). The case
  page's *Accounting* card lists its refunds with their net and *Record
  refund*; the refunds also show on the sell order's card. See
  [RMB Flow](#rmb-flow).

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

Manager-only; the sidebar's **Accounting ▸ Payments** (v1.317.0), beside the
RMB Flow. Links **Mercury and PayPal transactions to purchase orders**, to a
PO's commission, or to sell orders (v1.257.0). Everything the Business
Account paid lives here; the RMB Flow is for money that did not go through
it.

- Transaction ingest with auto-pair and auto-link (v1.90.0), a background sync
  loop behind a manager-only API (v1.91.0), and a Payments page (v1.92.0).
  Search waits 200 ms after typing stops; filter chips apply at once
  (v1.179.0).
- **Internal Mercury↔PayPal transfers are classified out of the unlinked
  queue** (v1.93.0) by counterparty and Mercury kind rules (v1.94.0).
- **Automatic pairing is stricter about what it guesses** (v1.198.3).
  - An amount-and-date pair needs the Mercury row to name PayPal (its card
    descriptor or counterparty), and a transfer pair needs the `PAYPAL;` ACH
    descriptor. Every real pair in production carried them.
  - A pair is made only when each leg is the other's sole candidate within
    the window. A same-amount row from months ago no longer blocks a fresh
    match forever.
  - Rows unpaired for 120 days stop being re-examined unless they are still
    pending.
- **Ungrouping a pair leaves the PO link on the PayPal leg only**
  (v1.198.3). It used to stay on both, so the PO's paid figure counted the
  payment twice. Migration 0152 groups PO-1383's two $2,800 legs, which had
  the same problem. The freed Mercury leg carries the same PayPal id in its
  description, so since v1.200.1 it is also kept out of auto-link; until
  then the next sync linked it straight back.
- **A payment in another currency is not reconciled** (v1.198.3). Every PO is
  in USD, so a non-USD row is kept out of matching, pairing and auto-link,
  can't be linked or grouped by hand, and shows a "EUR · not reconciled" chip
  in the feed. Every prod row was USD.
- **Ignore rules** (v1.177.0). *Ignore rules* in the page header keeps a
  manager-edited list: a case-insensitive "contains" match on counterparty or
  description, optionally pinned to one source, with a label. A saved rule
  ignores every open matching row now (the editor previews the count and a
  sample first) and every sync re-applies the set. Rule-ignored rows read
  `Ignored · <label>`; deleting or editing a rule gives its rows back unless
  another rule matches them; a hand Unignore on a rule-ignored row sticks. A
  rule-ignored PayPal charge still pairs with its trailing Mercury settlement,
  which is then ignored with it. Everything still unlinked from before
  2026-08-01 was ignored once, by migration, in the same release.
- **The Mercury IO credit card is synced alongside checking and savings**
  (v1.176.0), so card charges appear, pending ones included. The card payoff
  from checking, like any move between our own Mercury accounts, is a transfer.
  The page does not show which account a row came from. Each account syncs
  from its own cursor. A card that `/credit` fails to list, or whose charges
  fail to load, is simply retried on the next run: checking and savings keep
  syncing, and payoffs stay transfers (v1.176.1).
- Unlinked transactions get **suggested matching POs** (v1.99.0).
- **A row links to one of three targets** (v1.257.0): the purchase order it
  paid (as before), that PO's **commission** — what the purchaser was paid,
  kept apart from what the supplier was — or a **sell order**, the money a
  buyer sent. *Link…* opens on three tabs; an incoming payment opens on
  *Sell order*, an outgoing one on *Purchase order*. The PO tab keeps its
  ranked suggestions; the other two list recent candidates (sell orders at
  Shipped, Awaiting payment or Done; POs at Ready to Pay or Done, with the
  purchaser's projected commission) and search by id, customer or
  purchaser, an exact amount badged and sorted first. A linked row reads the
  SO pill with the order's total, or the PO pill with a *Commission* chip. A
  commission link never counts toward the PO's cost paid — the Cost Payment
  ledger, the list's Payment cell and the payment-gap banner ignore it — and
  never fills the PO's transaction ID. A sell order's link reads by sign the
  other way round: money in is the buyer's payment, money out our refund.
  Unlink, group, ignore, assign and transfer treat every link alike, and
  grouping carries a sell-order link onto the sibling leg. A closed or
  archived sell order refuses the link. `#/payments/so/<id>` pins the page to
  a sell order with its net received; a pinned PO shows its cost and
  commission rows together, the net still the cost net.
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
  existed only to escape the one-click path. A transfer row has no `Link…`
  (v1.331.1). The server refuses it, because the PayPal leg of the same
  payment is the one that links, so the button could only fail. *Not a
  transfer* in the expanded row is the way back.
- **Owner is a column** (v1.121.0), between Amount and Status — avatar and first
  name, full name on hover, a dash where nobody owns it. Owner and PO are
  mutually exclusive by constraint, so a linked payment shows its PO's owner
  instead, and the owner filter counts it under that member (v1.275.2).
  Assigning still happens in the expanded row, on unlinked payments only.
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
  - **A closed case ends on Closed** (v1.221.2). PayPal leaves the stage where
    the case was decided — nearly always the claim — so the ladder used to keep
    that stage lit after the close. A resolved case's ladder now runs on to a
    highlighted **✓ Closed** step; the stages it went through stay grey, and
    the ones it never reached are dimmed behind dashed bars.

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
  - **A reversed payment stops counting towards its order.** It stays on the
    ledger, badged, but leaves the PO's linked total. A PayPal payment we sent
    is never reversed this way (v1.333.1). PayPal's `V` on it means the seller
    was debited for a case. If money comes back to us, it arrives as a credit
    row of its own (`T1106` reversal, `T1107` refund), or on Mercury after a
    card chargeback. If the case goes against us, as PO-1399's did, nothing
    comes back. Until v1.333.1 this bullet said PayPal reverses a payment in
    place. No such record has ever arrived.
  - **A payment funded by eCheck shows up while it is pending** (v1.331.1).
    Transaction Search returns only balance-affecting records by default, and
    an eCheck affects nothing until it clears 3–6 business days later. Until
    v1.331.1 the payment and its `T0300` funding stayed out of the ERP for that
    whole time. All the manager could see was the Mercury `PAYPAL; ECHECK`
    pull, a transfer that can't be linked. The sync now makes a second pass for
    all records and adds each transaction the first pass missed, at its latest
    record:
    - pending, if it is still in flight;
    - failed or reversed, if it bounced or was voided;
    - dropped, if its latest record is settled. That is a hold that moved no
      money.
  - **A bank-funded payment leaves pending once PayPal settles it**
    (v1.333.1). For a direct debit or eCheck, PayPal's balance record marks
    the moment the money was drawn, stamped pending, and the settlement
    arrives later in a record outside the balance. The sync read only the
    first record, so seven prod payments sat pending for months, PO-1383,
    PO-1386 and PO-1411 among them, and held the sync window open back to
    July. A pending balance record now takes the status of its latest record.
    No money moves: pending and settled count the same towards a PO and in
    the RMB ledger.

> PayPal's Transaction Search lags ~3 hours. A fresh transaction missing from
> Payments is usually that, not a sync bug — check `last_refreshed_datetime`
> first. Since v1.127.0 the other answer is that it is **pending**: it is
> ingested and badged, not missing. A pending eCheck payment was the
> exception until v1.331.1. If only its Mercury `PAYPAL; ECHECK` leg is
> there, query with `balance_affecting_records_only=N`.
>
> **The two record modes don't line up.** With `N`, PayPal answers with one
> record per state a transaction went through, and matches each record by its
> update date. With the default `Y`, it returns one record per transaction,
> matched by the date of its balance record. That is the initiation date,
> except for a bank-funded payment, where it is the day the money was drawn.
> `outsideBalance` and `currentStatus` in `banktx/paypal.ts` reconcile the two.

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

> **A partial sync failure shows too** (v1.193.0). When part of a source fails
> while the rest syncs — Mercury's card list, or one card — the account keeps
> `sync_error` and the Payments header shows a red *"<source> didn't sync"*
> chip; `/stats` reports the stalest account per source rather than the
> freshest, so a healthy checking account no longer hides a stale card. Each
> account is also re-read 60 days back once a week so a late reversal is seen,
> and a row pending for over 120 days stops holding the fetch window open.

## RMB Flow

Manager-only, both shells (v1.310.0; named *Accounting* until v1.317.0).
The managers' book of money received and paid **outside the Business
Account**, kept in **RMB**. The company's own money is Payments' — the USD
bank, reconciled there — and both pages sit under the sidebar's
**Accounting** parent. This one records what moves through the managers'
hands — a supplier paid by Alipay, a purchaser's commission by WeChat, a
customer's bank transfer, a refund on a case. Entries are a record only:
they change no PO cost, sell-order revenue or case amount (the one exception
is who paid, below).

- **An entry** says received or paid, what it was for, how much, how
  (bank transfer, Alipay, WeChat Pay, cash, other), on what date and through
  which manager, with an optional counterparty and note and the payment
  screenshots that prove it. Entries are numbered `AC-1001`, `AC-1002`… from
  their own counter. The form no longer asks for a reference (v1.333.0); an
  entry that has one still shows it, and an edit keeps it.
  - **The amount fills from the linked record or screenshot** (v1.345.0,
    RS-396). New entries open on the PO cost, projected commission, or sell
    order's figure in its native currency. A CNY sale opened from its order
    still offers the remaining sale payment. Switching CNY/USD converts the
    amount using the entered or latest rate; without a known rate a nonempty
    amount cannot silently change currencies. Screenshot recognition runs
    before saving and can fill amount and currency. A manual edit is never
    overwritten by a late recognition result; buttons offer the linked order
    and each readable screenshot amount. Several screenshots are offered
    separately, never summed automatically. Removing the selected screenshot
    returns an automatically filled amount to the order value. Unclear
    currencies or unreadable images leave manual entry available and keep the
    screenshot for upload. Existing entries open on their saved amount.
  - **What it was for is the record it names.** Purchase and Commission name
    a PO, Sale a sell order, After-sales a case; Other names nothing. The API
    refuses any other pairing. The kind sets the direction — a sale is
    received, the rest paid — and the manager can flip it for a supplier's or
    a customer's refund.
  - **RMB is the book's currency.** An entry may be in dollars: it carries the
    CNY-per-USD rate it was booked at (the FX ledger's latest unless one is
    typed), every total counts it at that rate, and the dollars show beside
    it. An RMB entry needs no rate, so it never waits on the rate service.
  - **Dates are calendar dates as typed.** The page's "today" is the viewer's
    own, not the dashboard's Denver clock: the managers keeping RMB books are
    most of a day ahead of Denver. Any date up to UTC's tomorrow is accepted.
  - **Edits keep a history** — recorded, changed (which fields), voided,
    restored, with who and when. **Void** needs a reason and takes the entry
    out of every total and balance; **Restore** puts it back. Nothing is
    deleted. A draft PO deleted after money was booked against it leaves the
    entry on the book without its link, and its history names the PO. The
    record is part of what was signed off, so the delete clears a sign-off
    and moves the entry's version (v1.317.4).
  - **Payment screenshots** (v1.333.0, RS-390). Each image is stored under
    the name the receipt OCR reads off it, `<date>-<method>-<amount>.png`,
    the same rename a PO's payment evidence gets. When the model can't read
    one, or no OCR key is set, the file keeps its own name. The rename never
    fails an upload. *Record entry* takes screenshots before the entry exists
    (pick, drop, or paste on desktop) and uploads them once it is saved. If
    one fails, the entry stays saved and a warning says to add it again from
    the entry. The drawer and the phone's entry screen add and remove them
    live; Review shows them read-only beside the figure. Adding or removing
    one is a history line and an Activity row (Added / Removed), and leaves
    the entry's version and sign-off alone: proof is not money. A voided
    entry's screenshots are read-only (migration 0205). Adding or removing
    a screenshot from Review's entry drawer refreshes the queue and the
    read-only evidence pane without a page reload (v1.344.1 on dev;
    v1.333.2 in production, RS-395).
  - **An entry's Paid by and its PO's payer are one value** (v1.317.0,
    migration 0199), kept in step both ways. *Paid by* is a person: an
    active manager, or on a Purchase entry the PO's own purchaser, who paid
    a self-paid cost or took the supplier's refund for it (v1.317.4). A
    payer deactivated since an entry was booked stays on it through other
    edits. The
    Business Account is never a payer here — its money is Payments'.
    - *PO → entry.* Whatever moves a PO's payer moves its live entries of
      that kind: the PO page's Paid by, a commission screenshot, a cost
      payer edited or handed off. The entry gets a *Paid by followed the
      PO* history line. Nobody on file leaves an entry as recorded. The
      sync is a database trigger, so no writer is missed. A move clears a
      sign-off on the entry, as an edit does (v1.317.2): see *What a
      sign-off covers* under review mode.
    - *The Business Account paid, so the entry goes.* When a PO's commission
      becomes company-paid (flagged on the PO, or a Mercury/PayPal row linked
      as the commission), or its cost flips to the company's account, its
      live paid-out entries of that kind are **voided** with the reason
      *Paid from the Business Account* and a *Voided: paid from the Business
      Account* history line; totals drop them. Unlinking the row or clearing
      the flag does not bring them back; **Restore** does, and an entry
      restored from that void is never voided by the PO again. One voided
      and restored by hand for another reason still is (v1.317.4). It
      catches up with the PO's person payer as it comes back (v1.317.3).
    - *Entry → PO.* Saving a Commission entry with Paid by X sets the PO's
      commission Paid by to X, with the PO's Activity line. Saving a Purchase
      entry with Paid by a person sets a self-paid PO's cost payer, except
      on a PO at Ready to Pay or Done, whose payer is settled as the PO page
      holds it (refused, v1.317.3). Two entries on one PO carry one payer.
    - *No paid-out entry for a PO the Business Account paid.* The form says
      so, with Paid by greyed and Save off; the PO's Cost Payment or
      Commission card says so in place of its Record button, with *Open
      Payments*; the API refuses. The flag or the link is undone on the PO.
      Money coming back (a supplier's refund, a commission clawback) is
      recorded as usual, and an entry restored there stays editable while
      its record, direction and Paid by stay (v1.317.3).
    - A PO picked for a Purchase entry carries its cost payer, and for a
      Commission entry its commission payer: the Cost Payment and Commission
      cards' Record buttons, on both shells, and the entry dialog's PO pick
      open on that payer. A payer picked by hand, or an entry being edited,
      is never moved by the record. The picker's PO line names the payer —
      *paid by Tim Wu*, or **Business Account**.
    - Entries written before the link were brought in line with their PO
      once: moved to the PO's person (*Paid by brought in line with the PO*)
      or voided when the Business Account had paid.
- **The book starts from the payers already on file** (v1.314.0, migration
  0196). A PO with a manager in Paid by is booked as a Paid commission
  through that manager, against the purchaser. It is the PO's projected
  commission in dollars at the FX ledger's rate for its day. A Done sell
  order with a payment receiver is booked as a Received sale through the
  receiver, against the customer, at the order's total in its own currency.
  - A commission is dated by its first screenshot or its move to Done,
    whichever came first. A sale is dated by the day it went Done. Both
    use China's calendar.
  - The method is the one the order's receipts agree on, read from the
    receipt rename's names, and Other otherwise. The receipts' amounts are
    not used: one transfer can cover two POs or carry the cost too.
  - Left out: a commission the company paid (on file, or a bank row linked
    as the commission), and any record that already had an entry.
  - Such an entry's history names no one: *Backfilled from the PO's Paid by*
    or *from the sell order's payment receiver*.
- **The page** (`#/accounting`, the sidebar's **Accounting ▸ RMB Flow**,
  beside Accounting ▸ Payments; the page-sub prints the breadcrumb).
  - The period (the dashboard's chip, *This month* by default) and the
    manager (all, or one) are the band's scope.
  - **The band** states the period as an identity: *Opening + Received − Paid
    = Closing*, with Received and Paid broken down by kind, the closing figure
    double-ruled. Under it, *Held by* gives each manager's balance on the
    closing date — received minus paid; below zero the company owes them. A
    name there scopes the page to that manager.
  - **The book** has Date (printed once per day), Entry, For (kind, the record
    as a link, counterparty, note), Paid by, Method, then **Received, Paid and
    Balance** columns: direction is the column a figure sits in. Balance is
    one company-wide book (v1.317.0): what the whole book held after that
    entry, from the first entry on, so the payer, direction, kind, method and
    search filters hide rows without changing any balance. *Show voided*
    lists voided entries struck through.
  - A row, or `#/accounting/AC-1008`, opens the entry in a drawer: the record
    it is for (with that record's own figure and what the book has against
    it), every field, the history, Edit, Void and Restore. *Record entry*
    opens the form: direction, kind, a record picker searched by id or name,
    amount in ¥ or $ with the RMB it books as, date, method, Paid by (the
    Business Account or a person), counterparty, screenshots and note.
- **On the records** (managers only), an *Accounting* card shows what the book
  has against the record, what that comes to, the record's own figure and a
  Record button with the record already chosen:
  - the PO's **Cost Payment** tab (Purchase entries, net paid, the PO's cost ≈
    ¥ at the latest rate) and **Commission** tab (Commission entries, net
    paid, the projected commission);
  - the **sell order**, beside the bank payments (Sale entries plus its cases'
    refunds, net received, the order total in its own currency); a receipt
    starts on the order's payment receiver, and on a CNY order with the
    amount still owed;
  - the **after-sales case** (its refunds, net refunded, the case amount).
- **On the phone**, Home links managers to the RMB Flow screen: period chips
  (this month, last month, last 30 days, this year), a manager chip row, the
  period as a vertical sum with each manager's balance, an All / Received /
  Paid switch and the entries by day. `+` records an entry in a sheet; an
  entry opens on its own screen with Edit, Void and Restore. The phone PO
  page's Cost Payment and Commission folds carry the order's entries and a
  Record payment button.
- **Every entry is signed off by a manager who didn't write it** (v1.315.0,
  RS-350; desktop).
  - **Who writes, who signs.** The author is whoever recorded the entry, or
    later changed a field the sign-off covers. The author can't sign off
    their own version; any other active manager can, the entry's own manager
    included. Entries the 0196 backfill wrote have no author, so any manager
    reviews them. With one active manager, nobody can, and the strip says a
    second manager is needed.
  - **What a sign-off covers.** Every field but the note. An edit to any of
    them clears the sign-off, and so does a Paid by that follows its PO to
    another person (v1.317.2). The history line reads *Paid by followed the
    PO. Review cleared*, and the queue row and review card say *Paid by
    followed the PO*. Since v1.317.4 the manager whose save moved it (the
    PO page, a bank link, another entry) is the new version's author, so
    they can't sign their own move off. A purchaser's save or the bank sync
    leaves the author as it was. The entry then
    reads *Changed since review*, with the old and new value of each field,
    until someone other than the editor signs it again. A note-only edit keeps
    the review. A sign-off names the version the page showed, so an
    out-of-date page gets a 409 and re-reads. A void takes the entry out of
    review, and a restore brings it back To review. The reviewer can withdraw
    their own sign-off, which puts back the open question or the *Changed
    since review* it closed (v1.317.3).
  - **Query.** A reviewer who can't sign asks the author a question (up to
    280 characters). Where an entry has no author, the question goes to the
    manager whose money it was. The question stays with whoever it was asked
    of, even if the PO moves the payer later (v1.317.4). That person is
    notified, and the entry waits
    under *Queried* until they answer or edit it. An edit counts as the
    answer. The exchange stays on the entry until the next sign-off, and a
    sign-off closes an open question.
  - **Review mode** (`#/accounting/review`) is the PO's Review mode for the
    book: full width, no sidebar.
    - Tabs: *For you*, *Queried*, *Waiting on others* (your own entries) and
      *Reviewed* (the last 30 days). The queue runs oldest first and is not
      limited to the book's period.
    - A tally counts entries and yuan reviewed in the visit.
    - Each row's mark signs it off, as does Space. A row signed off here
      sinks under *Reviewed in this visit* with an Undo. ↑↓ / j k move,
      `q` queries, `e` opens the entry's drawer, `u` undoes the last action,
      Esc leaves.
    - The side panel shows the entry, then its checks:
      - the record's own figure against what the book has on it, at the FX
        ledger's rate for the entry's day: matches within 1% or ¥10; over
        warns, short only informs;
      - a dollar entry's rate more than 2% from the ledger's that day;
      - a look-alike live entry within 7 days (same direction, kind, amount,
        currency, method and record, or counterparty on an Other entry);
      - a Sale whose sell order has a live Mercury/PayPal deposit linked as
        its payment (*Also on Payments*, v1.317.4): that money is the
        Business Account's, and only what reached a manager belongs here.
    - Checks are hints, never gates. *Mark n reviewed* signs off in bulk only
      To review entries with no warning, after a confirm that lists them, and
      the server checks each one again. A long queue goes in batches of 200
      (v1.317.4).
  - **On the book:**
    - *Log* · *Review mode* (with what waits on you) · *Record entry* in the
      head.
    - A Review filter.
    - A Review column past Balance: the reviewer's first name on a tick, a
      dashed ring on your own entry, an amber loop when changed, a blue `?`
      when queried.
    - A *Reviewed* strip in the band, over the band's scope: entries and yuan
      reviewed, what is for you, queried and waiting on others. A period with
      every entry reviewed says so; there is no separate period sign-off.
  - **Elsewhere:**
    - The sidebar's RMB Flow item counts the entries and questions waiting
      on you, and the Accounting parent carries the count while folded
      (v1.317.3).
    - The entry drawer carries a Review card with the viewer's own actions.
      Its *Changed since review* comes from the server, worked out the same
      way as Review mode's (v1.318.1), and who may sign, ask or answer is
      one rule the API and both pages share.
    - Editing a reviewed entry warns that saving clears the review.
    - The history logs every sign-off, withdrawal, question, answer and
      clear. The phone shows those lines too, but has no Review mode;
      `#/accounting/review` opens the book there.

## Transfers

Internal stock movement between warehouses, with a manifest view and its own
status guard.

- **Units a committed sell order holds cannot be moved** (v1.191.0). A
  transfer may take only `qty − committed` from a line (committed = what
  Shipped and Awaiting-payment sell orders name); more is refused with a 409
  that says how many are free. Before, a partial move split reserved units into
  a clone the sell order's Done never touched, leaving phantom stock. The
  modal now caps each line at its free units and says how many are committed
  (v1.197.0).
- **Moving a whole line a Draft names asks first** (v1.197.0). The line goes
  out In Transit, so the draft can't be promoted until the transfer is
  received. The server answers 409 with the drafts, and the modal names them
  and moves only on "Move anyway".
- **Receiving a transfer restores each line's own status** (v1.193.0) — the
  `prior_status` its transfer recorded, Reviewing or Done — instead of
  promoting every line to Done; reopen accepts either. The transfer-orders list
  pages by cursor (`?limit=&cursor=`) instead of stopping at 200.

## Market values

Reference prices per part, readable and writable by managers, and reachable
over MCP.

- Paginated with infinite scroll (v1.12.0), sortable by clicking column headers
  (v1.67.0).
- **The expanded row shows no invented figures** (v1.258.5). It used to chart
  70% of each sell price as Cost beside real sales and list the average sell
  price nudged by a few percent under each price-source name, counting those
  as sources in its confidence note. It says "no cost data" and "no feed
  connected" instead, and counts only the team's own sales.
- A line can be priced while the buy can still change (v1.54.0).
- **Phone Market value cards** headline the sell price that Max buy is
  computed from (the last price, else the average sell), labelled and shown
  to the cent. When an average sell price exists and differs, the expanded
  card lists it too (v1.377.3).
- **Four feeds write `last_price`**, each tagged in the event's source: the
  scraper and MCP connectors (`scraper:`/`mcp:`), a manager's manual entry
  on the Market page (`manual:`), a sell order reaching Done (`sale:<order>`),
  and a price-list import on the Market page (`import:<email>`, v1.247.0).
  A fifth, a sell-order save that followed a confirmed vendor price import
  (`bid:<order>`, v1.138.3), was retired with that import in v1.297.0; its
  events stay on file. The Activity page shows the source per row; the
  Market page shows only the price and its age.
  - **The scraper's push** (`POST /api/market/values`, bearer
    `market:write`) works on a part that has no price yet (v1.329.1). Until
    then, a part auto-tracked from a PO made the whole batch fail, so no
    scraper price had ever landed. The push also sets the trend arrow to the
    change since the scraper's previous push, as a percent; a part's first
    push reads as flat.
- **Import prices from a spreadsheet** (v1.247.0, managers, desktop). The
  manager drops an `.xlsx`, and only its Part Number and Unit Price columns
  are read. The preview shows current → new price and max buy for every part
  already on the Market list. It lists the rows it skips: unknown parts (no
  row is created), blank or 0 prices, prices in a currency other than dollars
  or yuan, and an earlier row for a part listed again. One click records the
  rest, with the file name as the event note, and each part's max buy follows
  its new price.
  - **Dollars or yuan** (v1.286.0). A **Prices in** USD / CNY (¥) switch,
    USD by default, sets what an unmarked price is in. Flipping it on the
    preview re-reads the same file. Yuan convert to US dollars at the FX
    ledger's latest rate (Settings → FX), rounded to cents. The preview shows
    the yuan under each converted price, plus the rate as `1 USD = N CNY
    (source)`. A price that names its own currency keeps it whichever way
    the switch is set, so a `Unit Price (USD)` column is never converted and
    a `¥` cell in a dollar list is. A yuan price under half a cent counts as
    no price. Apply writes the USD prices the preview showed.
  - **Reading the sheet** (v1.247.1, shared with the bid import): a Unit
    Price column wins over another price column (List, Last) and an Ext. or
    Total one is never read; 型号 wins over a row-number 编号; hidden tabs
    and a merged title row are passed over; a second header further down a
    tab starts a section read by its own columns; a decimal comma reads as
    one (`12,50` is 12.50). A row's currency comes from its cell, the cell's
    format, the column header or the tab name, in that order. 美元 reads as
    dollars, and so does a bare `$`, but not HK$ or a format's `[$€-407]`
    (v1.286.0). 元 marks yuan only on its own (单价（元）, 300元), not inside a
    word such as a 电子元器件 tab (v1.291.1). The Market import skips a row
    marked in any currency but dollars or yuan.
  - A list with more than 5,000 matched parts is refused at the preview, the
    same cap the apply holds, and the apply writes the whole list in two
    statements (v1.247.1).

## Activity and audit

- **Manager-only Activity page** unioning four ledgers — `order_events`,
  `sell_order_events`, `inventory_events`, `ref_price_events` — into one
  reverse-chronological register (v1.37.0), filterable by area, action, person,
  date range and free text. Raw kinds normalise to one vocabulary so query and
  labels can't drift.
- **The Accounting book is the fifth ledger** (v1.315.0, RS-350).
  `accounting_entry_events` joins the union as the *Accounting* area, with a
  darker ink stripe. A row names its entry and opens it, and reads the change
  in the book's own words: fields, yuan, the question's text. The action
  filter gains *Reviewed* and *Query*. The area travels in the address
  (`#/activity?area=acct`), so the book's *Log* button lands filtered. The
  table is append-only by trigger from 0197, like the other four. A row
  nobody made says what did it in the person column, as the entry's history
  does: *Paid by followed the PO*, *Voided: paid from the Business Account*,
  or the backfill (v1.318.1). A diff names payers who have left too.
- **A tab gets only the areas it can draw** (v1.318.1). The page sends its
  list (`areas`), and the server leaves every other area out of the rows and
  the counts. An area a later release adds never reaches a tab still open on
  an older bundle, which in v1.317 crashed on opening an Accounting row.
- Loads as you scroll, with a pinned column head (v1.38.0), and "Open record"
  opens the record (v1.51.x).
- Member/permission changes are **absent** — they write no audit rows
  anywhere today.

## Home

What is waiting on the viewer (v1.350.0). `/` on both shells, and where an
unknown path lands. The money figures moved to Analysis, below. One request,
`GET /api/home`, scoped by the effective role, so a manager previewing as a
purchaser gets the purchaser's Home over their own work. Every count reads
the predicate of the page it opens. Home re-reads on returning to the tab and
every two minutes.

- **Purchasers:**
  - A count of their POs at each stage, Done included in full, as the list each tile opens shows it (v1.367.2).
    Each count opens the PO list filtered to that stage (`?stage=`).
  - Their open POs, drafts first and then the longest-waiting. Each row
    gives the stage, the days in it (amber at 3, red at 7) and what it is
    waiting for: a draft's missing hand-off pieces (the hand-off's own
    blocker list), the box's ETA or exception, a pickup, the manager's
    review, or the commission payout.
  - Their packages that are moving or need a hand, in the inbound-counts
    buckets.
  - Commission owed (Ready to Pay) and paid in the last 30 days.
  - Client follow-ups due or due this week.
- **Managers:**
  - Tiles for arriving today or tomorrow, packages needing a hand, POs in
    review, purchaser edits to check, commission to pay, sell orders to sign
    off, unlinked payments out, and RMB Flow for them.
  - The review queue, oldest first, with box-check progress, open AI findings
    (error and warn) and who has it, plus unacknowledged reverts.
  - Inbound packages, problems first, then by ETA; pickups in transit are
    counted too.
  - Money to move: Ready to Pay and its commission, sell orders awaiting
    payment, unlinked payments, disputes.
  - The sales pipeline: drafts (connector-made ones counted), Packing
    progress, and the Shipped / Awaiting payment orders this manager has not
    signed as they stand.
  - The side queues: after-sales, transfers, new web submissions.
- **Days in a stage** come from the newest stage move in `order_events`. POs
  carry no stage-changed column.
- **On the phone** the same highlights are compact rows. They link only where
  the phone has a screen.

## Analysis

The money dashboard, at `/analysis` (it was `/dashboard`, the home page,
until v1.350.0, and that path still resolves). Managers get a second tab,
**Inventory** (`/analysis/inventory`), the stock snapshot that was Inventory ▸
Analysis; a purchaser sent there lands on the first tab. On the phone it is
the Numbers screen, opened from Home.

Per-role. Purchasers see projected profit from their own Done POs (v0.1.10).

- **Every sale counts, costed or not** (v1.258.5). A manual sale line — sold
  with nothing on the shelf — and a line whose PO source was since deleted
  used to fall out of revenue, the order count, the chart, the category
  rollup and the contribution cards, so the sell-orders screen showed Done
  orders the dashboard did not. Revenue and counts now include every line;
  cost, profit and commission are summed only where a PO line exists to
  price them, and the gross-profit tile says how many sales, and how much
  revenue, carry no recorded cost. On the contribution cards such a sale
  sits on the no-purchaser row, the no-supplier row's twin. The phone's
  profit sparkline keeps a loss period on the chart, with the zero line
  drawn when there is one.

- **The money reads the right facts** (v1.198.0):
  - A sale belongs to the day its sell order became Done
    (`sell_orders.done_at`), for the tiles, the chart and the contribution
    cards. Until then it was dated by `updated_at`, which a later note,
    attachment or archive moved. A reopen and a second Done keep the first
    date (v1.312.1).
  - A manager's realized cost and profit count a negotiated lot price: a
    $950 lot sold for $150 is a $800 loss, the same figure the PO page's
    Realized column shows. Commission stays on the line costs, because the
    lot price never enters commission.
  - A purchaser's projected figures are over the PO as bought, so selling
    part of a line no longer lowers the commission they were shown.

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
  commission becomes owed (v1.132.0), sold or not. A purchaser sees every peer's rank but
  only their own money, so the ranking is computed server-side.

## Oversight extras

- **Tracker** — admin page and API proxy for the Reddit listing monitor, with a
  fleet status filter and infinite scroll (v1.64.0, v1.65.0).  In the sidebar
  it is **Monitors ▸ Reddit** (v1.207.0). Since v1.283.0 it has the Facebook
  fleet page's layout: a Live / Stale / Dead legend whose counts filter the
  workers table, a **Recent matches** aside beside the table, and a **From a
  post to an alert** card with Poll, Evaluate and Notify stages. Subreddits
  are edited under Poll and alert rules under Evaluate. Since v1.284.0 the
  proxy forwards `/matches` and `/stats`, so the aside lists matched posts
  and the stages show post counts (collected, matched, alerted; waiting,
  rejected and oldest waiting under Evaluate). Since v1.287.0 those counts
  cover the posts discovered in the past 24 hours, not all time. Oldest
  waiting and the failed list still look at every post. If either read
  fails, that part shows a dash or a note.

  Since v1.316.0 the page has the Facebook page's tabs: **Fleet**
  (`/tracker`) and **Prompts** (`/tracker/prompts`, the card below),
  and the title follows the tab. Since v1.346.0 (RS-398), a third tab,
  **Workflow** (`/tracker/workflow`), holds the **From a post to an alert**
  card with its stage counts, subreddit editor and model picker. Since
  v1.386.0 (RS-464), Evaluate shows the live prompt read-only (base prompt
  plus enabled rules) where the rule editor was; prompts change through a
  trial on Prompts.
  Fleet shows the worker legend, workers table and recent matches.
  The workers toolbar matches
  the Facebook one. A search box on the left finds a worker by id or role,
  across the whole fleet rather than the rows scrolled in: while a search is
  typed, the table loads every worker the status filter allows in one
  request (the tracker's cap is 500) and filters them in the browser. On the
  right, a summary reads workers, posts in the past 24 hours, alerts,
  subreddits watched and rules on. *Clear filters* resets the search and the
  legend together.

  Since v1.291.0, a **Which prompt is better** card scores every prompt
  version by its leads. A lead is an alert someone reacted to with anything
  but 👎.
  - For each version it shows posts judged and flagged, buyer leads as
    "x of n", and the dev chat's 👍 and 👎.
  - It covers 7 days, 30 days or all time.
  - While a candidate prompt is on trial, the card sets its verdicts against
    the live prompt's on the same posts. It warns until 20 posts are
    labelled.
  - Managers start, edit, end and promote trials there. Promoting switches
    the rules off, because the candidate was judged without them.

  Since v1.295.0 the Evaluate stage shows the live model as a chip and a
  manager can change it there, as a free-text OpenRouter id. The fleet
  switches within a minute. The proxy opens only that one tracker setting;
  the base prompt and the rest stay behind it. Since v1.298.0 that field and
  the trial dialog's model field pick from OpenRouter's catalogue, with each
  model's price per million tokens and context size. The list holds only
  pinned models that can return the strict JSON the evaluator asks for. Since
  v1.310.1 both fields save only a model the list holds. A typed id it lacks,
  or a model without strict JSON output, is refused, because the evaluator
  can't read a prose answer. The ERP backend fetches the
  catalogue (`GET /api/ai/models`) and keeps it for an hour.
  - Since v1.292.0, each version is labelled *verdict first* or *reasoning
    first*. That's its response schema. The tracker has asked for the
    reasoning first since RS-312.

  Since v1.362.0 (RS-413), a fourth tab, **Analytics** (`/tracker/analytics`),
  covers 24 hours, 7 days or 30 days:
  - **Tiles:** alerts sent, the share of them buyers reacted to as a good
    catch (any emoji but 👎), missing posts, time from post to alert, and
    cross-posts held back.
  - **Chart:** alerts and good catches by hour or day.
  - **PM demand:** a tracker worker counts the buyers who commented "PM" on
    each post once it is a day old. A memory post with 5 or more PMs and no
    good-catch reaction is *missing*, and the tab lists each one with the
    prompt's reason for rejecting it. PM figures cover the same span a day
    earlier.
  - **Per prompt version:** judged, flagged, good and 👎, and PM recall.
  - **Per subreddit:** posts, memory posts, alerts, good-catch rate, average
    PMs and missing.
  - **Missed leads** (1.384.0): the missing posts, the per-subreddit table and
    the other posts buyers wanted sit in their own card under the rest. Each
    column title sorts, and each table scrolls past 520px under a pinned
    header.

  The same release made a listing cross-posted to several subreddits, or
  reposted within 72 hours, alert once. The other copies are held back as
  duplicates and stay out of Recent matches.

  Since v1.370.0 (RS-428), a fifth tab, **Seen** (`/tracker/seen`), shows who
  read the buyer alerts of the last 24 hours:
  - **Tiles:** alerts sent, how many someone saw, and how many people in the
    alert group read any.
  - **People:** everyone in the alert group (and anyone who read an alert and
    then left), with how many alerts each saw and when they last read one.
    Since v1.370.2 (RS-430), "saw x of n" counts only the alerts sent to that
    person's own chats.
  - **Alerts:** each alert with the names of the people who read it, out of
    the people in that alert's chat (v1.370.2).

  Telegram gives read receipts only to the user account that sent a message,
  never to a bot. So when the tracker's api has a Telegram user session
  (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_USER_SESSION`), buyer
  alerts go out as that account. If that account can't send to a chat, the
  bot sends there instead. The bot still gathers reactions and sends the
  dev-chat reviews. Without the session, the bot sends everything as before,
  and the tab marks those alerts *no receipts* and explains why.
- **WeChat market** — **Monitors ▸ WeChat** (`/wechat`, v1.312.0), managers
  only. memtrade, a tool on the office Mac, reads the team's WeChat trading
  groups and builds a daily memory-module report for each 08:00 → 08:00 ET
  window. It pushes each day here after its 08:00 run and again whenever it
  redoes a day; a push replaces the whole day. The ERP only stores and shows
  it: nothing feeds Market values or any order.
  - One report day at a time, picked from a dropdown or with the arrows.
    The newest is `/wechat`; `/wechat/<date>` links to one day.
  - Since v1.316.0 the page has the Facebook fleet page's layout. Two tabs,
    **Price board** and **Groups**, each with a count, sit under the title;
    the tab holds across a change of day. Above the board, a legend of
    memtrade's supply reads (Short, Tight, Balanced, Loose, Glut) counts the
    lines in each and filters the board to one; the counts follow the line
    family, *Priced lines only* and the Refine chips (v1.318.0), not the
    search. The board's toolbar puts
    the search first and a summary on the right: buyers, sellers, trade
    posts and groups with messages, with the change in buyers and sellers
    against the day before on hover. Its foot carries the shown/total line
    count and the report's window. The four KPI cards are gone.
  - Since v1.318.1 the search works as on the fleet pages: every term, in
    any order and across name, spec, code and part numbers (`ddr5 64g`),
    highlighted on the board. The tabs are links, and the Groups tab rides
    the address (`?view=groups`), so a reload or a copied link opens it.
  - Claude's market notes, **Most wanted** and **Most offered** (the specs
    with the most buyers and sellers) sit in an aside beside the board, or
    above it below 1190px (v1.316.0). Clicking a spec shows it on the
    board, clearing the supply filter and turning *Priced lines only* off
    when the spec has no price (v1.312.2), and clearing the Refine chips
    (v1.318.0).
  - The **price board** lists every line by brand & code (三星 64G 5600 DM0),
    by spec (64G 5600) or by part code (32G DM0). Since v1.318.0 the brand
    and the DDR generation have columns of their own; before, brand & code
    lines sat under brand header rows and the generation sat under the
    module. Brand & code lines sort brand-first. Spec and part-code lines
    have no brand, so their boards show *Generation* alone. Each line shows the bid (buyers) and ask (sellers) median
    with its tax basis, how many traders quoted and their range, a bar of
    both sides' ranges with the spread or a crossed market, buyers and
    sellers, memtrade's supply read (short to glut), and each median's
    change against the day before. Changes and spreads compare one tax
    basis only: a 含税 and a 未税 price are never set against each other.
    Search and *Priced lines only* filter it. A quote with no brand reads
    *No brand given* and sorts last, whether memtrade wrote 未注明 or
    nothing (v1.312.2).
  - A **Refine RAM** panel on the board (v1.318.0) is the inventory page's
    panel of chips: Generation, Speed, Brand (brand & code only), Capacity,
    Device (Server/PC) and Rank, each chip with the lines it would show.
    Chips are OR within a row and AND across rows. Each row counts under the
    other rows' picks, *Priced lines only* and the supply legend, not the
    search. A pick nothing matches any more stays, at 0, so it can be
    unpicked. Picks hold across a change of day and of board; the toolbar's
    *Clear* and the panel's *Clear all* drop them.
  - Opening a line lists its posts, newest first and up to 100: who, what
    price and quantity, the raw line, which groups and how many copies.
    *Bids* and *Asks* ask for each side's own newest 100 (v1.312.2).
    Under them (beside them before v1.316.0) are the bid and ask medians
    over the last 30 report days,
    drawn in the one tax basis most of them were quoted in (v1.312.2), and
    every price by tax basis. Since v1.326.0 the chart has a price scale and
    a date for each day, and draws the board's ladder for each day: each
    side's low-to-high quotes as a bar in its own lane, bid left and ask right,
    with the median on it. A dashed bridge crosses days a side wasn't quoted,
    and each side's latest median is labelled. Hovering or focusing a day
    (←/→ to step) shows both sides' medians, trader counts, ranges and the
    spread, plus a price quoted only in another basis.
  - A group with no name shows its id, and a sender with no display name
    their WeChat id (v1.312.2). A link to a date that can't exist reads as
    no report for that day.
  - A banner says when memtrade fell back to its rules for a day (Claude
    was unavailable), when only part of a day's posts arrived, and repeats
    memtrade's own warnings. **Groups read**, on the Groups tab since
    v1.316.0 and always open, lists each group's messages that day and
    marks the ones joined in it.
  - **Re-run** (v1.363.0) beside the day picker, and *Re-run with Claude*
    in the rules banner, asks memtrade to redo the day: after Claude was
    out, say. The ERP can't reach the office Mac, so the request is queued.
    memtrade polls every minute, claims it, reruns the day, pushes it as
    usual and reports back. The page shows *Queued*, then *Re-running*, and
    reloads the day when it's done. It says so when Claude was still out
    and memtrade fell back to its rules again, and shows memtrade's error
    when the run failed. A second click joins the open request. A claim
    memtrade doesn't finish within 2 hours is marked failed, so the day
    can be asked for again. memtrade claims and finishes with the same
    `wechat:write` token (`/push/reruns/claim`, `/push/reruns/<id>/finish`).
  - The push (`/api/wechat-market/push/*`) takes a Bearer token with the
    `wechat:write` scope from a service client a manager creates under
    Settings → Connectors. The day comes first, then its posts in batches
    of 500. Since v1.312.2 the day's push answers with a `pushId`. A batch
    that names an earlier one is refused (409 `day_replaced`), so a batch
    left over from a run the day has since replaced can't land in the new
    one. Timestamps must be ISO 8601 with a zone, as `toISOString()` writes
    them.
- **Coordinator** — the Facebook fleet, reached from **Monitors ▸ Facebook**
  in the sidebar (v1.207.0), managers only. Since v1.263.0 the Fleet tab
  shares the Account pool tab's chrome: a status legend (Live, Stale, Needs
  attention, Offline) whose counts filter the table; a workers table that
  fits beside a **Recent activity** aside of the same height (latest sweeps,
  listings, session backups, workers gone silent and open checkpoints, rebuilt
  from the timestamps the coordinator serves; since v1.349.1 it stops at 560px
  and scrolls) — login, region, status with
  its reason, session days left, and since v1.266.0 the worker's **Today**
  (a 24-hour strip in its region's time zone: when the sweep started, how far
  it got, the now tick, the estimated end while it runs, the next scheduled
  start when nothing has run, and a hatched day for a worker that is down,
  with "start–end · local time"), its **Searches** against the day's budget
  (enabled phrases × cities × daily runs; amber once met, "—" when its
  monitor does not count searches) and its **Posts** (listings freshly
  reviewed today, and the week's alerts); the summary line adds the fleet's
  new posts today. Since v1.268.0 the row's subtitle carries the worker's
  reported build next to its region, and the fold per row shows only the
  worker's cities (each with its alerts). Since v1.271.0 a city chip there
  and on the worker page is green only once the worker has searched that
  city today, in its region's time zone; the rest stay grey (v1.271.3: a
  facade that does not report searched cities falls back to green for a live
  or stale worker). Since v1.281.0 the Worker, Status, Today, Searches,
  Session and Posts headers sort the table (click: descending, ascending,
  back to fleet order; Today sorts by last heartbeat, and unknowns stay at
  the bottom either way). Since v1.283.1 the Status cell shows the worker's
  last heartbeat age under its chip, the beat that status is judged from.
  Since v1.285.0 Recent activity also lists every status change the
  coordinator logs: went stale, went offline, is reporting again, reported
  for the first time, needs attention (with the reported state, such as
  Session expired) and is healthy again. Each is dated when it happened and
  its dot shows the status it moved into; the worker page's History lists the
  same for one worker. Against a coordinator without the log, the aside falls
  back to the old "stopped reporting" line. Since v1.300.0 the table shows
  at most 15 workers. The rest scroll under its pinned headers, so neither
  the table nor the aside grows past that. Since v1.309.0 the table has one
  row per worker and no dividers. A **Proxy** column after Worker shows the
  port and exit IP (or *VM's own IP*), and under them the exit city and state.
  The ISP is in its tooltip. A worker whose exit IP another worker also uses
  is marked *shared*, and that tooltip says to keep their cities and sweep
  times apart. The column sorts by port, with the VM's own IP last, so each
  pair sits side by side. With no sort, rows keep the fleet document's order.
  The search box matches the port, exit IP, city and state. (v1.303.0 to
  v1.305.0 grouped the table by city, then by city and proxy, then by proxy.)
  Since v1.319.0 (RS-365) a proxy is **DEAD** once more than 4 distinct
  accounts have failed behind it: an account fails when it leaves a worker on
  that proxy as Problem or Retired (Assign's "where does the old one go", the
  weekly check, an edit or retire). The column shows a red DEAD chip, or
  "n failed" below that, counted across every worker that dials the proxy.
  Assign refuses a worker behind a DEAD proxy before anything reaches it (the
  dialog says so and keeps Assign off), until a manager presses **Revive** on
  a worker's page, after swapping the IP; the count then starts again. The
  worker's page also lists **Accounts used**: every pool account it has
  signed in with, newest first, with the proxy it went out through, from and
  until, and how it ended (on now, returned, Problem, Retired, moved to
  another worker, removed). Stints from before v1.319.0 come from the pool
  ledger and say "proxy not recorded", so they do not count toward DEAD.
  Since v1.320.0 (RS-366) a row there unfolds into the account's
  **timeline**, newest first, across every worker it was on: each login the
  workers attempted for it (Login success — session restored / password /
  finished in Watch, Login failed, Checkpoint, Locked by Facebook, timed out,
  no result), with its trigger (at start-up, Re-login, cookie restore, token
  refresh…), the worker and the time to the second, plus what the pool did
  with it (added, assigned and by whom, taken, returned, moved to Problem and
  why, retired, removed). A run of identical logins, such as a worker failing
  at every restart, is one line with its count and time range, and the head
  sums the logins that succeeded and failed. Logins come from the
  coordinator's login ledger through the fleet console's `/v1/logins`
  (the facebook-tracker release after 0.13.12); a row names the account by uid, or else belongs
  to the account that was on that worker when it started. Against an older
  console the timeline shows the pool's events and says logins will follow.
  Since v1.332.2 (RS-389) it says *some logins may be missing* when one of
  the workers didn't answer, or when a worker's ledger (its newest 500 logins)
  doesn't reach back to when the account went on it. *The fleet console did
  not answer* is kept for when no worker answered. A timeline that failed to
  load is asked for again the next time its row unfolds.
  Also since v1.332.2, a fleet document that can't be read no longer blocks
  Assign. The DEAD check then goes by the proxy the worker's last account went
  through, and the new stint's proxy is left unrecorded.
  Since v1.321.0 (RS-367) the worker's page is two columns from 1190px up:
  the card, Open checkpoints and Accounts used on the left, and **History**
  beside them from the card's top, as tall as they are and scrolling its own
  list (below 1190px it stacks underneath). History tracks everything known
  about the worker, newest first: its status changes, checkpoints and latest
  search, listing and backup as before, each pool account signing on and
  leaving (with how it left), and every login the worker attempted, whichever
  account it was for, marked with that account's # and folded into runs.
  Against an older console it says logins will appear once it is updated. A worker's Today strip uses
  its own sweep times, from the config it runs, so a worker that shares an IP
  and sweeps at its own hour shows that hour (facebook-tracker 0.13.8). And a **From a search to an alert** card that walks the
  pipeline as the code runs it — search, result cards, the title gate before
  any page is opened, the cached page visit, the keyword gate with the
  description, the already-notified skip, the AI rating with its unit and
  score gates, the coordinator's dedupe and the Telegram topic — with each
  stage's code, its settings (code constants are marked as such), the item
  phrases, keyword rules and prompt, and
  today's fleet-wide count for every stage. Workers count searches, cards
  seen, title and keyword passes, real page visits, new listings and fresh AI
  verdicts; the coordinator counts what it takes in and the Telegram alerts
  actually sent (v1.264.0). Each stage that reads a setting (search, result
  cards, title gate, keyword gate, AI rating) has an **Edit** form for those
  settings, prompt and rubric included. A save goes through the fleet
  console into every worker's config. Workers pick it up between jobs and
  start a sweep, and deploys keep the saved values (v1.265.0). The sweep time is shown and typed in US Eastern and stored as the workers'
  UTC (v1.287.1); the fleet's default is 09:00 Eastern (facebook-tracker
  0.13.5, 06:00 before it). The phrase and keyword lists show one item at a time, as chips. The
  keyword gate shows two lists, a green **Include** (a listing must mention
  one) and a red **Exclude** (any one drops it). Each list is one flat field
  of keywords: no "or" between chips, an AND/NOT rule as one expression chip,
  and every count counting keywords rather than config lines (v1.288.0). The
  title gate shows both lists too, since with the title prefilter on a card
  needs an include keyword in its title; with the prefilter off its Include
  list is dimmed, and a save from the title gate sends both (v1.289.0). A
  repeated term is outlined. An include keyword an exclude keyword always
  catches is struck through, and its tooltip names the exclude keyword: an
  exact copy, or a word that merely starts with it, since `ram` drops
  `ram stick` too (v1.289.0). Editing is by chip (× to remove, Enter or paste
  to add), with a text fallback. In read mode, **+ Add keyword** opens the
  stage's Edit with that list's input focused. Opening Edit, either way, or
  switching to text leaves the card and both fields the same height: the ×
  is a corner badge on hover, so no chip moves (v1.289.1). A **Try a listing** box on the
  title and keyword gates puts each item's verdict on its tab (passes, which
  exclude keyword drops it, that no include keyword matched, or that the page
  is opened anyway). Under the tabs, the typed title and description are
  shown with every Include word marked green and every Exclude word red for
  the selected item, and every chip the listing holds fills in its list's
  colour (v1.289.0). It uses the unsaved draft while editing. Save stays off
  until something changed, and leaving a dirty form asks first (v1.270.0).
  The eye
  on a row is the one way to a worker's page, `/fleet/worker/<worker>`: its
  Facebook login and user id, vault account and stored secrets by name,
  session expiry, browser and backup, proxy (since v1.278.0 its URL without
  the login, and the exit IP and city a lookup through it finds — RS-281),
  cities, pacing, session file and build, its open checkpoints (capture, Watch, Mark resolved) and its recent
  events, and the actions — **Watch browser**, **Re-login** and **Assign
  account**. Since v1.275.0 the worker's login comes only from the account
  pool (RS-276): the dialog lists the available pool accounts that have a
  password (search by #, UID, e-mail or batch; 2FA, cookie age and batch
  shown) and assigning one sends its login to the worker the same way the
  pool page does — vault written with password login allowed, Re-login
  queued, account marked Fleet. Since v1.281.2 the account's UID goes with
  the login, and it picks the device the worker presents: the same browser
  identity on any worker, never the previous login's (facebook-tracker
  0.11.0, RS-292). Since v1.281.3 it also sends the `datr`/`sb` from the
  account's pool cookie (never its session), so a login with no device yet
  starts on the one it was made in (facebook-tracker 0.12.2, RS-293). Since
  v1.290.0, when the account's cookie is its own (its `c_user` matches), the
  Assign seals that whole cookie as the worker's session and has the worker
  restore it — logged in with no password login and no 2FA, on the account's
  own device — and queues a password Re-login only when there is no usable
  cookie; a restored session that Facebook has since expired still falls back
  to the password login on the worker's own (facebook-tracker 0.12.5, RS-308).
  Since v1.291.1, a fleet that won't seed the cookie (a console older than
  0.12.5 answers 404; a cookie without `xs` is refused with 422) gets the
  password Re-login instead of a failed Assign.
  Since v1.308.0 the account's access token (the `EAA…` the pool stores from
  v1.307.0) travels to the worker too: when a restored or seeded cookie session
  lapses, the worker tries to mint a fresh one from the token — inside its own
  proxied browser, with no password and no 2FA — before falling back to the
  password login. The token is handed over on demand and audited, never counted
  against the password budget, and a successful mint is recorded as a
  `token-refresh` login (facebook-tracker 0.13.10/0.13.11, RS-338). **A caveat
  found in live testing:** Facebook only mints web-session cookies from a
  *first-party / SSO-capable* app's token (it refuses others with
  `OAuthException` 100). The purchased-pool tokens are valid Graph tokens but
  are not first-party, so for them this step always falls back — the **cookie**
  remains the real browser-login path, and the token is kept for its Graph-API
  value. The step is in place for a first-party token.
  Since facebook-tracker 0.13.0 a wall a worker hits mid-sweep — a checkpoint,
  captcha, block or disabled notice on an ordinary Marketplace URL, which the
  selectors read as an empty city — is named by a decision model
  (`RS_PAGE_CHECK_MODEL`), filed here as an open checkpoint with a screenshot,
  and parks the worker on CHECKPOINT or CHALLENGE_CAPTCHA, searching nothing,
  until the page moves on; clearing it in Watch lifts it within a minute
  (RS-311). Since facebook-tracker 0.13.1 that screenshot sits on the
  coordinator's data volume and survives a redeploy, and a checkpoint whose
  file is gone offers no thumbnail rather than a broken one (RS-315). Since
  facebook-tracker 0.13.4 a decision model pre-screens every listing before
  the LLM reads it, in shadow: its reject / maybe / buy verdict is logged
  beside the LLM's and nothing is skipped until `RS_PRESCREEN_ENFORCE` is
  turned on (RS-319). Since facebook-tracker 0.13.6 a listing alerts once
  across the fleet. Before, every worker that saw it alerted it: 50 of 122
  alerts from 10-12 to 10-20 were repeats. Now a worker claims the listing
  from the coordinator before sending, and only the first claim sends. A
  delivered listing alerts again only below the price it was alerted at. The
  card's coordinator stage says so since v1.301.1 (RS-329). If the
  worker already holds a pool account,
  the dialog asks where that one goes — back to Available, to Problem (still
  naming the worker) or Retired — with no default, and both moves land
  together. A worker without a vault account gets one named after it. Until
  then (v1.259.0) the login, password and 2FA secret were typed into a
  credentials form. The data is the rs-console facade's
  `/v1/fleet` document, checkpoints, review stats, alert hits and prompt
  through the manager-only `/api/coordinator` proxy; without the proxy's
  credentials the tab says so and the rest of the ERP is unaffected
  (v1.140.0). While that data loads, the table, the activity aside, the
  legend counts and the stage counts show skeletons shaped like their content
  (v1.267.0). Since v1.272.0 a worker whose config the console holds also
  has **Edit cities**. Cities come from the regions or are typed as a
  Marketplace slug or numeric id, with a name and radius. A city another
  worker already searches is amber, because it would alert twice. Each city
  links to its Marketplace page so a wrong slug can be caught, since Facebook
  otherwise searches the account's own area in silence. Saving writes that
  worker's config only, and it searches the new list from its next run
  (RS-275). Since v1.274.0 the same dialog sets **how often each city is
  searched** (RS-277). The coordinator ranks a worker's cities by alerts sent
  plus alerts reacted to over a window (30 days by default). The top 20% are
  searched 3 times a day, the next 20% twice and the rest once, and a city
  with no alerts in the window is never promoted. Each city row shows its
  alerts in the window and an Auto / 3× / 2× / 1× pin. A collapsible **Ranking
  rule** sets the percentages, the counts and the window for every worker.
  The worker's `start_at` times are its slots: a city is searched at most
  once per time, so the tiers take effect only once the search settings list
  two or more times (the dialog says so with one). A city's chip shows `3×`
  or `2×` when it is searched more than once a day, and the hover names the
  count and whether it is pinned. Saving restarts no sweep: workers ask the
  coordinator for their plan before each one. Pacing still lives in
  `fleet.toml`.

  **The city queue.** Since v1.328.0 (RS-379) the Fleet tab opens with
  **Today's round**: the city queue workers can pull their cities from
  (facebook-tracker 0.13.14, RS-372) instead of walking their own lists.
  - **The board.** It has one mark per city for each search item, in the
    order the round runs: searched today, being searched now, still due, not
    due yet, and one hatched count for the cities still on a worker's own
    list. Under each item a sentence gives the counts, or says the round is
    done. A **Cities** table names each queue city's state, time and worker.
  - **The lede.** It says how many workers pull, how many are enrolled but
    still run a monitor older than 0.13.14 (they keep their lists until
    redeployed), and how many search their own lists. It also states the
    stored rules: once a day per item, up to 6 h of searching per account,
    within 8 h of each start time.
  - **Everyone at once.** **Move every worker to the queue**, or **Send every
    worker back to its own list**, asks for confirmation first and says how
    many still run an older worker.
  - **The workers table.** An enrolled worker carries a **Queue** chip by its
    status (amber "needs update" when its monitor never asks). Its Searches
    ring counts minutes of searching against its budget, and its fold adds
    the cities the queue handed it today.
  - **The worker page.** It has a **City queue** row: in the queue or not,
    minutes used, cities handed out, the city being searched now, or
    quarantined when its searches find nothing where other accounts find
    listings. Its cities row reads **Home cities** when it is enrolled.
    **Move to the queue** / **Back to its own list** moves one worker, and is
    disabled, with the reason, for a worker on an older monitor.
  - **Older consoles.** Against an older console none of this shows.

  **Starting the round now.** Since v1.334.0 (RS-393, facebook-tracker
  0.13.18), the round card has **Start the round now**, so a manager need not
  wait for the workers' start times.
  - **The confirmation** says:
    - how many workers start searching within a minute;
    - which enrolled workers run an older worker and start at their usual
      time;
    - for each item, how many cities are due: those not searched in the last
      2 hours;
    - when the round ends (8 hours later), and that the usual start times
      still run.
  - **Once started**, the lede reads "Started by … at …, runs until …".
  - **The board's due cities** follow the started round's rule.
  - **Before the workers are redeployed** onto 0.13.18, the button wakes no
    one and says so.

  **The city log.** Since v1.331.0 (RS-385, facebook-tracker 0.13.17), every
  city a worker searches is logged from its start to its end.
  - **The worker page's City log card.** It covers the last 24 h, one row a
    city:
    - when it ran and for how long;
    - the city and the item;
    - searches, cards, opened, AI-reviewed and alerts;
    - the outcome: **Finished**, **Searching now**, **Stopped** with the
      reason (a wall and its kind, logged out, paused, cut short, an error),
      **Given back** (the worker restarted, or parked in a checkpoint or an
      expired session), **Expired** (the worker went silent), or **No word
      since** a time.
  - **A row's steps.** A row opens to its steps, each timed to the second:
    - handed out by the queue, and why: a city it searched lately or another
      city (a coordinator worker's home city too; ERP workers have none since
      v1.374.0, RS-439);
    - started, and how many searches were planned;
    - each search's phrase and what it found;
    - each alert, with the listing's title linking to Facebook, its price and
      its score;
    - the end.
  - **Older workers.** A worker on an older monitor reports no start or
    finish. Its rows are added up from its searches and say so.
  - **One city's log.** On the round card, a city's name in the **Cities**
    table opens that city's last 24 h across every worker and item.
  - **Older consoles.** Against an older console the card and the city links
    show nothing.
- **Fleet recovery (v1.349.0, RS-400)** — the backend fences worker requests
  when the pool's owner changes. Hosts confirm a stopped container before its
  replacement reclaims the same account; repeated rollout commands and lost
  replies do not cause another replacement. Finished or released lease attempts
  count against the UTC day's budget, split at midnight. Lost city checks retry
  and late results cannot undo a removal or override. An account's all-zero
  searches quarantine it only when another account found cards in its cities;
  a successful probe or manual release resets the evidence. Since v1.371.2
  (RS-433) a probe is written only while a worker runs the account, and a
  waiting probe is cancelled once none does, so the Queue no longer shows
  probes nobody can take. Heartbeats renew
  worker tokens without another browser login. Worker shared secrets come from
  the Cloudflare Worker's FLEET_WORKER_ENV on its claim-only surface; deploying these
  changes still requires the separate owner-approved cutover.
- **Fleet claim hardening (v1.354.0, RS-406)** — a key missing on the ERP's
  side answers workers `503 unavailable` instead of a 401 they would exit on,
  and `FLEET_WORKER_TOKEN_KEY_PREVIOUS` lets the token key rotate without
  restarting (or re-logging) any worker. A host claims only for its own
  `<host_id>-<n>` workers. A lost `next-task` answer hands the same task again
  rather than leasing a second. A handoff reservation lapses after 20 minutes
  and is shown as reserved, not parked. A slug check whose page failed leaves
  the city unverified so it is checked again. A session upload must carry this
  account's `c_user` and `xs`, so it cannot wipe or replace the stored login.
- **Fleet scheduling and rollout fixes (v1.356.0, RS-407)** — a rollout no
  longer picks a worker the agent will not replace: a held container
  (operator needed, crash limit, stopped by hand), one not running, or a
  worker parked on its account is skipped with the reason in the release's
  `skip_reasons`. A host's report keeps only its own `<host>-<n>` workers and
  the agent's hold, exit code, image id and identity, and a second agent
  instance for one host is refused (`403`, observe-only). Removing a host
  frees the accounts it had reserved for a replacement. **Search now** on a
  switched-off or unverified city is no longer cancelled by the next
  scheduler pass, and two clicks write one task. A city's per-day change moves
  its waiting search at once. Enabling a city needs a matching verdict (a
  mismatch needs Enable anyway), and `reverify` sends a city back for a fresh
  check, which is also how a removed, never-verified city returns; a check
  that keeps ending without a verdict backs off from 15 minutes to 6 hours. Task
  history reads newest first (up to 5000, flagged when cut), so Analysis no
  longer shows the oldest days of its window. The fleet VNC relay is served
  by one backend instance (an advisory lock; the others answer 503) and drops
  a parked worker socket within a minute of its slot moving on (`4409`).
  `fleet-import.mjs` keeps managers' edits unless `--overwrite`, and it,
  `fleet-seed-slots.mjs` and `fleet-fake-worker.mjs` refuse a remote target
  without an explicit opt-in.
- **Fleet claim tickets (v1.360.0, RS-411)** — worker containers never hold
  the host token. The host agent mints a single-use claim ticket for each
  container right before running it (bound to the worker id and any handoff
  epoch, ten minutes, kept only as a hash) and the worker claims its account
  with that. A compromised worker can claim no other account and call no
  host route. A held worker comes back with `docker rm rs-fleet-<id>`; a
  `docker start` claims with a spent ticket, exits 75 and is recreated. The
  host token still claims for one release (older agents and worker images).

- **One fleet, on prod; dev mirrors it (v1.369.0, RS-427)** — the hosts and
  workers belong to prod's ERP. A backend with `FLEET_ROLE=mirror` (dev) holds
  a copy: managers can read every Fleet tab, which carries a banner pointing at
  inventory.recycleservers.com, but every write control is gone and the API
  refuses fleet writes with `409 read_only`. Any agent or worker that still
  calls it gets a 503, never a 401 or 409, so no worker exits (an exit is a
  Facebook login on restart), and the mirror runs neither the scheduler tick
  nor the proxy probe. A worker started with the dev URL keeps working: the dev
  Cloudflare Worker sends any `/api/fleet/*` call that carries a bearer to
  `FLEET_FORWARD_URL` with that ERP's `FLEET_FORWARD_PROXY_SECRET`, while
  managers' cookie calls stay on dev. With `SYNC_KEEP_FLEET=0`, the nightly
  prod→dev copy brings prod's fleet over like any other table. Host token
  hashes are replaced, claim tickets dropped, and sealed proxy URLs cleared.
  Since v1.371.1 (RS-432), a mirror with `FLEET_MIRROR_URL`,
  `FLEET_MIRROR_CLIENT_ID` and `FLEET_MIRROR_CLIENT_SECRET` set answers its
  managers' fleet reads from prod, live. It signs in there as a service client
  holding `fleet:read`, a scope only Settings → Connectors grants and only a
  service client's token may use (since v1.373.1, RS-437, a token a user
  consented to is refused). The banner says the page is live only when prod
  actually hands over a token. Without the variables, the reads come from the
  copy, whose heartbeats age into Offline between syncs. Since v1.373.1 a read
  prod can't answer (unreachable, a 5xx, or a route prod's older release
  lacks) falls back to the copy rather than a 502; a live answer carries
  `X-Fleet-Source: live` and prod's own headers.
- **Add to fleet (v1.364.0, RS-415)** — a manager puts pool accounts into
  ERP-fleet slots from **Monitors ▸ Facebook ▸ Account pool**, no seed script.
  The exits the ERP keeps are added, edited and removed on the **Proxies**
  tab (until v1.376.0, RS-443, on a Proxies card under the pool table); the URL with the vendor login is
  pasted once, sealed, and never shown again (the edit form's field starts
  empty and leaves the saved URL alone). An available account with a
  password and a 2FA key gets **Add to fleet** in its Runs on cell: pick a
  proxy (a full one is greyed; two accounts per proxy by default, the
  `Accounts per proxy` rule in Cities ▸ Rules; there are no home cities to
  pick since v1.374.0, RS-439), and the ERP makes the slot with a desktop browser made
  for the account (Chromium's own user agent, a common screen and scale
  picked from the account number, the proxy's timezone). The account turns
  *fleet* under "ERP fleet" and reads "waiting for a worker" until one claims
  it. **Remove from fleet** takes back an account no worker holds (park it on
  the Fleet tab first) and returns it to Available. Removing a proxy an
  active account uses is refused. A host now starts only as many workers as
  it has accounts to run, up to its capacity: with capacity 4 and one ready
  account it runs one worker, and each account added brings another.

- **Fleet (ERP-owned)** — since v1.337.0 (RS-394) **Monitors ▸ Facebook** is
  the page of the task queue the ERP itself runs: the backend owns the city
  catalog, the tasks, the hosts and the account slots (`/api/fleet`), and
  identical worker containers on any host pull their next city from it.
  Since v1.367.1 and facebook-tracker 0.14.8, fleet handovers and session
  refreshes preserve the complete saved Playwright state, including local
  storage and IndexedDB alongside cookies. Older cookie-only workers retain
  those saved origins when refreshing their session.
  Since
  v1.344.0 the page has five tabs in the owner's approved design — **Fleet**,
  **Tasks**, **Cities**, **Analysis**, **Account pool** (since v1.368.0 a
  sixth, **Proxies**, before Account pool) — with count chips on
  the tab bar (workers running; tasks running or due now, every kind, in the
  warn colour while any is due; cities; healthy proxies; pool size — since
  v1.373.2) and the title "Facebook fleet" on every one; the earlier Queue, Hosts
  and Slots tabs folded into them, and their paths (`/#/fleet/queue`,
  `/#/fleet/hosts`, `/#/fleet/slots`) redirect. Managers only and desktop
  only; purchasers see Account pool alone, and the phone has no fleet pages.
  Times read in US Eastern; Analysis daily totals use UTC day boundaries. Against a backend without the fleet routes each
  tab says so and the rest of the page is unaffected. Every tab re-reads every
  10 s while it is visible.
  Since v1.351.0 (RS-403) the Fleet and Analysis tabs show the ERP's own rows without waiting for the coordinator, whose rows fill in when they land, read every 30 s and never while the last read is still out; the tabs and the tab-bar counts send each URL once per load and read the pool summary, not the secret-bearing snapshot.
  - **Fleet** (`/#/fleet`, v1.344.0): a strip of host cards, then one table
    of every worker (since v1.361.0, RS-412; before, every account). A host
    card gives the id, the agent's version, when it
    last reported, running of capacity, the **Authoritative** switch (off is
    observe-only: the agent reports and starts nothing), the capacity stepper
    (a new worker is a Facebook login; since v1.364.0 the agent runs no more
    workers than the host has accounts for; since v1.382.0 (RS-459) a − that
    would leave a running container numbered above the new capacity asks
    first, naming the containers above it; since v1.385.0 (RS-463) the agent
    never removes a worker: one above the count keeps running, and once it
    stops it waits until the count reaches it again) and, while a release rolls, its
    progress line with the worker replaced next (since v1.367.0 only while
    GET /api/fleet/hosts returns a rolling release; without one, workers
    left on an older image get a quiet "1 worker on 0.14.6; new workers
    start on 0.14.7", no bar); **Add host** (the token
    shown once, with the three variables the agent needs) and **Release a
    version** sit in the tab's action row, and a rolling or stopped release
    shows its banner under the strip. Since v1.361.0 (RS-412) the table is
    one row per worker: the ERP's workers, with the slot and account each
    holds, and, until cutover, the coordinator's (host `homelab`); a worker
    both know is the ERP's row. An account no worker holds is not a row: the
    Account pool tab lists it, with its Unpark and Release quarantine. A
    worker that stopped reporting stays as a row for a week after its last
    heartbeat. Each row: worker and VNC port, host, account number and
    masked uid (since v1.388.0, RS-470, the number links to the Account pool
    tab with that account's editor open, and hovering the cell shows its pool
    status, a holder other than the worker, and its note), the state chip with a one-line note (heartbeat age, "keeps
    its task" for a degraded worker, the account's quarantine end), **Now**
    (the city and item being searched with the time on it, "home city" on a
    coordinator worker's;
    "Waiting for a task"; or, for a worker being replaced, "Stopping after
    this task, then back on <version>") with **Park** for a running worker,
    **Today** (minutes of searching against the budget, as a ring), the lease
    epoch and when it renews, the worker's version (muted when it is not the
    host's), and the eye to the worker's page. Running workers come first,
    then silent ones, each by worker id. Since v1.373.0 (RS-436) a worker is
    one of two kinds (three since v1.381.0): **Healthy** (running, degraded or being replaced
    included) or **Parked** (it reports Session expired, Checkpoint,
    Challenge or Dead, which its state chip names, or it went silent; since
    v1.373.1 (RS-437) also when a manager parked its slot). Since v1.381.0
    (RS-458) a third kind, **Removed**: a silent worker that its host's
    latest report no longer lists (the agent removed it, as it does when the
    host's capacity is lowered) reads **Removed by host** in grey instead of
    Parked; since v1.385.0 (RS-463) hosts no longer remove workers and the
    kind is gone. A row whose account another worker now holds shows no minutes.
    Since v1.382.0 (RS-460) every column title sorts the table (descending,
    ascending, then its own order; empty cells last).
    Since v1.379.0
    (RS-451) a parked ERP-fleet row, and that worker's page, have **Retire &
    free**: the pool account is retired and its slot deleted, the worker is
    refused on its next call and exits, and its host's next container claims
    another free account (a worker parked for an operator stays stopped).
    Since v1.379.1 (RS-452) only when its worker reports Session expired,
    Checkpoint, Challenge or Dead (not Dead for an operator, a proxy fault),
    or a manager parked the slot, or the pool already took the account out:
    a row parked only because its worker went silent has none, and the API
    refuses any other slot with `not_lost`. Since v1.383.0 (RS-461) the toolbar has
    **Release parked (N)** whenever such rows exist: a confirmation lists each
    account, worker and state, counts the parked rows it leaves alone, and
    warns that every account added to the fleet afterwards starts a worker (a
    login); confirming retires them one by one through the same endpoint. A
    worker that has stopped and whose account no longer has a slot (retired or
    removed from the fleet) is its own kind, **Free**, grey, waiting for an
    account added on the Account pool tab; Free comes before
    Parked. Since v1.387.2 (RS-469) a worker reads Free as soon as
    its account's slot is gone, for example straight after Release parked,
    without waiting for it to go silent: its next call is refused. A stopped worker of a deleted host reads Parked, not Free: no
    agent is left to start it (v1.387.1). Retire on the Account Pool page
    deletes the account's fleet slot too, and with no free account left the
    host runs one worker fewer instead of replacing it. Since v1.380.0
    (RS-454) a worker parked Dead because a Facebook page would not load
    (`connect_failed`) reads **Page didn't load**, with the worker's error on
    hover, rather than Dead, and the row and its watch page offer **Mark
    healthy**: its next heartbeat hands it `resume` once, and it tries again in
    the same browser, with no new browser and no login. The row reads "Mark
    healthy sent" until the worker reports anything but Dead. A worker build
    before facebook-tracker 0.15.0 cannot take it, and the button says so.
    The worker itself now tries a page that times out twice more, 10 s then
    30 s apart, before it parks. The
    toolbar has the legend with counts (All workers, Healthy, Free, Parked), a
    host select and a search over worker, account, city and host; since v1.371.0 (RS-431) the
    tab opens on Healthy rather than All workers. The foot says "N of M
    workers · R running on K hosts". Since v1.367.0 (RS-418) a coordinator
    worker the fleet retired (`retired_at` on its health row) is left out
    of the rows, the counts, the host select, the tab bar's running count
    and the activity aside (since v1.373.0 there is no Retired chip); a
    retired worker's own page still opens, dated, without Re-login.
    The coordinator's activity aside stays under the table while its rows
    exist; since v1.350.1 it spans the full width and its list stops at 480px
    and scrolls. There is no Pause on a roll: the backend has no route for it.
  - **Tasks** (`/#/fleet/tasks`, v1.344.0): the belt, then the task table
    with the city log beside it. **The belt** is one row per enabled item on
    a 24-hour window centred on now, in quarter-hour buckets: searches done in
    the last 12 hours as green squares to the left, the overdue stack at now
    as one amber bar labelled "N due now", running tasks as blue marks just
    right of now (one per worker), and waiting tasks at their due time as
    outlined squares, amber-outlined inside the next hour; a bucket past seven
    tasks shows "+N", hover names each task's city, time and worker, and the
    axis ticks every third Eastern hour. Each row's label gives the item,
    "done of total searched since <time>" and "running, due now, due by
    <time>"; the sentence above says how many workers are searching and how
    many wait for work, how many city-items are due and how many minutes the
    backlog takes at the measured task length (the mean of today's finished
    searches, six minutes before any finish), done in the last 12 hours and
    due in the next 12. Only searches count; a slug check or a probe is not a
    city-item. **The table** lists the range (last 24 h, last 7 days, today
    UTC) plus everything waiting, narrowed by a state segment (All, Running,
    Due, Done, Cancelled, Expired, each with its count under the other
    filters since v1.373.2), an item select and one search box over
    city, worker and account; a row gives the city, item, state (Running,
    Due, Later, Done, Cancelled, Expired, plus "front of queue" on a manual
    task), the due time with what happened to it, the worker and account,
    how long it took (ticking while it runs), cards, alerts and why it
    exists. Running rows come first, then due, then finished, then waiting
    for later; the foot counts the rows and the last 24 hours' finished
    searches. It shows 60 rows and, since v1.377.4, adds the next 60 each
    time its end scrolls into view; a new filter or range starts again at the
    top. Clicking a row opens **the city log** in the aside: the city's
    name, slug, region and searches a day (no home worker since v1.374.0,
    RS-439), then per item the open task and the last two finished ones, each
    with its events timed in Eastern, refreshed every 10 s; **Search now** and
    **Edit** (the Cities tab) sit on it. **Search a city now** is a dialog in
    the action row (a city, one item or both, with when it was last searched
    and when it is next due); **Start the round now** previews and confirms
    as before.
  - **Cities** (`/#/fleet/cities`, v1.344.0): the catalog, with a lede that
    counts the cities, the searched, the verifying and the off.
    The toolbar has the legend (All, Enabled, Verifying, Disabled; Pinned
    went in v1.372.0, since nothing read it), a
    region select and a search over name and slug. Verifying cities come
    first, each with an inline row under it: "Added <when>. A worker will
    open the slug between tasks and confirm Facebook shows <name>" with
    **Skip the check**, or, when the label Facebook returned does not match
    the name, "Facebook showed <label>, not <name>. The slug may be wrong"
    with **Enable anyway** and **Remove**. A row gives the city with its slug
    (linked to Marketplace) and a non-default radius, region, the status
    chip, searches a day (Default or a fixed count), per item a cell with the
    last search (time, cards, alerts) and the open task as a chip — the
    worker searching it, "due, waiting N min", or "next <time>" — and the
    row actions (the Home of column went in v1.374.0, RS-439): **Search
    now**, **Remove**. A disabled city offers **Enable**, a removed one
    **Restore**; a city removed before its slug was verified asks whether to
    **Enable anyway** instead. **Rules**, beside **Add city**, edits the
    fleet-wide settings (searches per city per item, budget per account,
    lease, longest task, familiar window, round-start skip, quarantine and
    its probe interval, and since v1.358.0 how many days of task history to
    keep, 30 to 730, default 90); a change reaches each worker at its next
    task. Finished, cancelled and expired tasks older than that are deleted
    hourly with their logs, except each city and item's last search and each
    city's latest slug check.
  - **Analysis** (`/#/fleet/analysis`, v1.344.0): the search-to-alert
    pipeline that used to sit on the Fleet tab, with a range segment (Today,
    7 days, 14 days) that sums the ERP fleet's finished searches per UTC day
    (`GET /api/fleet/stats/funnel`, since v1.377.1, RS-446; before, the
    coordinator's counters, which the ERP fleet's workers do not report to,
    so every stage read 0): searches, result cards, the title gate, listings
    opened, the keyword gate, new to us, model reviews, **Passed the model**
    and alerts. Since v1.378.0 (RS-450, facebook-tracker 0.14.18) a task's
    result counts the three gates and what passed the model: a fresh verdict
    that clears the score and minimum-units gates. Passed the model replaced
    the Coordinator stage, which the ERP fleet never counted; its card also
    shows how many of those a worker held back because fleet alerts are off,
    and the claim and de-duplication text moved to Telegram alert. A stage
    no day in the range reported shows "—"; one only some days reported
    gives no pass rate against a stage counted on every day. Since v1.380.2
    (RS-457) a day sums those stages over the searches that reported them,
    and one where only some did (an older worker searched) makes them partial:
    a stage summed over fewer searches is starred with a footnote naming how
    many of the range's searches counted it,
    the alert's rate leaves out what was held back, and a step over 100 %
    shows no number. Between
    stages the pass rate from the last counted stage (cards per search as
    "×N", every other step as a percentage, amber under 50 %) and under the pipeline the
    headline ratios: what passed the model and what was held back, cards per
    alert, reviews per alert, the title gate's drop before a page is opened
    and the model's drop of what it reads, read against what passed it and
    left out when that is not wholly counted (v1.380.2). Then
    two per-day bar charts for the last 14 days from the same counts, each
    on its own axis — reviewed by the model, alerts — in one hue with today's bar grey as
    partial, three gridlines, labels on the first, highest and today's bar, a
    hover title per bar, the 14-day total and the full-day average. Then
    **Where the alerts came from**: per city over 14 days, the alerts, the
    model reviews from the fleet's finished tasks on it (the task list is
    capped at 1000 rows), the alert rate when the finished tasks account for
    the same alert total and the task list is not capped, the last alert's
    day (the Searched by column went in v1.374.0, RS-439). The coordinator's
    counts are not tagged per worker, so there is no worker or item filter.
  - **Proxies** (`/#/fleet/proxies`, v1.368.0, RS-424): the health of every
    proxy port the fleet browses through, between Analysis and Account pool,
    with the number down as a warn-coloured chip on the tab bar. Rows are the
    ERP's proxies (by label) and every port the homelab
    console holds, dialed or idle (by host:port, marked Homelab; v1.368.1,
    RS-425). A port on both lists is one row, the ERP's. Every five
    minutes one backend instance checks each ERP proxy through the proxy
    itself, http, https or socks5, with a lookup at ipinfo.io, and calls
    rs_console's `/v1/proxies/health` to do the same for the homelab ports
    (facebook-tracker 0.14.14); a console without it leaves those rows
    out with a note, and one that stops answering keeps them as last
    reported. A row gives the state — **Up**, **Degraded** (slower than 3 s,
    or one missed check after answering), **Down** (two misses in a row) or
    **Unchecked** — with the error under it and the RS-365 DEAD chip, the
    last latency, the exit IP with its city, region and country (ISP on
    hover) and "was <ip>" when it changed in the last 24 hours, the day as 48
    half-hour ticks in each bucket's worst state with the uptime over its
    checks, when it was last checked, and who uses it (the ERP accounts on it
    with "parked" and the homelab workers, linked, or "Nobody"). An account
    counts on a row, and against its proxy's limit, through its slot's proxy;
    the slots seeded at cutover named none, so `fleet-link-proxies.mjs` lists
    their exits and links them (v1.376.1, RS-444). Down rows come first. The
    toolbar has the legend with counts, a source select and a search over
    label, port, exit IP, city, worker and account. **Check all now** runs a
    round unless one started in the last 15 s; the row button checks one ERP
    proxy (homelab ports are checked together). Checks are kept 14 days. No
    proxy login reaches the browser, the log or the table.
    Since v1.376.0 (RS-443) the tab is also where the ERP's proxies are
    managed: **Add proxy** beside Check all, and Edit and Remove on each ERP
    row, the same forms the Account pool card had (homelab ports stay
    read-only; a mirror shows neither). An ERP row's Used by leads with how
    many accounts of the per-proxy limit use it, warn-coloured when full.
  - **Account pool** (`/#/fleet/pool`, v1.344.0): as before, plus a **Runs
    on** column: the ERP worker holding the account's slot with its state
    and epoch, linking to the worker page; else the coordinator's worker as
    the Holder column shows it; else why nothing runs it (quarantined,
    parked, the purchaser who took it, or the pool status). Since v1.361.0
    (RS-412) a quarantined account's cell has **Release** and a parked one's
    **Unpark** (with its confirm), which used to be on the Fleet tab.
    Since v1.364.0 (RS-415) the cell also puts accounts into the ERP fleet
    and takes them out (below). The Proxies card that sat under the table
    moved to the Proxies tab in v1.376.0 (RS-443).
  - **The worker page** (`/#/fleet/worker/<id>`, v1.337.0) recognises a
    fleet worker: state, last heartbeat, account and epoch, version, the task
    it holds (city, item, since when, lease), and **Watch**, its browser
    through the ERP's own relay, view-only (since v1.366.0, RS-417, **Watch browser** opens the
    watch page below instead). Any other id shows the
    coordinator's worker page as before. Its back link leads to the Fleet
    tab (v1.344.0).
    Since v1.365.0 (RS-416) a fleet worker gets the homelab worker page
    itself, on the same layout (`fleet/workerDetail.tsx`) and from one read
    (`GET /api/fleet/workers/:id`, manager-only, no secret value or proxy
    URL): the login as title, Live / Stale / Needs attention / Offline, the
    stat row (alerts and stopped tasks over 7 days, last finished search,
    open checkpoints), rows for the pool account, its stored secret kinds,
    the session expiry the worker reports, the slot's device, the pool
    cookie's age as Session backup, the listed proxy (label, host:port,
    timezone), the slot (epoch and lease, parked, reserved, quarantine), the
    cities it searched lately, latest first (since v1.371.3, RS-434, with a
    note that they are what the queue handed it in the last 7 days, not a list
    tied to it; no home cities since v1.374.0, RS-439), today's budget
    minutes, host and build (amber when behind the latest release). Last listing and Session file
    read "—": the fleet has no source for them. A worker parked on a wall
    or lost session shows it under **Open checkpoints**. Actions: Watch
    browser, Park / Unpark, Remove from fleet (once no worker holds the
    slot), Search a city now, Release quarantine. Accounts used, the City
    log (its 24-hour tasks) and History (task events and pool stints) follow.
- **Facebook account pool** — a second tab at **Monitors ▸ Facebook**,
  linked directly at `/#/fleet/pool` (v1.261.0). Managers see a status legend
  with counts that filters (the key-tag rail left the manager's view in
  v1.263.0; purchasers still pick from it), a searchable account table, supplier-row
  import with duplicate/credential checks, an editor, retirement/removal,
  cookie freshness and UID checks, and recent activity. Purchasers see the pool
  instead of the Fleet controls: take up to two accounts, reveal/copy their
  credentials and live six-digit 2FA codes, return them or report a login problem.
  Since v1.262.0 the pool is stored by the backend (`/api/facebook-pool`):
  every change is shared and survives a reload, the two-account limit and the
  "holder or manager" rule on return/report are enforced in the transaction,
  an import lands whole or not at all (naming the rows whose UID collided),
  and the `#` is never reused. Logins (password, 2FA key, e-mail password,
  cookie, access token) are sealed at rest under `FB_POOL_KEY`; the nightly
  prod→dev copy blanks them, the access token too since v1.316.1. A
  purchaser's read carries the login of the accounts they hold and only the
  rack — status, holder, age, the cookie's `c_user` — for the
  rest; the activity ledger (every add, import, edit, take, return, report,
  retire, remove, plus copies and reveals of a login) is manager-only. In
  production without `FB_POOL_KEY` the pool routes answer 503 and name the
  variable. The pool is the human side of the picture; the fleet's own vault
  of worker logins (RS-254) stays a separate, write-only store, and `fleet`
  here says which worker an account went to. Since v1.269.0 that worker is
  picked from the fleet in the editor (picking one is what makes an account
  Fleet; None returns it to Available), the table links the holder to the
  worker's page and shows the worker's Live / Stale / Attention / Offline
  status in place of Fleet. Since v1.279.0 a click on any value in the
  table — UID, password, 2FA code, e-mail, e-mail password, recovery, cookie,
  notes — copies it (secrets are logged), masked passwords reveal from the eye
  beside them, and the editor opens from the pencil at the row's end. A cookie may be
  pasted as a header line or as the JSON a cookie extension exports, and a
  2FA key as the base32 key or an `otpauth://` link, on the Pool tab as on
  the Fleet tab (v1.262.1). Since v1.377.0 the Cookie cell says how long
  ago the session was saved ("Saved 12 min. ago"), with the exact time and
  who saved it (the fleet worker that uploaded it, or the manager who pasted
  it) on hover. The editor adds what the stored session holds: cookies and
  the site storages a worker's upload carries. The import maps a pasted
  header row by column name. Since v1.310.1 a second Password column after the e-mail is the
  mailbox's, and any other repeated column refuses the rows that fill it.
  Every row splits on the header's delimiter. Without a header, columns are
  read by position, and a note in the older place right after the cookie
  still arrives as a note. Since v1.272.0 the pick does more than label the
  account. Saving a newly picked worker, or **Send the login again**, writes
  the account's login, password, 2FA key and e-mail into that worker's vault
  account with password login allowed, and queues Re-login. The worker then
  signs in inside its own browser, through its own proxy; any checkpoint is
  finished in Watch. Since v1.290.0 the account's own cookie is seeded as the
  worker's session (RS-308) and, since v1.308.0, its access token travels too
  (RS-338) — for a first-party token the worker can mint a fresh session from it
  when the cookie lapses; the purchased-pool tokens are not first-party, so they
  fall back to the cookie path (see the Fleet-accounts note above). Either way
  the secrets stay server-side and nothing secret reaches the browser. The
  ledger records it as `assigned`. A worker that already holds
  another account, or an account with no password, is refused (RS-275).
  Since v1.280.0 the backend checks every Available, Taken and Fleet account on
  Facebook once a week, through the public profile-picture lookup (anonymous,
  no login, so it says nothing about the account's sessions). An account
  Facebook reports as disabled or gone moves to **Needs attention**, keeps its
  holder, and logs "Weekly check reported #n · disabled". A lookup that fails
  changes nothing and is retried within the hour. This is not a cron job: an
  hourly backend loop picks the accounts whose last check is over 7 days old,
  so deploys don't reset the week. The account's detail panel shows when it was
  last checked. A checkpointed account still looks alive to this lookup
  (RS-284). Since v1.306.0 the manager's table shows about ten rows and scrolls
  for the rest with the header pinned, and every column header sorts the rows —
  a first click ascending, a second descending — so the pool can be read by
  UID, status, holder, cookie freshness or any other field (RS-336). Since
  v1.375.1 the table card runs as tall as the Recent activity and Pool rules
  column beside it, showing more rows when that column is taller (RS-442).
- **Watching a worker's browser** — `/fleet/watch/<worker>` shows the live
  Chromium a Facebook worker is driving, through noVNC, view-only until
  "Take control" is ticked (and handed back when the tab is hidden), with
  Re-login and Reconnect.  The socket is same-origin
  (`/api/coordinator/vnc/<worker>/ws`); the backend admits it through the
  usual middleware plus an Origin check, mints the facade's single-use VNC
  ticket and relays bytes, so the facade token and Cloudflare Access
  credentials stay server-side.  Offered for every worker the facade can
  bridge to (`RS_VNC_TARGETS`) (v1.204.0).  The relay re-checks the
  manager's session every minute.  A manager who is signed out, deactivated
  or demoted loses the view within a minute.  When the access token behind
  the socket runs out, the viewer reconnects on its own with a fresh one and
  keeps control if it had it (v1.209.1).  It is opened from the worker's page,
  and its back link returns there (v1.263.0).  A **Sign-in** panel beside the
  browser shows the worker's Account pool login (login, password and email
  password behind a reveal, account UID, recovery email, Facebook profile),
  its live 2FA code with a countdown, and the worker's state, region,
  session, heartbeat, proxy and build.  The code band lights up while the
  worker is in a 2FA challenge.  A click on the code copies it.  While
  "Take control" is on, **Type into browser** sends the code, login or
  password as keystrokes into the focused field of the remote browser,
  because a copied value doesn't reach the VNC session.  Copies, reveals and
  typed secrets go to the pool's activity ledger.  A worker whose login
  isn't in the pool gets the vault summary and a link to the pool instead.
  The panel can be hidden, which is saved per user, and it stacks under the
  browser below 1100px (v1.276.0).  Since v1.277.0 a re-login can be
  followed as it runs (RS-280). From the worker's page, **Re-login & watch**
  queues it and opens this view (**Re-login only** keeps the old behaviour).
  A strip above the viewer then says where the login is: queued, signing in,
  needs you (a captcha, a code or a login form left open, with a Take control
  button), signed in, or did not finish. While a login is in flight the page
  re-reads the fleet every 3 seconds instead of every 30. The worker collects
  the request within about 10 seconds between sweeps (facebook-tracker
  v0.9.0); mid-sweep it starts at its next search. A coordinator older than
  v0.9.0 reports no steps, and the strip stays hidden.  **Full screen**
  (v1.282.0, RS-296) gives the browser and the sign-in panel the whole
  display, with the browser scaled to fill it, the panel beside it at any
  screen width (v1.291.1). Taking control enters full
  screen and handing control back leaves it. Esc only shrinks the view, and
  control stays on. A bar at the top repeats the status, Take control,
  Re-login, the panel toggle and Exit. Since facebook-tracker 0.12.4 (RS-295)
  the view is cropped to the worker's browser window, not its whole X display.
  Since v1.366.0 (RS-417) an ERP-fleet worker (`worker-60-14-1`) gets the
  same page at the same path, opened from its worker page's **Watch
  browser**: the live browser through the ERP's own relay
  (`/api/fleet/vnc/<worker>/ws`), Take control, Full screen, Hide account and
  the Sign-in panel with its slot's pool account (Pool #N, live 2FA code with
  Copy and Type into browser, login, password, UID, Facebook user), then
  state, host (the fleet has no region), session, heartbeat, the listed proxy
  (label, host:port, timezone; no exit lookup) and build. Its **Re-login**
  shows the same confirm and queues a one-shot `relogin` directive the
  worker's next heartbeat (within about 20 seconds) delivers once
  (facebook-tracker 0.14.4 or later); the strip says queued, taken, or needs
  you when the worker reports a checkpoint or challenge after it. Re-login is
  greyed out for a worker that holds no slot. Homelab ids keep the
  coordinator's feed.

- **Web submissions** — the manager inbox for the public website forms
  (v1.187.0). The ram4cash.com sell form (`POST /api/public/intake`) and the
  recycleservers.com quote form (`POST /api/public/quote`) each store a
  `WS-nnnn` row and notify managers; nothing anonymous touches orders. The page
  lists them by status (new / contacted / converted / archived / spam) with
  counts, a site filter and search; a submission opens with its details, line
  photos, a status + staff-note triage panel and its email conversation. **Create
  Draft PO** converts a sell lot once into a Draft PO owned by the clicking
  manager (lines at cost 0, photos copied, seller filed as a house-account
  supplier with source `web`, PayPal or cash + pickup per the seller's choice).
  Both endpoints allow 5 submissions a minute per IP and drop a filled honeypot
  silently.
- **The public forms have a daily ceiling and their own CORS** (v1.195.0).
  Together they accept 300 submissions or 2 GB of photos per UTC day
  (workspace settings `public_form_daily_submissions` and
  `public_form_daily_bytes`), then answer 429 until midnight UTC. The per-IP
  limit keys on the visitor's real address, with IPv6 grouped by /64; until
  v1.195.0 every request looked like one of a few Cloudflare servers. One
  address gets at most 20 a day, so a single sender can't spend the shared
  budget (v1.195.1), counted per /64 for IPv6 since v1.200.1. An
  intake post is capped at 25 MiB and each photo at 15 MiB. A photo over 40
  megapixels, or one whose image header can't be read, is refused with a 400
  instead of being stored as is, whatever its size since v1.200.2. Staff
  uploads keep sharp's own, much higher, ceiling (v1.195.1). The daily byte
  budget counts each incoming photo at most at the upload cap, the most its
  stored copy can take (v1.200.2). The two form routes answer the
  marketing-site origins without credentials; those origins get no CORS
  anywhere else.
- **Spam and archived submissions are deleted after 30 days** (v1.195.0),
  together with their photos in R2, by a daily job. A row whose photo delete
  fails is kept, so the next run retries it. A converted submission is never
  deleted, even archived later (v1.200.1): it is the PO's record of who sold
  the lot.
- **A submission carries its email conversation** (v1.209.0).
  - **Sending.** The thread reads like a mail client: the subject on top,
    earlier messages folded to one line (sender, snippet, date, any problem),
    the newest open with its From / To. A manager writes the reply in a draft
    showing the From / To / Subject it will go out with. It goes out from one
    shared company mailbox, a Lark box set by `MAIL_USER` and
    `MAIL_PASSWORD`.
    - A ram4cash sell request is sent as "ram4cash" with the subject "Your
      sell request WS-nnnn · ram4cash.com".
    - A recycleservers.com quote is sent as "Recycle Servers".
    - The first sent reply moves a `new` submission to `contacted`.
  - **Receiving.** Every two minutes the backend reads the box's INBOX over
    IMAP, read-only, so nothing in Lark changes. It attaches a customer's
    answer to the thread only when the answer replies to a message the ERP
    sent: its `In-Reply-To` or `References` names one of our Message-IDs.
    A WS id in the subject is not enough, because ids are sequential and a
    From address is easy to forge. A customer who writes a fresh email
    instead of replying stays in Lark. Mail whose From names more than one
    address is ignored. Other mail is never downloaded. Lark keeps the
    ERP's Message-ID and files each sent reply in its Sent folder (checked
    against the live box).
  - **What the thread shows.**
    - Each answer shows its sender address, with a warning when that isn't
      the submission's address or Lark's DMARC check failed.
    - Quoted history is folded away.
    - Attachments are listed by name, to open in the mailbox.
    - A reply notifies managers, except on spam.
    - Every send shows as sent, not sent (with the server's error), or "not
      confirmed" if the backend died mid-send.
  - **Without the two variables** mail is off and the page keeps its
    reply-by-email link. `/api/health` reports `providers.mail` as `smtp`,
    `stub` or `off`.
  - **A test-recipient list** (v1.209.2). With `MAIL_ALLOW_TO` set, the server
    mails only the listed addresses or domains.
    - **Other recipients:** the draft says so, Send is disabled, and the API
      answers 403 without recording anything. The draft carries a "Test list
      only" chip.
    - **Non-production Railway environments:** mail stays off unless the list
      is set. Dev's data is a copy of prod, so its submissions are real
      customers.
    - **Health:** `/api/health` adds `providers.mailRestricted`.

## MCP and OAuth connectors

`/api/mcp` is Bearer-only and CSRF-exempt. Tools: market read/write, sellable
inventory search, sell-order draft creation.

- Connectable from both Claude and ChatGPT (v1.46.0).
- **Interactive consent lets the user choose which permissions a connector
  gets** (v1.48.0), ceilinged by role: a manager can grant any scope, everyone
  else keeps `market:read` only (v1.67.x). Manager-minted service clients are
  exempt. The phone shell shows the same consent screen (v1.239.2).
- Purchasers can reach the connect page (v1.66.0).
- `wechat:write` (v1.312.0) is for memtrade's service client, which pushes the
  WeChat market report. Self-registration never grants it, even to a client
  that names no scope; a manager mints it under Settings → Connectors.
- Per-tool gating lives in `TOOL_SCOPES` and filters both `tools/list` and
  `tools/call` — a connector missing tools has a scope problem, not a missing
  tool.
- Tool failures answer as normal results with `isError: true`, not JSON-RPC
  errors; only protocol failures are errors. Every tool ships MCP
  `annotations`, without which clients label read-only tools destructive.
- When two reference prices share a part number, `get_market_value` and
  `set_market_price` use the most recently updated one, like the scraper push
  (v1.219.1).
- DCR is open by default, rate-limited per IP (per /64 for IPv6 since
  v1.200.1) and globally. A registration names at most 10 redirect URIs of up to 2048
  characters each (v1.239.2).
- **Consent says where the code goes** (v1.195.0). Any app can register itself
  under any name, "Claude" included. The consent page therefore names the
  redirect host and marks a self-registered client **Unverified**. The
  Settings connector list shows each client's redirect URIs and the same
  badge. `/oauth/token` and `/oauth/revoke` refuse past 60 calls a minute per
  client and 120 per client IP.

## AI scanning and OCR

- **Label scanner for SSD lines**, gated by `categories.ai_capture` (v1.96.0),
  with high-res capture and client-side MozJPEG compression (v0.1.1).
- Mobile QR/serial scanning: a button on the serial-number field (v1.83.0),
  single-shot — capture, confirm, auto-close (v1.83.2).
- **AI read for damaged codes** (v1.192.0): the serial scanner on the phone
  Submit form has a QR / AI switch (opens on QR). In AI mode a shutter sends
  the framed shot to `POST /api/scan/serial`, the same OpenRouter vision model
  as label OCR reads the *printed* S/N, and the read is shown with Use /
  Retake — never auto-added. Nothing is stored. The Shipping tracking scan has
  no switch.
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
- **Scan a whole sheet of RAM at once** (v1.178.0, RS-109). **New order →
  Scan RAM sheet** takes one flatbed page of sticks, either from the office
  Canon through the local scanner bridge (`auto_ram_scanner`, loopback
  `127.0.0.1:47811`) or from an uploaded image.
  - The page is split into one crop per stick in the browser
    (`segmentRamSheet` in `@recycle-erp/shared`), and each crop goes through the
    same `/api/scan/label` RAM pipeline as a single photo.
  - The dialog shows the page with numbered outlines, and each stick with its
    fields, confidence and whatever is still missing. Sticks lying against each
    other are flagged rather than silently read as one.
  - Purchasers set qty and cost, with an apply-to-all cost. Identical part
    numbers combine into one line. The lines arrive unconfirmed, with their
    scan image, so the usual blockers name anything the label couldn't supply.
  - **Each row on the new order shows its label photo** (v1.183.0, RS-117). The
    items table puts a 40px thumbnail of the scan (or first saved photo, `+N`
    when there are more) after the item name. Clicking it opens the full-screen
    viewer without selecting the row. This works for single scans and for rows
    the label couldn't fill.
  - **The dialog shows each stage live** (v1.180.0, RS-114).
    - A step row runs Connect → Scan page → Find sticks → Read labels.
    - While the printer works, the page sweeps and the dialog shows elapsed
      seconds and an estimate bar. Each stick's outline pulses while its label
      is read, and its row fills in from a placeholder.
    - **Cancel scan** deletes the printer's job.
    - Failures say what to do: bridge not running, printer asleep, scanner busy.
    - Clicking a stick's picture (or its box on the page) opens it full size.
    - The chip re-checks a stopped bridge on its own every 5 s.
  - **Scanned sticks save to the PO straight away** (v1.182.0, RS-116), as a
    confirmed line does.
    - Every stick that passes Confirm's rule (required fields, brand
      confirmation, DDR5 serials) is saved in one go when **Add** is clicked.
      The first save creates the draft PO.
    - A stick whose part # contradicts its specs is asked about first, as its
      Confirm would be (v1.247.2). Cancelling holds that stick and every later
      one in question unsaved, and the message counts them.
    - The rest stay on the page, marked **Not saved**, and a message says what
      they still need. The Status column shows **Saved** for lines that are on
      the PO.
    - Deleting a saved line also removes it from the PO (this applies to
      hand-confirmed lines too).
    - Saves run one at a time, and Submit waits for an auto-save in flight, so
      there is never a second PO or duplicate rows.
    - The scanner bridge scans at the scanner's highest flatbed resolution,
      which it reads from the scanner, and the dialog shows it.
  - **Scans add up** (v1.181.0, RS-115).
    - Each new scan or upload adds its sticks under its own "Scan N" group,
      numbered on from the last stick. **Scan next page** continues the pallet.
    - A group can be removed, and **Clear all** empties the table.
    - A scan whose part numbers were all read before is flagged as possibly the
      same sheet twice, because combining identical part numbers would
      double the qty.

- **Desk scanner: a live camera in the desktop line drawer** (v1.184.0,
  RS-119). Meant for an iPhone on an overhead arm used as the Mac's webcam
  through **Continuity Camera**; any webcam works.
  - **Camera** under the AI label dropzone swaps it for the live feed. The
    iPhone camera is picked by itself (its separate Desk View device is
    skipped); another can be chosen, and the choice is remembered by device
    label (`scan.cameraLabel`).
  - **The box follows the stick** (v1.185.0, RS-121). It snaps around the
    stick found by its green PCB and glides with it (solid border); with no
    stick found it's a wide dashed default box. Small detection jitter doesn't
    move it, and a missed detection or two doesn't make it flicker.
  - **No click to capture.** Four times a second the browser checks the inside
    of the box at native resolution: text-like edges in view, nothing moving,
    and focus at its peak. Three such samples in a row (~¾ s) capture one
    full-resolution frame, flash, beep, and scan it through the same path as a
    dropped photo (`lib/deskScan.ts`).
  - **One scan per placement.** A still scene fires once; the next capture
    needs the scene to change (stick lifted, or a new one). Captures are at
    least 3 s apart. So a failed scan never loops on the same frame and burns
    the 20/min scan limit.
  - **Only the stick is sent** (v1.184.1, RS-120). The captured frame is
    searched for the green PCB (`findRamStickInPhoto` in
    `@recycle-erp/shared`), and just the stick — padded so the gold fingers
    survive, turned upright if it lies vertically — is scanned and becomes the
    line's scan photo. Desk, cloth and hands are left out. A non-green PCB or a
    steeply tilted stick isn't found, and the whole frame goes up instead.
  - A readable scan closes the camera, so swapping sticks can't overwrite the
    line; an unreadable one leaves it open to re-seat the stick. Brand-confirm
    **Retake** reopens the camera when the scan came from it.
  - **Open camera automatically** (`scan.deskCamera`) starts every scanless
    line's drawer with the camera live, so a pallet goes stick → fields →
    Confirm → next line.
- **A RAM line is checked against its own part number** (v1.243.0, RS-228).
  `decodeRamPart` (`shared/ramPartDecode.ts`) reads the makers' numbering
  schemes — Samsung, SK Hynix, Micron/Crucial, Kingston (retail and HP OEM),
  G.Skill, Corsair — and gives only the fields the number fixes. OEM numbers
  with no spec in them (Kingston `9995…`, `KKRVFX…`) decode to nothing.
  - **Readout:** under Part # (desktop drawer, phone form) the decoded spec,
    with the module family marked: `M393A2K40`BB1-CRC0Q → Samsung 16GB DDR4 ·
    Server · RDIMM · 1Rx4 · 2400.
  - **Fill:** typing or scanning a part # fills blank specs. Picked or scanned
    values are never replaced; the part # a line opened with never fills.
  - **Every save asks** when a named field contradicts the part #: use the
    part #'s specs, take a corrected part #, or keep as entered. The readout
    has a per-field fix. Since v1.247.2 that is every save of a RAM line, not
    only the drawer's Confirm and the phone form: Submit order and adding the
    next line on a new PO, the RAM sheet's auto-save, Save on the PO page and
    the inventory editor's Save. A save over several products asks product by
    product, naming each; cancelling a question stops the save.
  - **Asked once per disagreement** (v1.247.2): keeping one as entered is
    recorded on the line, so Submit or Save doesn't ask again what the drawer
    asked, and fixing one field doesn't reopen the others. A saved line's own
    disagreements count as answered: editing its price or qty doesn't ask,
    changing a spec or the part # does. Recording the answer alone doesn't
    make a PO line an edit.
  - **Misreads:** a part # that decodes only one look-alike character away
    (O/0, HMAA/HMA8, PZ/PDZ…) is decoded through that reading with a button to
    correct it, and when the form disagrees, readings that agree with it are
    offered. One that decodes only through a look-alike may be a scheme the
    decoder lacks, so nothing fills from it or rewrites it unasked; and when
    two readings both decode further, neither is picked (v1.247.1).
  - **Label scans cross-check themselves:** a RAM scan whose part # is one
    misread from agreeing with the label's printed specs comes back corrected;
    blanks are filled from the part #; a contradiction that remains is shown
    with Retake (desk camera stays open; RAM sheet offers a re-read). On the
    desktop drawer the scan owns what it wrote: a part # typed or read
    afterwards fills blanks only (v1.247.1).
  - Compared loosely where the trade does: DDR3 speed by MT/s (`12800` =
    `1600`), and a DDR4/DDR5 speed printed as its PC4/PC5 rate the same way
    (`25600` = `3200`, v1.247.1); consumer kits per stick
    (`F4-3200C16D-32GVK` → 16GB), Kingston kits too (`KVR26N19S8K2/16` → 8GB,
    v1.247.1).
  - Also read since v1.247.1: Kingston DDR3L (`KVR16LR11D4/16`,
    `KCP3L16SD8/8`) and SK Hynix VLP RDIMMs (`HMA81GV7AFR8N-VK`).
- **Chip # fills itself from the part number** (v1.186.0, RS-122). Once a
  part number's chip # is on record, a RAM line never needs it typed again.
  The map is learnt from past PO lines (`POST /api/market/chips`): the chip #
  recorded on the most POs for the canonical part number wins, ties go to the
  newest, and archived POs don't count. It is workspace-wide, so a purchaser
  benefits from everyone's lines.
  - Typing or scanning a part # (desktop drawer, desk scanner, phone form)
    fills a **blank** chip #. A chip # the user typed is never replaced.
    Clearing a filled chip # keeps it clear.
  - Opening an existing line doesn't fill, so an untouched PO never turns
    dirty or goes back to Draft. Read-only lines never fill.
  - **Scan RAM sheet** fills known chips before its auto-save, so a Micron
    stick whose part # is on record saves at once.
  - **For Micron the suggestion is a die code** (v1.231.0, RS-209). Before
    that, each stored chip carried its own date code, so the "most POs" vote
    picked one stick's marking. One part number can still ship with
    different dies (`MTA16ATF2G64HZ-3G2J1` is recorded with WSM and VPP), so
    check the suggestion against the chip.

> Provider selection is silent: OpenRouter when `OPENROUTER_API_KEY` is set,
> otherwise a deterministic stub. A prod deploy missing the key looks healthy
> and quietly stubs. The model is **`openai/gpt-6-luna`** for every image-AI
> call — labels, receipts, PayPal screenshots (v1.181.0, RS-115; it was
> `google/gemini-2.5-flash` before, not the Gemma this note used to name). It
> is tuned for OpenAI: high image detail, minimal reasoning, JSON mode, and
> an empty answer is asked again once. It reads 300 dpi flatbed scans reliably
> but is weaker than Gemini on blurry/low-resolution images. Roll back without
> a deploy by setting `OPENROUTER_OCR_MODEL=google/gemini-2.5-flash` on
> Railway; a non-OpenAI model gets the old request.

## The two shells

- **Installed-app shortcuts and shared photos land where they say**
  (v1.258.7). The manifest's Submit, Inventory and Sell orders shortcuts and
  the share-target landing are real paths the hash router now reads as the
  route they name; on the phone, Submit opens the capture flow and a shared
  photo is scanned the moment the camera opens for the next new product —
  never for a rescan of an existing line — compressed first, and dropped
  when the capture ends (v1.258.9). The
  phone can zoom. Dialogs and phone sheets keep Tab inside them; proof
  uploads and item-type picks work from the keyboard; the phone's capture
  button and every hardware field have accessible names.
- **The RMB Flow is on the phone too** (v1.310.0): a Home link for managers, the
  book as a screen of its own, and the order's entries inside the PO page's
  Cost Payment and Commission folds. See [RMB Flow](#rmb-flow).

One bundle, two lazy-loaded shells chosen in `App.tsx`: viewport under 720px →
`MobileApp`; else `DesktopApp`. The third, the `/v/<token>` vendor portal, was
removed in v1.191.0.

- **The shell is chosen once per page load** (v1.200.0). Resizing across 720px
  no longer swaps it, which used to unmount the page mid-edit. Instead a
  **Switch to phone / desktop layout** button appears at the top. It asks
  before discarding unsaved edits.
- **Leaving unsaved edits asks first** (v1.200.0). Escape, Cancel and Back on
  the desktop PO editor, the sell-order editor, the phone submit form, and
  desktop submit with unconfirmed lines ask before discarding, and so does a
  reload or tab close. A dialog closes on the backdrop only when the press and
  the release both land there, so a drag out of a field no longer shuts it.
  Since v1.200.1 the sidebar, the phone tab bar, record links and the
  browser's Back and Forward ask too, and so does backing out of a phone PO.
  The phone PO's order and products screens are one page, so moving between
  them never asks. A save that then navigates never asks. A refused Forward
  or typed address leaves the page where it was in history: Back still leads
  to what was behind it, and Forward to the refused page (v1.200.2).

- The desktop shell runs down to 720px. **Under 900px its sidebar folds to a
  64px icon rail** (v1.134.0) — brand mark, nav icons with their names on
  hover, avatar and sign-out — where it used to disappear and leave a
  split-screen window with no navigation at all.
  **At any width the user can fold it to the same rail** with the toggle in
  the brand row (v1.208.0). It is a per-user preference (`sidebar.folded`), so
  it follows the user across reloads and devices. Under 900px the rail is
  forced and the toggle hidden. In the rail every link keeps its name for
  screen readers, and Submit order shows only its green `+` badge (v1.271.2).
- **The sidebar has a second level** (v1.207.0). A parent entry opens while
  you are on one of its pages and is one row with a › caret everywhere else;
  clicking it opens its first child. Two parents today: **Oversight ▸
  Accounting** (v1.317.0), holding **Payments** (`/payments`, lit on Internal
  transactions too) and **RMB Flow** (`/accounting`); and **Oversight ▸
  Monitors**, holding **Facebook** (`/fleet`), **Reddit** (`/tracker`) and, since
  v1.312.0, **WeChat** (`/wechat`). A parent's pages print its breadcrumb as
  the page-sub. In the icon rail the caret hides and the open children show
  as icons.
- **Menus and record references are real links** (v1.144.0). The sidebar,
  the Analysis tab strip, the phone tab bar and Home quick links, and
  every PO, sell-order or payment id shown on another page — the inventory
  lots table, the item page, payments rows and match suggestions, shipping,
  the sell-order list, the client drawer — are anchors with the
  hash written out. A plain click still routes in place (the back button keeps
  working); ⌘/ctrl/middle-click and "Open in new tab" open the record in a
  new tab. The PO page's "Open payments" lands on the list focused on that
  PO. Sell-order links stay desktop-only: the phone shell has no sell-order
  route.
- **A desktop tab offers a reload once a new build is live** (v1.221.0). The
  build writes `version.json` next to the bundle; a desktop tab reads it when
  it comes back into view (at most every 5 minutes) and, when it no longer
  matches the build it is running, shows the same "new version" toast the
  phone app shows for its service-worker update. A tab or iPad left open
  across a release would otherwise keep numbering against the new API with
  old code. The phone keeps its service-worker flow.
- **An iPad gets the desktop shell** — every iPad is at least 744px wide.
  Most desktop pages are built for a pointer; sell-order Pack mode (v1.218.0)
  is the one page laid out for touch. An iPad in Split View narrower than
  720px loads the phone shell, which has no sell-order routes.
- The mobile shell is a **PWA** with install onboarding, a service worker and a
  share target, scoped to mobile only (v0.1.1).
- **Tapping into a field no longer zooms the page on an iPhone or iPad**
  (v1.332.1). iOS zooms into any focused field under 16px and stays zoomed,
  and every field on the phone is 14px. On iOS alone, the viewport now caps
  the scale; Safari still lets a pinch go past it. Elsewhere the viewport
  stays uncapped, so the phone can still be pinch-zoomed (v1.258.7).
- Mobile PO lists colour-code warehouse, status and owner with stable hashed
  hues (v0.1.3).
- On mobile, the PO edit screen **docks the four category add-targets above the
  action bar** (v1.109.0), so adding a second item no longer means scrolling
  past every item already on the order — the screen reopens at the top after
  each line, which made the in-flow row recede a little further with every use.
- All strings go through `useT()`; the app ships English and Chinese.
- **Escape closes only the top dialog** (v1.179.0). Desktop dialogs share one
  Modal. Escape dismisses the dialog on top and leaves the one or the page
  under it open, is ignored while a dialog is saving, and an autofocused field
  keeps focus when a dialog opens.
- User preferences (theme, list-view modes) flow through `lib/preferences.tsx`
  and persist server-side.
- **A deploy no longer breaks tabs that were already open** (v1.121.1). A
  content-hashed chunk that a release has replaced now 404s instead of being
  answered with `index.html`, and a tab that asks for one reloads itself once
  onto the current build rather than stalling on a skeleton.
- **Unknown paths are a 404** (v1.221.1). The shell is served only at `/`,
  `/authorize`, `/login`, `/share-target` and the PWA shortcuts; any other path — at the
  edge or through the service worker — gets a "Page not found" page instead of
  the app rendering whatever its `#/` hash names.
- **The load starts before the bundle does** (v1.122.0). A small boot script,
  injected ahead of the entry, preloads whichever shell the viewport is about
  to need and starts `/api/me`, `/api/lookups` and `/api/workspace` — none of
  which needs React — instead of leaving all four to be discovered after 255 KB
  of JavaScript has parsed.

## Observability

- **`/api/health` reports whether attachment storage is configured**
  (`providers.attachments`: `r2` or `none`, v1.258.8). In production a
  missing bucket refuses uploads with a 503 instead of recording a stub;
  a partial R2 configuration refuses to boot.

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
- **Ops alerts reach one Telegram group** (v1.322.0, v1.325.0). Everything
  goes to the "Homelab Alerts" group, each source in its own topic:
  - all seven Railway projects: deploy failed, crashed, out of memory,
    CPU/RAM monitor and volume alerts, triggered and resolved (v1.322.0);
  - the ERP uptime probe;
  - the reddit fleet: a worker down, a loop failing three times in a row,
    and every warn/error line as a minute digest. The watch's own failures
    to reach the relay stay out of that digest (v1.332.2);
  - homelab Prometheus (Alertmanager);
  - the Facebook fleet's ops alerts (worker down, session expiring,
    challenge) and deploy notices (facebook-tracker 0.13.15). The buyers'
    listings group now carries only listings;
  - failures of memtrade's daily WeChat market report.

  A Railway message names the project, environment, service and commit, and
  links to the deployment. The relay is a Cloudflare Worker, so alerts still
  arrive while Railway is down (`docs/agents/erp-ops.md`).
