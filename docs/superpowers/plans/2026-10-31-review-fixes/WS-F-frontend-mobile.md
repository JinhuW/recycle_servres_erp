# WS-F — ERP frontend desktop + mobile/PWA

Plan for the 87 findings in `inputs/WS-F-frontend-mobile.json` (review base
62f53dec, planned against `origin/dev` f0c1d856, ERP v1.396.0). Planning only:
nothing here has been built.

## 1. Goal and scope

Fix the frontend's correctness, a11y and i18n defects found by lanes A6, A6b,
A6c, A6d and A7. The six P2 groups come first: mobile capture losing or
duplicating lines (A7-01, A6d-01, A6d-02), the desktop Submit form and sign-out
dropping pending work (A6-07), list memory leaking across users on logout
(A6-08), the one-click warehouse archive (A6-02), and the commission preview
not matching the backend (A6d-05). The 76 P3s follow, batched by failure
pattern (failed loads, unsaved guards, confirm/busy guards, money inputs,
dates, a11y/i18n, PWA).

**Already fixed on f0c1d856?** The three frontend commits since the review base
(RS-484/485/486) touch Market cards and the accounting attachments only. None
closes a WS-F finding. The spot checks on f0c1d856 still show the bug in each
case: `WarehousesPanel.tsx:56` (A6-02), `DesktopSubmit.tsx:144` (A6-07),
`auth.tsx:12` `clearLocalAuthState` (A6-08/A6-37/A6b-02), `SubmitForm.tsx:641`
(A6d-01), `MobileApp.tsx:627/667` (A7-01), `reviewPricing.ts:83` (A6d-05),
`redditLeads.ts` (backend) `/buyers` registered before `/:username` (A6d-15).
No finding is dropped as wrong or already fixed; §4 lists the parts deferred inside tickets.

**Cross-cutting prerequisite.** `apps/frontend` has no DOM test environment.
No jsdom, happy-dom or @testing-library is installed (`repro/A6-verify/NOTES.md`),
which is why the A6 P2s are still only PLAUSIBLE. Ticket F-00 adds one. Every
"RTL" test below assumes it.

Finding IDs covered (87): A6-01–03, A6-07–59 (no A6-04, A6-05, A6-06), A6b-01–04,
A6c-01–07, A6d-01–15, A7-01–05.

## 2. Tickets

Every ticket is ERP frontend code (plus small backend edits where noted). Each
one versions under the **ERP root `package.json`** (patch bump), gets a
`CHANGELOG.md` section and its own RS ticket, and ships as one squash-merged PR
to `dev`. Release to `main` goes through the normal owner-approved release.
**None of them starts a Facebook worker or causes a login.** The frontend
deploys to the Cloudflare Worker and the backend to Railway `backend`. No
tracker container is touched.

Shared conventions for the fixes:

- **Confirms**: `ConfirmDialog` from `pages/desktop/settings/dialogs.tsx`
  (desktop) or `ConfirmDialogBody` from `pages/desktop/fleet/shared.tsx`
  (fleet). Always pass `busy`, and ignore `onConfirm` while pending.
- **Unsaved edits**: `useUnsavedGuard(dirty)` + `confirmDiscard()` from
  `lib/unsavedGuard.tsx`. Every close path (X, Cancel, Escape, backdrop) goes
  through `confirmDiscard()` when dirty.
- **Escape layering**: `useEscapeKey(handler, active)` (`lib/useEscapeKey.ts`),
  not ad-hoc `onKeyDown` Escape branches.
- **Load states**: one small `useLoad()`-style tri-state (`loading | ok | error`)
  or an inline `{error && <RetryRow onRetry=…/>}`. Add one shared `RetryRow`
  component in `components/`, so the dozen failed-load fixes look the same and
  share their i18n keys (`loadFailed`, `retry`, in both `i18n.tsx` and
  `i18n.zh.ts`).

---

### F-00 — Frontend DOM test harness and pinned TZ

| | |
|---|---|
| Findings | **A6d-09** |
| Severity | P3 (enabler for all P2 tests) |
| Versions | ERP root bump (patch) |
| Worker restart | No |

**Change**
- `apps/frontend/package.json`: add devDeps `happy-dom` (or `jsdom`),
  `@testing-library/react`, `@testing-library/user-event`. Use pnpm only, and
  commit the updated `pnpm-lock.yaml`.
- Add `apps/frontend/vitest.config.ts` (or a `test` block in `vite.config.ts`):
  default environment `node`, so the 1,248 existing tests are unchanged.
  `*.dom.test.tsx` files opt in with `// @vitest-environment happy-dom` or an
  `environmentMatchGlobs` entry. A `setupFiles` entry stubs
  `IntersectionObserver`, `matchMedia` and `navigator.serviceWorker`.
- Pin the TZ: `"test": "TZ=America/Denver vitest run"`, plus
  `process.env.TZ ||= 'America/Denver'` in a `globalSetup`. CI then runs in
  Denver too. `.github/workflows/backend-tests.yml:127` calls the package
  script, so the workflow needs no edit. Check that it does.

**Tests**
- One smoke `components/Modal.dom.test.tsx`: Escape calls `onClose`.
- The A6d-09 proof: temporarily remove the `timeZone:'UTC'` branch in
  `fmtEta`, confirm the `orderPresentation.test.ts` trackingNote test now
  fails, then restore the branch. Record the result in the PR description.
- Fix any existing date test that only passed in UTC; that is the bug this
  ticket exposes.

**Owner gates**: Add `happy-dom` and `@testing-library/react` as frontend devDependencies? yes/no.
**Rollout**: CI only. Verify `pnpm --filter recycle-erp-frontend test` is green locally and on CI. Rollback: revert the PR.
**Effort**: M.

---

### F-01 — Mobile capture: no lost drafts, no double lines (P2)

| | |
|---|---|
| Findings | **A7-01** (P2), **A6d-01** (P2), **A6d-02** (P2), A7-04, A6d-07 |
| Versions | ERP root bump (patch) |
| Worker restart | No |

This is the mobile half of the architecture item "one persisted capture/edit
state machine". The scope is the defects only. The full state machine stays a
separate design (§4).

**Change**
- **A7-01** `apps/frontend/src/MobileApp.tsx` `onSaveLine` (~:627, catch at
  ~:667). `mintedHere` is computed before `ensureDraftId()` resolves, so a
  failed line B deletes the draft that line A has already landed in. Fix:
  - keep a per-draft `landedRef: Map<draftId, number>`, incremented after a
    successful `addLines` PATCH;
  - in the catch, delete only when `mintedHere && (landedRef.get(targetId) ?? 0) === 0`.
    Re-read through `captureRef` at failure time, not the closure, which is the
    same rule `cancelCapture` uses (~:170-175);
  - clear the draft id only when the draft was actually deleted.

  Backend `routes/orders/lifecycle.ts:62-110`: no change. Delete stays
  allowed for an empty draft.
- **A6d-02** `pages/SubmitForm.tsx:707` + `MobileApp.tsx:552-565, 636-641`:
  add a per-`_cid` in-flight latch (`savingCids: Set<string>` ref) in
  `onSaveLine`, and refuse a second call for the same `_cid` while the first is
  pending. Pass `saving` into `SubmitForm` to disable Save and the pnGen
  "Use" button.
- **A6d-01** `SubmitForm.tsx:641`: the Total cost input gets a `totalRaw`
  string state, the same pattern as the desktop `LineDrawer`. Render `totalRaw`
  while focused, derive `unitCost` from it, and clear it when qty or unit cost
  is edited or on blur.
- **A7-04** `MobileApp.tsx:912-927`: `useUnsavedGuard(capture.phase === 'review' && (pendingWrites > 0 || lines.some(l => !l._confirmed || l._dirty)), () => true)`
  so `PwaUpdateToast.tsx:55-65` (it already awaits `confirmDiscard()`) and the
  layout switch ask first.
- **A6d-07** `pages/OrderDetail.tsx:597-608` `advance()`: set an
  `advancingRef` latch at the top and clear it on every early return and in
  `finally`.

**Tests** (`*.dom.test.tsx`, needs F-00)
- `MobileApp.capture.dom.test.tsx`: port `repro/A7-verify/stale-minted-here.test.ts`.
  Defer `createDraftOrder`, save A then B, A's PATCH resolves and B's rejects.
  Assert no `DELETE /api/orders/:id`. Second case: a single failed first
  line still deletes the draft, which keeps the current behaviour.
- Double-click Save on the products-screen path with a deferred `api.patch`:
  one PATCH.
- `SubmitForm.dom.test.tsx`: qty 3, type `1`,`0`,`0` into Total cost; the box
  reads `100` and unit cost `33.33`. This mirrors `repro/A6d-verify/a6d.test.ts`.
- Review with an unconfirmed line: `confirmDiscard()` stays pending until the
  dialog is answered.
- OrderDetail Mark Done twice with `commissionPayments.check` deferred: one
  `POST /advance`.

**Owner gates**: none.
**Rollout**: Ship to `dev`, then run the iPhone check on inventory-dev, since iOS behaviour needs a real device. Capture two lines quickly in airplane-toggle conditions and confirm the draft survives with line A. Read-only on prod after release: no new empty-draft complaints. Rollback: revert the PR.
**Effort**: L.

---

### F-02 — Desktop Submit and sign-out keep pending work (P2)

| | |
|---|---|
| Findings | **A6-07** (P2), A6b-01, A6-35, A6-36, A6-53, A6-54 |
| Versions | ERP root bump (patch). A6-54 touches the backend PATCH as well, in the same release. |
| Worker restart | No |

**Change**
- **A6-07** `pages/desktop/DesktopSubmit.tsx:144`: widen the guard to
  `unconfirmed filled line || evidenceFiles.length > 0 || unfinished !== null || lines.some(l => photos.queuedFor(l._cid).length > 0)`.
- **A6b-01** `components/Sidebar.tsx:151`, `pages/Profile.tsx:151`: both
  sign-out buttons first `if (!(await confirmDiscard())) return;`. In
  `lib/auth.tsx:142` `logout()`, call a new `flushBeforeLogout()` registry
  before `POST /api/auth/logout`, while the cookie is still valid.
  `lib/useLineSaveQueue.ts:159` registers its drain there. Put the registry in
  the new `lib/sessionReset.ts` from F-03, so ship F-03 first or together.
- **A6-35** `pages/desktop/submit/LineDrawer.tsx:256`: capture the drawer's
  `openToken` at confirm start, and skip `onClose` if the token changed. Also
  disable Cancel, X, backdrop and Remove while confirming.
- **A6-36** `LineDrawer.tsx:684`: after deriving the unit from a typed total,
  show a `qty × unit ≠ typed total` inline warning ("saved as …"). Do not keep
  displaying the typed number as if it were saved.
- **A6-53** `DesktopSubmit.tsx:1293`: render the existing-draft choice and the
  part-number confirm through `<Modal ariaLabel=… onClose=…>`, guarded by
  `submitting`, the same way `DupPartDialog` does.
- **A6-54** `DesktopSubmit.tsx:824`: the merge into an existing draft must not
  write `otherFees` from a mount-time snapshot. Backend
  `apps/backend/src/routes/orders/patch.ts`: accept `addOtherFees?: number`
  and apply `other_fees = other_fees + $n` inside the PATCH transaction,
  validated as finite and ≥ 0. The frontend sends the delta. Ship order: the
  backend accepts the new field first, then the frontend sends it. Both can
  ride the same release because Railway and the Worker deploy from the same
  `main` push, and the old `otherFees` path stays.

**Tests**
- `DesktopSubmit.dom.test.tsx`: `uploadLinePhoto` fails after `persistLines`
  succeeds, and `hasUnsavedChanges('/purchase-orders')` is true.
- Sign-out: port `repro/A6b-verify/signout.test.ts`. With a dirty editor,
  reject the prompt and the user stays signed in; accept it and the queued
  PATCH is sent before `/api/auth/logout`.
- LineDrawer deferred `onConfirmLine`: close, open another line, resolve, and
  the second drawer stays open.
- Backend `apps/backend/tests/orders-patch-other-fees.test.ts`: the fee changes
  after the read, then `addOtherFees: 5`, and the sum is preserved.

**Owner gates**: none.
**Rollout**: `dev` → verify skill on the local stack (queue a photo, navigate, prompt appears; sign out with a pending line). Rollback: revert; the backend field is additive.
**Effort**: L.

---

### F-03 — Session reset registry on logout (P2)

| | |
|---|---|
| Findings | **A6-08** (P2), A6-37, A6b-02, A6b-03 |
| Versions | ERP root bump (patch) |
| Worker restart | No |

**Change**
- New `apps/frontend/src/lib/sessionReset.ts`:
  `registerSessionReset(fn)`, `runSessionResets()`, plus the
  `flushBeforeLogout` hooks used by F-02.
- `lib/auth.tsx:12` `clearLocalAuthState` calls `runSessionResets()` after the
  existing four resets. Move those four into the registry too.
- Register:
  - `lib/listMemory.ts` `mem.clear()` (A6-08, A6-37); this also clears the
    `DesktopInventory.tsx:148` selection, filters and search;
  - `lib/useManagers.ts` `forgetMembers()`;
  - the badge counters in `lib/accounting.ts:325-339` and `lib/redditLeads.ts:36-47`;
  - `lib/sellOrderPrefill.ts:13`;
  - the box-check `entryAnswer`.

  Also run the reset on login when `user.id` differs from the last one.
- **A6b-03** `lib/warehouses.ts:25-50`, `lib/lookups.ts:152-189`,
  `lib/workspace.ts:13-33`: each module gets a `generation` counter that
  `reset*()` increments. The loader captures it and commits only when it is
  unchanged.

**Tests** (node env is enough)
- `lib/sessionReset.test.ts`: set `usePersisted` values (call through `mem`
  helpers), stash a prefill, then `runSessionResets()`. Assert the memory is
  empty, the prefill is null and the badges read 0.
- `lib/warehouses.test.ts`: deferred fetch → `resetWarehouses()` → resolve the
  old fetch → the next `loadWarehouses()` issues a new GET.

**Owner gates**: none.
**Rollout**: `dev` → verify skill: log in as manager, filter inventory, sign out, log in as a purchaser, and the filters are clean. Rollback: revert.
**Effort**: M.

---

### F-04 — Confirm and busy guards on destructive clicks (P2)

| | |
|---|---|
| Findings | **A6-02** (P2), A6-13, A6-43, A6-44, A6-49, A6-56, A6c-06 |
| Versions | ERP root bump (patch) |
| Worker restart | No |

Use the same pattern as WS-A's A6-05 and A6-06, the login-causing confirms. If
WS-A lands first, reuse its helper; otherwise this ticket introduces it.

**Change**
- **A6-02** `pages/desktop/settings/WarehousesPanel.tsx:56` `setActive`: when
  `active === false`, open `ConfirmDialog` (danger) naming the warehouse, with
  the message "can only be restored in the database". Make no optimistic
  `updateRow` before confirming.
- **A6-13** `pages/desktop/DesktopInternalTxns.tsx:296`: confirm before Delete
  and disable it while the request is pending.
- **A6-43** `pages/desktop/settings/MembersPanel.tsx:159`: route Revoke through
  `setRemoving(inv)`, and add a `removingBusy` state passed as `busy`.
- **A6-44** `pages/desktop/fleet/FleetHosts.tsx:257` (AddHostDialog token step)
  and InviteMemberModal (temp password step): ignore backdrop and Escape
  (`closeOnEscape={false}`), so only Done closes. Disable Cancel and X while
  saving.
- **A6-49** `pages/desktop/DesktopShipping.tsx:407`: danger confirm naming the
  tracking number.
- **A6-56** `pages/desktop/TrackerPrompts.tsx:172` (Promote, End trial) and the
  Delete-subreddit confirm: add a pending flag and `busy`.
- **A6c-06** `components/PhPasswordSheet.tsx:50-54`: `onBackdrop={() => { if (!saving && !anyFieldFilled) onClose(); }}`.

**Tests**: one `*.dom.test.tsx` per surface. For each: click → no request until
confirmed; double-click confirm → one request. AddHostDialog in the created
state: Escape does not call `onClose`.
**Owner gates**: none.
**Rollout**: `dev` → verify skill on Settings → Warehouses (cancel leaves the card). Rollback: revert.
**Effort**: M.

---

### F-05 — Commission preview matches the backend (P2)

| | |
|---|---|
| Findings | **A6d-05** (P2) |
| Versions | ERP root bump (patch); backend + frontend in one PR |
| Worker restart | No |

Today `lib/reviewPricing.ts:81-88` computes `(revenue − total cost) × rate`
over every line, and `DesktopEditOrder.tsx:696-701` duplicates it. The backend
owes `max(0, Σ_priced qty × (sell − effUnitCost)) × rate`: only priced lines,
clamped at zero, using the effective unit cost from `po-cost.ts`.

**Change** (recommended: one source of truth)
- Backend: the order detail GET (`routes/orders/detail.ts`) returns
  `projectedProfit` and `projectedCommission`, computed by the same
  function the payout uses. Put it in `packages/shared` if it is pure;
  otherwise in the backend's commission module, exported.
- Frontend: `reviewPricing.ts` `reviewMoney()` uses the shared pure
  function for live edits (lines not yet saved) and shows the server number
  when it is clean. Delete the duplicate in `DesktopEditOrder.tsx:696-701`.
- Show the profit/commission row as "earns" only from the clamped value.

**Tests**
- `lib/reviewPricing.test.ts`: cases for an unpriced line and for revenue <
  cost. Assert the result equals the backend formula; pin both sides to the
  same fixtures.
- Backend `tests/commission-preview.test.ts`: GET returns
  `projectedCommission` equal to the payout path's value for the same order.

**Owner gates**: Confirm that the preview should show the clamped, priced-lines-only commission the backend pays, even when the gross preview looks higher? yes/no.
**Rollout**: `dev` → open three real-shaped orders (unpriced line, loss, normal) on the dev copy and compare the preview with the commission row after Done. Rollback: revert.
**Effort**: M. Coordinate with WS-E, which owns the backend commission and finance code, so they do not edit `po-cost.ts` at the same time.

---

### F-06 — Unsaved-edit guards on desktop editors (P3)

| | |
|---|---|
| Findings | A6-03, A6-12, A6-17, A6-21, A6-34, A6-45, A6-47, A6-55, A6c-01 |
| Versions | ERP root bump (patch) |

**Change**
- **A6-03** `DesktopAfterSales.tsx:283`: `load()` reseeds the Resolution
  draft only when it is clean. Call `useUnsavedGuard(dirty)`.
- **A6-12** `DesktopSellOrderDraft.tsx:206`: track a dirty flag, route every
  close through `confirmDiscard()`, and disable X and Cancel while saving.
- **A6-17** `DesktopInternalTxns.tsx:83`: on a member change, refetch only
  that record and patch its row in place, not a full keyset reload.
- **A6-21** `DesktopEditOrder.tsx:1355`: before Archive or Unarchive, if
  dirty, `await confirmDiscard()` and stop on false.
- **A6-34** `FleetCities.tsx:198`: Enter in the three add-own inputs calls
  `preventDefault(); addOwn()`.
- **A6-45** `DesktopBoxCheck.tsx:623`: Escape and backdrop confirm when
  `editing.line._dirty`, with `useUnsavedGuard(!!editing?.line._dirty)`.
- **A6-47** `DesktopWebSubmissionThread.tsx:65`: `useUnsavedGuard(draft.trim().length > 0)`.
- **A6-55** `TrackerPrompts.tsx:359`: confirm when the prompt or model is
  dirty.
- **A6c-01** `components/ItemTypePicker.tsx:75-76`: `useEscapeKey(close, open)`
  and drop the Escape branch from `onKeyDown`, so only the menu closes.

**Tests**: a `*.dom.test.tsx` per editor: edit → Escape or close → the discard confirm shows and the component is still mounted. ItemTypePicker inside an outer `useEscapeKey`: the menu closes and the outer handler is not called.
**Owner gates**: none. **Rollout**: `dev` + verify skill spot check on Box check and the PO editor. **Effort**: M.

---

### F-07 — Failed loads show an error and Retry, not a skeleton forever (P3)

| | |
|---|---|
| Findings | A6-19, A6-28, A6-29, A6-30, A6-31, A6-32, A6-50, A6c-05 |
| Versions | ERP root bump (patch) |

**Change** (all use the shared `RetryRow`)
- `DesktopPayments.tsx:1580`, the link picker (A6-28): in the catch, when
  `id === reqId.current`, call `setRows([])` and set an error.
- `DesktopClients.tsx:67` (A6-29): render the error card, not `EmptyState`.
  Keep the skeleton while `data === null`.
- `clients/ClientDrawer.tsx:31` (A6-30): on 404 or 403 show "not found"
  with a link back to `/clients`.
- `DesktopTransfers.tsx:171` (A6-31): add a loaded/error state, clear rows
  on a filter change, and show the empty text only after a successful load.
- `TrackerSeen.tsx:23` (A6-32) and `TrackerAnalytics.tsx:33` (A6-19): keep
  the previous data when a refresh fails. A6-19 also gets a per-effect
  `live` flag, or a check that `resp.window === win`.
- `DesktopActivity.tsx:255` (A6-50) and `components/SellOrderHistory.tsx:246-254`
  (A6c-05, gate the catch on `cancelled`): show the error and Retry.

**Tests**: per component, mock a reject and assert the skeleton or empty copy is gone and Retry refetches. A6-19 with fake timers: an out-of-order 7d/30d response, and the 30d result wins.
**Owner gates**: none. **Rollout**: `dev`; verify by blocking one endpoint in devtools on the local stack. **Effort**: M.

---

### F-08 — Paged lists keep depth and drop stale responses (P3)

| | |
|---|---|
| Findings | A6-11, A6-26, A6-27, A6-51, A6d-06 |
| Versions | ERP root bump (patch) |

**Change**
- **A6-11** `DesktopMarket.tsx:175`: remember the failed offset and stop arming
  the sentinel until the user clicks Retry or the query changes.
- **A6-26** `DesktopPayments.tsx:421`: after an action, patch the acted row in
  place from the response and refresh only the stats. Keep `openId`.
- **A6-27** `DesktopPayments.tsx:416` `refreshStats`: add a `statsReq` counter
  guard that mirrors `reload`.
- **A6-51** `DesktopActivityDrawer.tsx:64`: add a request-id guard and send
  errors through `handleFetchError`. Hide the pill counts while a filter is
  active. Server-side per-kind counts are deferred (§4 note).
- **A6d-06** `pages/Orders.tsx:168`: add a "Load more" control. Show
  "Showing 30 of N" when capped.

**Tests**: mocked `api.get` with two pages: act on a page-2 row and more than 50 rows remain. Out-of-order stats responses: the later one renders. A Market reject with an intersecting observer sends one request only. Orders with 40 summaries shows the load-more control.
**Owner gates**: none. **Rollout**: `dev` + verify skill on Payments with the dev copy (more than 50 rows). **Effort**: M.

---

### F-09 — Money and number inputs never save a wrong value (P3)

| | |
|---|---|
| Findings | A6-09, A6-10, A6-16, A6-20, A6-22, A6-25, A6-33, A6-42, A6-52, A6-59, A6d-04, A6d-08 |
| Versions | ERP root bump (patch) |

**Change**
- **A6d-04** `lib/inventoryEditPatch.ts:45`: a blank unit cost or qty is a
  validation error that blocks Save with a message. Never coerce `''` to 0.
- **A6-20** `DesktopInventoryEdit.tsx:451`: the save-bar Save gets
  `disabled={saving || archived}`; disable the inputs when archived.
- **A6-09** `DesktopMarket.tsx:706`: a blank price is invalid; the Cmd+Enter
  handler returns early `if (saving)`.
- **A6-10** `DesktopMarket.tsx:656`: when `sell.length < 2`, show the empty
  state, the same guard as `Sparkline`.
- **A6-16** `DesktopSellOrders.tsx:1782`: on a currency switch, show a
  blocking notice ("prices are now in CNY — re-enter them") and mark unchanged
  prices until they are edited. Do not auto-convert; see the owner gate.
- **A6-22** `DesktopInventoryTransfer.tsx:69`: leave out lots with
  `movable === 0`, shown greyed as "held by sell orders". Error only when
  `movable > 0 && n < 1`.
- **A6-25** `DesktopPayments.tsx:909`:
  `fmtMoney(Math.abs(n), row.currency ?? 'USD', locale)` for the row and its
  legs.
- **A6-33** `settings/GeneralPanel.tsx:146`: hold the data as `null` until the
  GET lands and disable the controls on failure. PATCH sends only the changed
  AI-review key. Check whether the backend merges the AI-review object or
  replaces it; if it replaces it, add a merge in the settings route.
- **A6-42** `DesktopDashboard.tsx:228`: divide by `Math.abs(prev)`.
- **A6-52** `DesktopAnalysis.tsx:200`: use `Intl.NumberFormat`
  `signDisplay:'exceptZero'`, with the arrow and colour chosen by sign.
- **A6-59** `settings/CategoriesPanel.tsx:57`: remove the dead "Add category"
  button. A blank margin on blur restores the saved value with no PATCH.
- **A6d-08** `lib/accountingForm.ts:86` + `accounting/AccountingCard.tsx:47-50`:
  pass `Math.max(owed, 0)`, and treat `preset.amount !== undefined` as set, so
  an amount of 0 leaves the field blank.

**Tests**: pure helpers in node env (`inventoryEditPatch.test.ts`, `accountingForm.test.ts`, the TrendChip and margin formatters); DOM tests for the Market dialog, the transfer modal and GeneralPanel (a toggle after a failed GET sends no PATCH).
**Owner gates**: When a sell order's currency is switched, should the typed prices be (a) kept, with a re-enter notice blocking Save (recommended), or (b) auto-converted at the loaded FX rate?
**Rollout**: `dev` + verify skill on Inventory edit and Sell order. **Effort**: L. Split into two PRs (inventory/market vs. finance pages) if it grows.

---

### F-10 — Calendar dates and time zones (P3)

| | |
|---|---|
| Findings | A6-39, A6-41, A6d-03 |
| Versions | ERP root bump (patch) |
| Depends on | F-00 (pinned TZ). WS-I C1-12 documents A6-39; ship this first so the doc describes fixed behaviour |

**Change**
- **A6d-03** `lib/format.ts:50-54`: add `fmtCalendarDate()` that formats with
  `timeZone:'UTC'` for date-only and UTC-midnight values, the same idea as
  `accounting.ts` `fmtBookDay`. Switch `DesktopHome.tsx:125, :153, :356` and
  `pages/Home.tsx:195` to it.
- **A6-39** `fleet/FleetTasksTab.tsx:44` `sinceFor('today')`: use Eastern
  midnight through the belt/funnel `America/New_York` helper.
- **A6-41** `clients/LogContact.tsx:29`: use the shared
  `todayIn`/`addDays` helpers, not `toISOString()`.

**Tests** (TZ=America/Denver): `fmtCalendarDate('2026-11-03') === 'Nov 3'`; `sinceFor('today', Date.parse('2026-10-31T01:00:00Z')) === '2026-10-30T04:00:00.000Z'`; fake time `2026-10-31T01:30:00Z` → `iso(7) === '2026-11-06'`. Port the A6d-03 case from `repro/A6d-verify/a6d.test.ts`.
**Owner gates**: none. **Rollout**: `dev`; check Home follow-ups in the evening Denver time. **Effort**: S.

---

### F-11 — Fleet pages (P3)

| | |
|---|---|
| Findings | A6-14, A6-18, A6-38, A6-40 |
| Versions | ERP root bump (patch) |
| Worker restart | **No.** UI reads only; "Search a city now" queues a task, which is not a login |

**Change**
- **A6-14** `DesktopCoordinator.tsx:66`: when the pool snapshot fails, show
  `RetryRow` instead of `FormSkeleton`.
- **A6-18** `fleet/FleetErpWatch.tsx:48`: `setPool({kind:'loading'})` before
  the fetch, and `key={accountNo ?? 'none'}` on `WatchAccountPanel` so a
  revealed secret never carries over to the next account.
- **A6-38** `fleet/FleetAnalysisTab.tsx:44`: the backend already sends
  `X-Fleet-Truncated` (`routes/fleet.ts:106`). Change `lib/fleet.ts:137`
  `tasks()` to return `{ tasks, truncated }` from a raw response. In
  `alertsByCity`, replace `tasks.length < 1000` with `!truncated`. Update
  every `fleetApi.tasks` caller.
- **A6-40** `fleet/FleetErpWorker.tsx:240` `SearchNowDialog`: when `initial`
  is not enabled, fall back to `enabled[0]`. Disable submit, and the worker-page
  button, when there are no items.

**Tests**: `alertsByCity` unit test (1,500 complete tasks → a rate; truncated → null); WatchAccountPanel rerender with a new account → the password is masked; SearchNowDialog cases.
**Owner gates**: none.
**Rollout**: `dev`. Verify read-only on dev's fleet pages. Do not press Search-now, Re-login or any worker action during the check. **Effort**: S.

---

### F-12 — Reddit leads (P3)

| | |
|---|---|
| Findings | A6-23, A6-46, A6-57, A6d-15 |
| Versions | ERP root bump (patch); backend route + frontend client in one PR |

**Change**
- **A6d-15** backend `apps/backend/src/routes/redditLeads.ts`: `/attention`
  (:134), `/buyers` (:143) and `/buyers/:username` (:152) are registered before
  `/:username` (:176), so a seller named `buyers` or `attention` is
  unreachable. Move the lead detail and its actions to `/u/:username` (`GET`,
  `/claim`, `/release`, `/dm`, `/reply`, `/reopen`). Keep the old
  `/:username` routes as aliases for one release, then remove them in a
  follow-up. Update `apps/frontend/src/lib/redditLeads.ts:15` to the new
  paths.
- **A6-23** `leads/BuyerNetwork.tsx:38` and **A6-46** `LeadsReddit.tsx:65`:
  show `RetryRow` on failure.
- **A6-57** `leads/LeadDrawer.tsx:219`: commit the follow-up date on blur or
  Enter, only when the year is ≥ the current year. Disable while busy.

**Tests**: backend `tests/reddit-leads.test.ts`: seed `buyers` and `attention`, and `GET /u/:username` returns each lead. DOM tests for the failed-load states, and for the date input firing one `followUp` call.
**Owner gates**: none. This is not a tracker contract; the leads API is ERP-internal.
**Rollout**: `dev`. Verify the leads page on dev. Rollback: revert; the old aliases keep working until the follow-up removes them. **Effort**: M.

---

### F-13 — Customer pickers (P3)

| | |
|---|---|
| Findings | A6-01, A6-15 |
| Versions | ERP root bump (patch); backend + frontend |

**Change**
- **A6-01** `DesktopSellOrderDraft.tsx:106` and the sell-order editor picker:
  request `/api/customers?status=active` (the backend already filters,
  `routes/customers.ts:42,67`). Keep the order's current customer as a
  one-off option. Drop the `r.items[0]` preselect so `sodBlockedNoCustomer`
  asks.
- **A6-15** `settings/CustomersPanel.tsx:38` + pickers: the backend has a 200
  default and a 500 cap (`customers.ts:45`). Add `q=` (name/company `ILIKE`)
  server-side search to `GET /api/customers` and use it from the pickers
  (`components/Combobox` async source). The panel's totals come from a new
  `summary` object in the same response, as server-side sums. The panel shows
  "showing N of M".

**Tests**: backend `tests/customers.test.ts`: 201 seeded customers, `q=` finds the 201st, and the summary count is 201. DOM: the picker lists only active customers and nothing is preselected.
**Owner gates**: none. **Rollout**: `dev`; check on the dev copy that the customer count matches `SELECT count(*)` (read-only). **Effort**: M.

---

### F-14 — Accessibility and i18n (P3)

| | |
|---|---|
| Findings | A6-24, A6-48, A6c-02, A6c-03, A6c-07, A6b-04, A6c-04, A6-58 |
| Versions | ERP root bump (patch). A6-58 adds a backend data migration |

**Change**
- **A6c-02** `components/SortTh.tsx:35-46`: wrap the content in
  `<button type="button">` with `aria-sort` on the `th`. This fixes
  DesktopOrders, InventoryProductTable, TrackerAnalytics, FleetWorkers and
  FleetAccountsTab at once.
- **A6-48** `FacebookAccountPool.tsx:484`: same button for its own headers,
  or switch to `SortTh`.
- **A6-24** `DesktopEditOrder.tsx:1465` and the InventoryProductTable chevron:
  a `<button aria-expanded>` in the item cell.
- **A6c-03** `components/RefinePanel.tsx:47-84`: Clear all becomes a sibling
  button, not a child of the header button.
- **A6c-07** `components/PhLanguageSheet.tsx:89-108`: the toggle gets
  `role="switch" aria-checked`, and the rows get `role="radio" aria-checked`
  inside a `radiogroup`.
- **A6b-04** `lib/i18n.tsx` `LangProvider`: an effect sets
  `document.documentElement.lang`. Add `comboboxOpen` and `comboboxClose`
  keys for `components/Combobox.tsx:130`.
- **A6c-04** `components/OrderActivityLog.tsx:116-146`,
  `RevertNoticeDialog.tsx:79-90`, `lib/orderPresentation.ts:106,127-173,219-221`:
  use `poStageName(slug, t)`, give `FIELD_LABEL` i18n keys (as `SellOrderHistory`'s
  `FIELD_KEY` does), and use `lib/format` `relTime` in `PhNotificationsSheet.tsx:29-39`.
- **A6-58** `clients/EditClient.tsx:66`: store the stable key (`cliShipThey…`,
  contact keys) and translate on display. Add a backend migration that maps
  existing English and Chinese labels back to keys in the client preference
  columns. Leave unknown values untouched. Read-side fallback: display the raw
  value when it is not a known key.

**Tests**: SortTh Tab+Enter/Space calls `onSort`; LangProvider zh sets `lang`; OrderActivityLog under zh has no English stage or field label; `EditClient` under zh sends `prefLogistics === 'cliShipThey'`. Migration test in `apps/backend/tests/` on seeded EN and ZH labels.
**Owner gates**: Run the A6-58 label→key migration as part of the normal release migration on prod? yes/no. It rewrites free-text-looking values in client preference columns; do a dry run on the prod→dev copy first, as in the data-migration memory recipe.
**Rollout**: `dev`. Dry-run the migration on the dev copy and compare row counts read-only before the release. **Effort**: L, or split A6-58 into its own S/M PR.

---

### F-15 — PWA platform: offline scanner, camera, CSP, telemetry (P3)

| | |
|---|---|
| Findings | A7-02, A7-03, A7-05, A6d-13, A6d-14 |
| Versions | ERP root bump (patch) |
| Depends on | WS-C for the CSP and edge-header policy decisions |

**Change**
- **A7-02** `apps/frontend/vite.config.ts:51`: add `wasm` to `globPatterns`.
  Raise `maximumFileSizeToCacheInBytes` to cover the zxing reader; check its
  size in `dist/assets`. In `components/SnScanner.tsx:125-154`, catch the
  `createFrameDecoder` rejection and show "decoder unavailable — use AI or type".
- **A7-03** `pages/Camera.tsx:112-127,168-178,317-321`: with no live frame,
  the shutter opens the file picker. The 8-byte placeholder stays only behind
  `import.meta.env.DEV`.
- **A7-05** `pages/Camera.tsx:134`: decode the shared-photo data URL with
  `atob → Blob`, not `fetch(dataUrl)`, which removes the CSP violation. Add a
  CSP report endpoint (`report-to`/`report-uri` →
  a small backend `POST /api/csp-report` that logs to the existing structured
  log, rate-limited). Update `public/_headers` and **bump `csp-rev` in
  `index.html`**. Stay report-only.
- **A6d-13** `lib/chunkReload.ts:61`: resolve `sessionStorage` lazily
  inside the existing try, with a no-op store fallback.
- **A6d-14** `lib/timing.ts:71`: when `nav.loadEventEnd === 0`, return
  without setting `sent`, so a later trigger reports.

**Tests**: a build-output test (`scripts/` or a vitest over `dist/sw.js` manifest) asserting every `assets/*.wasm` is precached; SnScanner with a rejecting decoder surfaces the note; Camera with getUserMedia rejected makes no `/api/scan/label` request; a `_headers` parser test that `connect-src` covers every `fetch()` scheme used in `src`; `chunkReload` with a throwing getter still installs; `timing` with `loadEventEnd: 0` sends nothing.
**Owner gates**: (1) Add a CSP report collector endpoint on the ERP backend (vs. an external reporting service)? yes/no. (2) Switching CSP from report-only to enforcing is **not** in this ticket. After two weeks of clean reports, decide it as an owner gate with WS-C.
**Rollout**: `dev`, then an iPhone on inventory-dev: install the PWA, go offline, and scan a DataMatrix. Confirm `/api/csp-report` receives nothing from a share-target run. Rollback: revert, and bump `csp-rev` again if headers changed.
**Effort**: M.

---

### F-16 — Shared lib helpers (P3)

| | |
|---|---|
| Findings | A6d-10, A6d-11, A6d-12 |
| Versions | ERP root bump (patch) |

**Change**
- **A6d-10** `lib/useAddPackageForm.ts:76-82`: map the scan through
  `readPaypalScan(scan)`. Set the txn id only when `read.txnId` is non-null,
  and the notice from `read.noticeKey`.
- **A6d-11** `lib/useChipFill.ts:45,82-88`: factor a pure
  `shouldClearOwnFill()` next to `chipFillQuery`. When the query is empty
  because the part reverted to `mountPart` and `autoFilled` is set, clear it.
- **A6d-12** `lib/priceFilePrecheck.ts:95-100,132`: also read `t="str"` and
  `inlineStr` cells and allow a namespace prefix (`<(?:\w+:)?row\b`). If the
  precheck still says columns are missing, warn but let the upload proceed;
  the server's verdict is authoritative.

**Tests** (node env): `useAddPackageForm` scan mapper (below floor → existing id kept); `shouldClearOwnFill` revert case; `priceFilePrecheck.test.ts` with str cells and x:-prefixed parts → ok.
**Owner gates**: none. **Rollout**: `dev`. **Effort**: S.

## 3. Order

| # | Ticket | Sev | Effort | Needs |
|---|---|---|---|---|
| 1 | F-00 harness + TZ | P3 (enabler) | M | — |
| 2 | F-03 session reset | P2 | M | F-00 optional (node tests) |
| 3 | F-01 mobile capture | P2 | L | F-00 |
| 4 | F-02 desktop submit + sign-out | P2 | L | F-00, F-03 (`lib/sessionReset.ts`) |
| 5 | F-04 confirms/busy | P2 | M | F-00. Share the confirm helper with **WS-A** (A6-05/A6-06) |
| 6 | F-05 commission preview | P2 | M | Coordinate with **WS-E** (backend commission/finance) |
| 7 | F-10 dates/TZ | P3 | S | F-00. **WS-I** C1-12 documents A6-39 afterwards |
| 8 | F-07 failed loads | P3 | M | F-00 (`RetryRow`) |
| 9 | F-06 unsaved guards | P3 | M | F-00 |
| 10 | F-09 money inputs | P3 | L | F-00 |
| 11 | F-08 paged lists | P3 | M | F-07 (`RetryRow`) |
| 12 | F-12 reddit leads | P3 | M | F-07 |
| 13 | F-13 customer pickers | P3 | M | — |
| 14 | F-11 fleet pages | P3 | S | F-07; no worker action |
| 15 | F-14 a11y + i18n | P3 | L | F-00 |
| 16 | F-15 PWA platform | P3 | M | **WS-C** (CSP/edge headers), **WS-D** if it adds a build-output gate |
| 17 | F-16 lib helpers | P3 | S | — |

Each ticket is its own PR to `dev` with its own patch bump. Concurrent sessions
collide on ticket and version numbers, so pick them just before merging.
F-01/F-02/F-03 touch `MobileApp.tsx`, `DesktopSubmit.tsx` and `auth.tsx`. Run
them in sequence, not in parallel worktrees.

Owner gates in this workstream: **5**:
1. F-00: add the frontend devDependencies.
2. F-05: the commission basis.
3. F-09: the currency-switch behaviour.
4. F-14: the A6-58 data migration.
5. F-15: the CSP report collector. CSP enforcement is a later decision, shared with WS-C.

## 4. Dropped / deferred

| ID | Disposition | Reason |
|---|---|---|
| — (none dropped) | — | Each spot-checked finding still reproduces in code on f0c1d856, and no frontend commit since the review base touches these paths. |

Deferred parts *within* tickets (the IDs themselves are closed in the tickets
above):

- **The full capture/edit state machine**, the architecture-todo item. F-01 and
  F-02 fix its four symptoms (A7-01, A6-07, A6d-02, A6b-01) in place. The
  persisted state machine shared by mobile and desktop needs its own design
  spec under `docs/superpowers/specs/` and is out of this workstream's scope.
- **A6-51 server-side per-kind counts.** F-08 hides the misleading counts
  under a filter. Exact counts from the endpoint, as `/api/activity` returns
  them, can follow if wanted.
- **A7-05 CSP enforcement.** F-15 adds reporting and removes the known
  violation. Enforcing waits for clean reports and an owner and WS-C decision.
