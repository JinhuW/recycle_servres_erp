# Component review TODOs — 2026-10-13

The primary reviewer read the 48 remaining frontend component modules in full and traced their relevant callers. This complements the frontend/shared review. P2 denotes a broken supported workflow; P3 denotes a smaller usability/lifecycle defect. These are source-confirmed findings; no production code was changed and browser/assistive-technology validation was not performed.

- [x] **UI-01 · P2 — Make evidence pickers and catalog buttons operable with a keyboard.** `apps/frontend/src/components/AttachmentDropzone.tsx:45–72` puts its only picker trigger on a nonfocusable div while its file input is `display:none`; neither Tab nor Enter/Space can open the picker. This is the shared proof-upload surface, including `CommissionPaymentFields.tsx:97`. `ItemTypePicker.tsx:147–188` puts create/pick actions solely in `onMouseDown`; a keyboard-generated button click has no action handler. The input has an arrow/Enter route, but users tabbing to the visible buttons cannot activate them. **Fix:** use a named native button or accessible labelled file input for the dropzone; handle button activation with `onClick`, retaining mousedown only for focus management. **Regression:** complete proof selection and item-type create/pick using Tab, Enter and Space without a pointer.

- [x] **UI-02 · P2 — Give capture controls and hardware fields accessible names.** `components/PhTabBar.tsx:43–47` renders the primary capture button as an SVG-only button without its available `tab.label`. `components/PhCategoryFields.tsx:112–265` places labels next to controls without wrapping them or connecting `htmlFor`/IDs; several inputs have no other accessible name. **Fix:** add the capture aria-label, stable IDs/label associations, and `aria-required` where appropriate; propagate IDs through custom selectors. **Regression:** accessibility-tree inspection announces the capture action and every RAM/SSD/HDD/Other field with the intended label. This complements FE-10, which concerns modal focus and combobox relationships.

- [x] **UI-03 · P2 — Scale the phone profit chart across negative values.** `components/PhSparkline.tsx:8–14` fixes zero at y=92 and scales only against a positive maximum; any negative profit plots below y=92, often far outside the 110-unit SVG. For profits [-100, 100], the negative point is y=176; for [-100, -50] it is y=8492. `pages/Dashboard.tsx:140–146` passes API profit unchanged, and `backend/src/routes/dashboard.ts:185–188,216–219` permits negative margins. A loss period can therefore disappear from a financial chart. **Fix:** use a domain including both the minimum, maximum and zero, derive the zero baseline, and handle constant/single-point series. **Regression:** positive, mixed, all-negative and zero-only series all remain inside the chart and show loss direction. The read-only component probe reproduces the current off-canvas coordinates.

- [x] **UI-04 · P3 — Persist changes to the phone Follow System preference.** `components/PhLanguageSheet.tsx:19–28,72–86` disables Done whenever followSystem is false and the language matches the current language, even if a previously enabled Follow System switch was just turned off. That change can never be saved. Additionally, only this sheet references `rs.langFollowSystem`; `lib/i18n.tsx:3152–3178` initializes from the user profile and never applies this flag on boot or system-language changes. **Fix:** track the initial preference when detecting dirty state, and implement a shared effective-language policy on boot/language changes; ensure desktop/manual choices update the same policy. **Regression:** enable, reopen, disable without changing language, save, reload, and verify the flag and effective language; then change the system language with following enabled. The component probe confirms the disabled-Done state; the repository-wide key search confirms the missing consumer.

- [x] **UI-05 · P3 — Translate the remaining PO timeline and client-rhythm copy.** `components/OrderActivityLog.tsx:126–192` hardcodes titles such as Order created, Submitted for review and Updated order details, plus Qty/Was qty, while adjacent events use `t()`. `components/RhythmStrip.tsx:29–57` hardcodes empty and accessible-description copy. Selecting Chinese leaves these workflow descriptions in English. **Fix:** use dictionary keys and localize lifecycle/field descriptions through the existing presentation helpers; avoid translating stored user-authored values. **Regression:** render every supported event kind and empty/populated rhythm strips under both languages and check visible and accessible descriptions.

- [x] **UI-06 · P3 — Cancel the serial scanner completion timer on unmount.** `components/SnScanner.tsx:154–159` schedules `onDoneRef.current([value])` after 650 ms without retaining/cancelling the timer or checking `aliveRef`. The rest of the scanner guards late network/decode results, but navigation/unmount during the success flash still invokes the old parent completion callback. `pages/SubmitForm.tsx:718–721` uses that callback to append a serial and close the scanner. **Fix:** own the completion timer in a ref, cancel it on cleanup, and check the current capture/session epoch before committing. **Regression:** decode, unmount before the flash ends, advance timers, and verify no parent callback; normal capture must still finish exactly once. The probe demonstrates the late callback, without claiming a reproduced cross-order write.

FE-10 also applies to the hand-built overlays in CloseSellOrderDialog, HandoffDialog, SerialCheckDialog, SellOrderPickerDialog and ImageLightbox; centralizing the modal focus boundary must include those callers.

## Coverage

All modules in the following manifest received a full source read. Icon SVG path data and skeleton markup were read as presentation code; no visual design certification is implied. Relevant helpers/callers were traced for the findings above. The frontend agent reviewed the main workflow modules; the primary reviewer completed the remaining pages/helpers and reconciled the full frontend/shared ledger.

- `apps/frontend/src/components/ArchiveConflictList.tsx`
- `apps/frontend/src/components/AttachmentChip.tsx`
- `apps/frontend/src/components/AttachmentDropzone.tsx`
- `apps/frontend/src/components/BrandConfirmDialog.tsx`
- `apps/frontend/src/components/CloseSellOrderDialog.tsx`
- `apps/frontend/src/components/CommissionPaymentFields.tsx`
- `apps/frontend/src/components/CostTape.tsx`
- `apps/frontend/src/components/ErrorBoundary.tsx`
- `apps/frontend/src/components/ErrorDialog.tsx`
- `apps/frontend/src/components/HandoffDialog.tsx`
- `apps/frontend/src/components/Icon.tsx`
- `apps/frontend/src/components/ImageLightbox.tsx`
- `apps/frontend/src/components/ItemTypePicker.tsx`
- `apps/frontend/src/components/LinePhotoStrip.tsx`
- `apps/frontend/src/components/LineSpecChips.tsx`
- `apps/frontend/src/components/ManagerTakeoverDialog.tsx`
- `apps/frontend/src/components/MarketAssist.tsx`
- `apps/frontend/src/components/OrderActivityLog.tsx`
- `apps/frontend/src/components/OrderCategoryChips.tsx`
- `apps/frontend/src/components/PartNumberField.tsx`
- `apps/frontend/src/components/PasswordMeter.tsx`
- `apps/frontend/src/components/PaymentMismatch.tsx`
- `apps/frontend/src/components/PhAboutSheet.tsx`
- `apps/frontend/src/components/PhCategoryFields.tsx`
- `apps/frontend/src/components/PhCommissionSheet.tsx`
- `apps/frontend/src/components/PhDraftPickerSheet.tsx`
- `apps/frontend/src/components/PhFold.tsx`
- `apps/frontend/src/components/PhHandoffSheet.tsx`
- `apps/frontend/src/components/PhHeader.tsx`
- `apps/frontend/src/components/PhLanguageSheet.tsx`
- `apps/frontend/src/components/PhPasswordSheet.tsx`
- `apps/frontend/src/components/PhScrollJump.tsx`
- `apps/frontend/src/components/PhSparkline.tsx`
- `apps/frontend/src/components/PhTabBar.tsx`
- `apps/frontend/src/components/RamPartCheck.tsx`
- `apps/frontend/src/components/RevertNoticeDialog.tsx`
- `apps/frontend/src/components/RhythmStrip.tsx`
- `apps/frontend/src/components/RolePreviewBanner.tsx`
- `apps/frontend/src/components/SellOrderHistory.tsx`
- `apps/frontend/src/components/SellOrderPickerDialog.tsx`
- `apps/frontend/src/components/SerialCheckDialog.tsx`
- `apps/frontend/src/components/SerialChipsField.tsx`
- `apps/frontend/src/components/SerialNumbers.tsx`
- `apps/frontend/src/components/Sidebar.tsx`
- `apps/frontend/src/components/Skeleton.tsx`
- `apps/frontend/src/components/SnScanner.tsx`
- `apps/frontend/src/components/SoldBadge.tsx`
- `apps/frontend/src/components/TweaksPanel.tsx`
