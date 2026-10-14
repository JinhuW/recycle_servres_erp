# Frontend and shared coverage ledger

Current tree inventory on 2026-10-13. Fingerprints identify the reviewed snapshot; they do not certify correctness. All production TS/TSX modules received a source or semantic-flow review. The primary reviewer completed the 48 component files listed in components-todo.md and the 103 previously screened pages/helpers/declarations. For the latter, an AST-assisted pass read executable logic plus render/event expressions, omitting static JSX, style literals and type-only declarations; original source and callers were inspected for findings. This is not a claim that every JSX line was manually read. The original focused audit traced major shells, editors, transport and workflow helpers. Shared modules received a full source read. English/Chinese dictionaries passed key/placeholder parity checks; their linguistic accuracy was not independently certified. No live browser/device/assistive-technology validation was performed. CSS/assets received pattern screening only.

Counts: 281 production TS/TSX files; {'focused source/flow audit': 104, 'component full source read': 48, 'executable and render-expression audit': 101, 'dictionary parity; provider/loader flow read': 2, 'declaration source read': 2, 'shared full source read': 24}; 65 source-adjacent test files inventoried (the full frontend run also includes 9 tests outside src).

| File | Lines | Review evidence | SHA-256 prefix |
| --- | ---: | --- | --- |
| `apps/frontend/src/App.tsx` | 81 |  focused source/flow audit  | `3401b57231aa` |
| `apps/frontend/src/DesktopApp.tsx` | 332 |  focused source/flow audit  | `e4d7784e59e8` |
| `apps/frontend/src/MobileApp.tsx` | 942 |  focused source/flow audit  | `df1c023e9ff1` |
| `apps/frontend/src/components/AddInventoryPicker.tsx` | 215 |  focused source/flow audit  | `76e14eb85682` |
| `apps/frontend/src/components/ArchiveConflictList.tsx` | 37 |  component full source read  | `996f3cb04d36` |
| `apps/frontend/src/components/AttachmentChip.tsx` | 76 |  component full source read  | `6aac4d2e206e` |
| `apps/frontend/src/components/AttachmentDropzone.tsx` | 75 |  component full source read  | `7483225ea7c2` |
| `apps/frontend/src/components/BrandConfirmDialog.tsx` | 130 |  component full source read  | `33a1a9457375` |
| `apps/frontend/src/components/CloseSellOrderDialog.tsx` | 253 |  component full source read  | `a15b8cbcdc96` |
| `apps/frontend/src/components/Combobox.tsx` | 222 |  focused source/flow audit  | `3510275a2a2d` |
| `apps/frontend/src/components/CommissionPaymentFields.tsx` | 111 |  component full source read  | `5e77a232b5fe` |
| `apps/frontend/src/components/CostTape.tsx` | 189 |  component full source read  | `a0dd61cd8e11` |
| `apps/frontend/src/components/ErrorBoundary.tsx` | 62 |  component full source read  | `f97710f94999` |
| `apps/frontend/src/components/ErrorDialog.tsx` | 126 |  component full source read  | `2c731e4f2ba7` |
| `apps/frontend/src/components/FxRatesPanel.tsx` | 297 |  focused source/flow audit  | `8d7da5a64c86` |
| `apps/frontend/src/components/HandoffDialog.tsx` | 258 |  component full source read  | `f875fbb0ae2b` |
| `apps/frontend/src/components/Icon.tsx` | 119 |  component full source read  | `7ed7525145dc` |
| `apps/frontend/src/components/ImageLightbox.tsx` | 69 |  component full source read  | `c456bb8284f6` |
| `apps/frontend/src/components/ItemTypePicker.tsx` | 203 |  component full source read  | `58d6aadada51` |
| `apps/frontend/src/components/LinePhotoStrip.tsx` | 109 |  component full source read  | `8cb661b2b9a9` |
| `apps/frontend/src/components/LineSpecChips.tsx` | 83 |  component full source read  | `6df0fabff3b0` |
| `apps/frontend/src/components/ManagerTakeoverDialog.tsx` | 104 |  component full source read  | `8ebff28acf3f` |
| `apps/frontend/src/components/MarketAssist.tsx` | 156 |  component full source read  | `de3415cb23f7` |
| `apps/frontend/src/components/Modal.tsx` | 73 |  focused source/flow audit  | `9e8ac0c9540f` |
| `apps/frontend/src/components/OrderActivityLog.tsx` | 332 |  component full source read  | `139740f9709c` |
| `apps/frontend/src/components/OrderCategoryChips.tsx` | 37 |  component full source read  | `6889a168647b` |
| `apps/frontend/src/components/PartNumberField.tsx` | 43 |  component full source read  | `a26caa3f2eb9` |
| `apps/frontend/src/components/PasswordMeter.tsx` | 68 |  component full source read  | `53bd402b582c` |
| `apps/frontend/src/components/PaymentFields.tsx` | 209 |  focused source/flow audit  | `e306537a57c4` |
| `apps/frontend/src/components/PaymentMismatch.tsx` | 100 |  component full source read  | `e56c00637da0` |
| `apps/frontend/src/components/PhAboutSheet.tsx` | 69 |  component full source read  | `c77d7977e8fc` |
| `apps/frontend/src/components/PhCategoryFields.tsx` | 266 |  component full source read  | `2db042e0fce7` |
| `apps/frontend/src/components/PhCommissionSheet.tsx` | 157 |  component full source read  | `543705980b6f` |
| `apps/frontend/src/components/PhDraftPickerSheet.tsx` | 90 |  component full source read  | `4c38034ce7f3` |
| `apps/frontend/src/components/PhFold.tsx` | 47 |  component full source read  | `f967b1aa37c7` |
| `apps/frontend/src/components/PhHandoffSheet.tsx` | 41 |  component full source read  | `d590347fabac` |
| `apps/frontend/src/components/PhHeader.tsx` | 23 |  component full source read  | `940dfd1cc7d9` |
| `apps/frontend/src/components/PhLanguageSheet.tsx` | 135 |  component full source read  | `ce8c90029ae3` |
| `apps/frontend/src/components/PhNotificationsSheet.tsx` | 123 |  focused source/flow audit  | `c1061bc48297` |
| `apps/frontend/src/components/PhPasswordSheet.tsx` | 241 |  component full source read  | `23703613778f` |
| `apps/frontend/src/components/PhScrollJump.tsx` | 35 |  component full source read  | `d177e5806406` |
| `apps/frontend/src/components/PhSheet.tsx` | 25 |  focused source/flow audit  | `805378a7d8f8` |
| `apps/frontend/src/components/PhSparkline.tsx` | 35 |  component full source read  | `528ae04aa80b` |
| `apps/frontend/src/components/PhTabBar.tsx` | 67 |  component full source read  | `08c6b01f35fa` |
| `apps/frontend/src/components/PwaInstallPrompt.tsx` | 245 |  focused source/flow audit  | `79d6124d336e` |
| `apps/frontend/src/components/PwaUpdateToast.tsx` | 94 |  focused source/flow audit  | `b70b7a063638` |
| `apps/frontend/src/components/RamPartCheck.tsx` | 317 |  component full source read  | `edff97b4458a` |
| `apps/frontend/src/components/RevertNoticeDialog.tsx` | 114 |  component full source read  | `aa95a5299d67` |
| `apps/frontend/src/components/RhythmStrip.tsx` | 61 |  component full source read  | `4838e0d24b06` |
| `apps/frontend/src/components/RolePreviewBanner.tsx` | 21 |  component full source read  | `091a9e905fad` |
| `apps/frontend/src/components/RouteLink.tsx` | 37 |  focused source/flow audit  | `b4b87c59423b` |
| `apps/frontend/src/components/SellOrderHistory.tsx` | 271 |  component full source read  | `3cc13a66f214` |
| `apps/frontend/src/components/SellOrderPickerDialog.tsx` | 120 |  component full source read  | `79f1ff96ac1e` |
| `apps/frontend/src/components/SerialCheckDialog.tsx` | 62 |  component full source read  | `1ad9dbe39644` |
| `apps/frontend/src/components/SerialChipsField.tsx` | 163 |  component full source read  | `9669d7700508` |
| `apps/frontend/src/components/SerialNumbers.tsx` | 35 |  component full source read  | `b8411fd3410f` |
| `apps/frontend/src/components/Sidebar.tsx` | 134 |  component full source read  | `3d032541ca0b` |
| `apps/frontend/src/components/Skeleton.tsx` | 222 |  component full source read  | `7da5b9ff906b` |
| `apps/frontend/src/components/SnScanner.tsx` | 327 |  component full source read  | `44b059d827ca` |
| `apps/frontend/src/components/SoldBadge.tsx` | 12 |  component full source read  | `cb0b21e0963d` |
| `apps/frontend/src/components/StatusChangeDialog.tsx` | 300 |  focused source/flow audit  | `999e5a1f2087` |
| `apps/frontend/src/components/Topbar.tsx` | 17 |  focused source/flow audit  | `81944ff1e4fa` |
| `apps/frontend/src/components/TweaksPanel.tsx` | 84 |  component full source read  | `d374cb5301e7` |
| `apps/frontend/src/lib/aiReview.ts` | 152 |  focused source/flow audit  | `db2673d62dad` |
| `apps/frontend/src/lib/api.ts` | 331 |  focused source/flow audit  | `255a2a40ccb3` |
| `apps/frontend/src/lib/archiveConflict.ts` | 42 |  executable and render-expression audit  | `dc4e07c723d2` |
| `apps/frontend/src/lib/auth.tsx` | 193 |  focused source/flow audit  | `4750817a06fd` |
| `apps/frontend/src/lib/beacon.ts` | 104 |  executable and render-expression audit  | `2605630ac492` |
| `apps/frontend/src/lib/boot.ts` | 27 |  focused source/flow audit  | `5ed44fbb554c` |
| `apps/frontend/src/lib/boxCheck.ts` | 258 |  executable and render-expression audit  | `624dc8e8f41b` |
| `apps/frontend/src/lib/buildVersion.ts` | 72 |  focused source/flow audit  | `d27523c9543d` |
| `apps/frontend/src/lib/carrierDetect.ts` | 10 |  executable and render-expression audit  | `202bdae3b86a` |
| `apps/frontend/src/lib/catalog.ts` | 24 |  executable and render-expression audit  | `9146c65f6ed0` |
| `apps/frontend/src/lib/chunkReload.ts` | 68 |  focused source/flow audit  | `1123f296936f` |
| `apps/frontend/src/lib/clients.ts` | 125 |  executable and render-expression audit  | `92af4d4e8102` |
| `apps/frontend/src/lib/closeReasons.ts` | 12 |  executable and render-expression audit  | `bb6814c08989` |
| `apps/frontend/src/lib/coordinator.ts` | 235 |  executable and render-expression audit  | `413029843640` |
| `apps/frontend/src/lib/deskScan.ts` | 224 |  executable and render-expression audit  | `0a7c659a557c` |
| `apps/frontend/src/lib/desktopNav.ts` | 116 |  focused source/flow audit  | `b2d6fca211c0` |
| `apps/frontend/src/lib/disputeLadder.ts` | 26 |  executable and render-expression audit  | `3ad890970c19` |
| `apps/frontend/src/lib/dupParts.ts` | 21 |  executable and render-expression audit  | `4241e8e79303` |
| `apps/frontend/src/lib/errorToast.ts` | 137 |  executable and render-expression audit  | `ce18b371d439` |
| `apps/frontend/src/lib/escapeStack.ts` | 48 |  executable and render-expression audit  | `e78aa1b4043e` |
| `apps/frontend/src/lib/fleetView.ts` | 214 |  executable and render-expression audit  | `cc9f5ecb16af` |
| `apps/frontend/src/lib/format.ts` | 85 |  focused source/flow audit  | `0fa223fffb7c` |
| `apps/frontend/src/lib/fxRate.ts` | 19 |  executable and render-expression audit  | `fe4619c5ddf7` |
| `apps/frontend/src/lib/handoff.ts` | 123 |  executable and render-expression audit  | `0f944a14f641` |
| `apps/frontend/src/lib/i18n.tsx` | 3204 |  dictionary parity; provider/loader flow read  | `3369c949223c` |
| `apps/frontend/src/lib/i18n.zh.ts` | 2833 |  dictionary parity; provider/loader flow read  | `e862beca98dd` |
| `apps/frontend/src/lib/image-compress.ts` | 71 |  executable and render-expression audit  | `6d413f26a01d` |
| `apps/frontend/src/lib/inventoryEditPatch.ts` | 54 |  focused source/flow audit  | `742d4081e864` |
| `apps/frontend/src/lib/inventorySelection.ts` | 40 |  focused source/flow audit  | `65a50fea72d2` |
| `apps/frontend/src/lib/keysetPages.ts` | 25 |  focused source/flow audit  | `51892e8a0f9f` |
| `apps/frontend/src/lib/leaveRegistry.ts` | 26 |  focused source/flow audit  | `69a9b5846187` |
| `apps/frontend/src/lib/lineCategorySwitch.ts` | 53 |  executable and render-expression audit  | `74e28553955c` |
| `apps/frontend/src/lib/lineGroups.ts` | 165 |  executable and render-expression audit  | `54f5b3a36b54` |
| `apps/frontend/src/lib/linePhotos.ts` | 296 |  focused source/flow audit  | `289bdaaf8334` |
| `apps/frontend/src/lib/lineRequirements.ts` | 95 |  focused source/flow audit  | `b8e851985a50` |
| `apps/frontend/src/lib/listMemory.ts` | 71 |  focused source/flow audit  | `556b1a2bbe19` |
| `apps/frontend/src/lib/lookups.ts` | 187 |  focused source/flow audit  | `992f45762c34` |
| `apps/frontend/src/lib/mailQuote.ts` | 73 |  executable and render-expression audit  | `2b3fc7103fa4` |
| `apps/frontend/src/lib/marketStaleness.ts` | 15 |  executable and render-expression audit  | `3b9d59658267` |
| `apps/frontend/src/lib/openSellOrders.ts` | 24 |  focused source/flow audit  | `669d88115cfe` |
| `apps/frontend/src/lib/orderLookback.ts` | 96 |  executable and render-expression audit  | `5bdcc75706c4` |
| `apps/frontend/src/lib/orderPresentation.ts` | 209 |  focused source/flow audit  | `11963f83cebc` |
| `apps/frontend/src/lib/orderSubmit.ts` | 97 |  focused source/flow audit  | `07b2e2996df6` |
| `apps/frontend/src/lib/packageSource.ts` | 12 |  executable and render-expression audit  | `b38eeb6a682a` |
| `apps/frontend/src/lib/packages.ts` | 106 |  executable and render-expression audit  | `a62e2146afd8` |
| `apps/frontend/src/lib/passwordI18n.ts` | 18 |  executable and render-expression audit  | `704c92c7c44d` |
| `apps/frontend/src/lib/passwordPolicy.ts` | 42 |  executable and render-expression audit  | `fe9e4a25efd0` |
| `apps/frontend/src/lib/paymentGap.ts` | 54 |  focused source/flow audit  | `77334f7663c3` |
| `apps/frontend/src/lib/paypalTxn.ts` | 30 |  executable and render-expression audit  | `a17f39ce3364` |
| `apps/frontend/src/lib/poPermissions.ts` | 88 |  focused source/flow audit  | `b0388da8579c` |
| `apps/frontend/src/lib/poReadiness.ts` | 119 |  executable and render-expression audit  | `9945d33e14d0` |
| `apps/frontend/src/lib/poTotals.ts` | 87 |  focused source/flow audit  | `47180d0c0033` |
| `apps/frontend/src/lib/preferences.tsx` | 200 |  focused source/flow audit  | `7da5d58f29ad` |
| `apps/frontend/src/lib/priceFilePrecheck.ts` | 139 |  executable and render-expression audit  | `a90cba7dedae` |
| `apps/frontend/src/lib/priceImport.ts` | 42 |  executable and render-expression audit  | `bb306223d204` |
| `apps/frontend/src/lib/productNo.ts` | 35 |  executable and render-expression audit  | `2aaf76b8518a` |
| `apps/frontend/src/lib/pwa.ts` | 72 |  focused source/flow audit  | `63c97c29a289` |
| `apps/frontend/src/lib/qr.ts` | 110 |  executable and render-expression audit  | `3f15980c6fca` |
| `apps/frontend/src/lib/ramPartQuestion.ts` | 113 |  executable and render-expression audit  | `2aa364d0b0c1` |
| `apps/frontend/src/lib/ramRequired.ts` | 48 |  focused source/flow audit  | `2312ae16d08d` |
| `apps/frontend/src/lib/route.ts` | 512 |  focused source/flow audit  | `01b05bad566e` |
| `apps/frontend/src/lib/scanError.ts` | 33 |  executable and render-expression audit  | `4fdc5f1fe725` |
| `apps/frontend/src/lib/scanValidation.ts` | 137 |  focused source/flow audit  | `dc19b7899b70` |
| `apps/frontend/src/lib/scannerBridge.ts` | 76 |  focused source/flow audit  | `2b5c5dc61354` |
| `apps/frontend/src/lib/sellOrderLineGroups.ts` | 59 |  focused source/flow audit  | `7391f9ee177d` |
| `apps/frontend/src/lib/sellOrderPack.ts` | 282 |  focused source/flow audit  | `5f8dc31827fd` |
| `apps/frontend/src/lib/sellOrderPrefill.ts` | 28 |  focused source/flow audit  | `039fd121ed46` |
| `apps/frontend/src/lib/sellOrderSignoff.ts` | 31 |  executable and render-expression audit  | `aed9ebdc3f8d` |
| `apps/frontend/src/lib/serialField.ts` | 67 |  executable and render-expression audit  | `5806addbd5a6` |
| `apps/frontend/src/lib/shareOrCopy.ts` | 31 |  focused source/flow audit  | `01d0da014def` |
| `apps/frontend/src/lib/sheetImage.ts` | 90 |  executable and render-expression audit  | `84879323911c` |
| `apps/frontend/src/lib/shellPaths.ts` | 36 |  focused source/flow audit  | `c57c53cda6f8` |
| `apps/frontend/src/lib/shippingInbound.ts` | 84 |  focused source/flow audit  | `d62d99a0ce23` |
| `apps/frontend/src/lib/shippingList.ts` | 92 |  executable and render-expression audit  | `ae3343619037` |
| `apps/frontend/src/lib/status.ts` | 81 |  executable and render-expression audit  | `7ae1d08d3b68` |
| `apps/frontend/src/lib/timing.ts` | 75 |  executable and render-expression audit  | `6f5cdab956b3` |
| `apps/frontend/src/lib/tracker.ts` | 85 |  executable and render-expression audit  | `23707b7575ea` |
| `apps/frontend/src/lib/tweaks.tsx` | 61 |  focused source/flow audit  | `d04089d0466a` |
| `apps/frontend/src/lib/types.ts` | 505 |  focused source/flow audit  | `801e7befbb08` |
| `apps/frontend/src/lib/unsavedGuard.tsx` | 89 |  focused source/flow audit  | `c47c7f5eb029` |
| `apps/frontend/src/lib/useAddPackageForm.ts` | 138 |  focused source/flow audit  | `f6a5c0d4566a` |
| `apps/frontend/src/lib/useAppVersion.ts` | 36 |  focused source/flow audit  | `01376f1559c9` |
| `apps/frontend/src/lib/useChipFill.ts` | 113 |  focused source/flow audit  | `8c5ef1fbeb63` |
| `apps/frontend/src/lib/useCommissionPaidBy.ts` | 62 |  focused source/flow audit  | `ef2e61257487` |
| `apps/frontend/src/lib/useDebouncedValue.ts` | 14 |  focused source/flow audit  | `f43e445fa806` |
| `apps/frontend/src/lib/useElementWidth.ts` | 20 |  focused source/flow audit  | `0c1f391b5fc1` |
| `apps/frontend/src/lib/useEscapeKey.ts` | 35 |  focused source/flow audit  | `054d930f4932` |
| `apps/frontend/src/lib/useHandoffForm.ts` | 138 |  focused source/flow audit  | `bb2e630f4892` |
| `apps/frontend/src/lib/useLineSaveQueue.ts` | 177 |  focused source/flow audit  | `896e5708123d` |
| `apps/frontend/src/lib/useMarketLookup.ts` | 163 |  focused source/flow audit  | `00e30abd8a5a` |
| `apps/frontend/src/lib/useOrderEvents.ts` | 32 |  focused source/flow audit  | `647c6c3616b9` |
| `apps/frontend/src/lib/usePartSuggest.ts` | 89 |  focused source/flow audit  | `f5aee6d33874` |
| `apps/frontend/src/lib/usePaymentProof.ts` | 154 |  focused source/flow audit  | `c3167bca7bfb` |
| `apps/frontend/src/lib/usePhScrolled.ts` | 19 |  executable and render-expression audit  | `490927980a0f` |
| `apps/frontend/src/lib/useScanFilter.ts` | 22 |  focused source/flow audit  | `3b9ef76a22cc` |
| `apps/frontend/src/lib/useScrollEdges.ts` | 47 |  focused source/flow audit  | `2bce0cf7ddf3` |
| `apps/frontend/src/lib/useSentinel.ts` | 28 |  focused source/flow audit  | `9ad7be9e98de` |
| `apps/frontend/src/lib/useTrackingInput.ts` | 47 |  focused source/flow audit  | `97f4e525aa46` |
| `apps/frontend/src/lib/viewport.ts` | 4 |  executable and render-expression audit  | `12cc9c7e3944` |
| `apps/frontend/src/lib/warehouses.ts` | 52 |  focused source/flow audit  | `87aec65c00d0` |
| `apps/frontend/src/lib/workerLiveness.ts` | 16 |  focused source/flow audit  | `99041a4e5298` |
| `apps/frontend/src/lib/workspace.ts` | 41 |  focused source/flow audit  | `8671b60efbbf` |
| `apps/frontend/src/main.tsx` | 38 |  focused source/flow audit  | `f4ef8734264a` |
| `apps/frontend/src/novnc.d.ts` | 17 |  declaration source read  | `b5d756a70906` |
| `apps/frontend/src/pages/Authorize.tsx` | 286 |  focused source/flow audit  | `b36f79857dc9` |
| `apps/frontend/src/pages/Camera.tsx` | 306 |  executable and render-expression audit  | `ca1ebd6b3af8` |
| `apps/frontend/src/pages/Dashboard.tsx` | 324 |  executable and render-expression audit  | `caf239b0ed9b` |
| `apps/frontend/src/pages/Inventory.tsx` | 170 |  executable and render-expression audit  | `17808d98161d` |
| `apps/frontend/src/pages/Login.tsx` | 398 |  focused source/flow audit  | `b708363195c9` |
| `apps/frontend/src/pages/Market.tsx` | 173 |  executable and render-expression audit  | `d378026e5f2a` |
| `apps/frontend/src/pages/OrderDetail.tsx` | 1880 |  focused source/flow audit  | `523e4093a1bb` |
| `apps/frontend/src/pages/OrderProductsBody.tsx` | 190 |  executable and render-expression audit  | `5ca9f23993fd` |
| `apps/frontend/src/pages/OrderReview.tsx` | 200 |  focused source/flow audit  | `4cefb325c2ef` |
| `apps/frontend/src/pages/Orders.tsx` | 276 |  focused source/flow audit  | `2d7984c8c8d7` |
| `apps/frontend/src/pages/Profile.tsx` | 156 |  focused source/flow audit  | `168d0c78504a` |
| `apps/frontend/src/pages/RolePicker.tsx` | 161 |  executable and render-expression audit  | `73d3dfb08b75` |
| `apps/frontend/src/pages/ShareTarget.tsx` | 44 |  focused source/flow audit  | `1f381b9d26ee` |
| `apps/frontend/src/pages/Shipping.tsx` | 590 |  executable and render-expression audit  | `e2493df65d42` |
| `apps/frontend/src/pages/SubmitForm.tsx` | 776 |  focused source/flow audit  | `2b74779a3a97` |
| `apps/frontend/src/pages/desktop/AiReviewCard.tsx` | 131 |  executable and render-expression audit  | `5f63eac82f09` |
| `apps/frontend/src/pages/desktop/DashboardChart.tsx` | 165 |  executable and render-expression audit  | `12a19e801300` |
| `apps/frontend/src/pages/desktop/DashboardContrib.tsx` | 98 |  executable and render-expression audit  | `fceda229c910` |
| `apps/frontend/src/pages/desktop/DashboardRange.tsx` | 347 |  executable and render-expression audit  | `a7858b3efcd2` |
| `apps/frontend/src/pages/desktop/DesktopActivity.tsx` | 486 |  executable and render-expression audit  | `854db227a9f9` |
| `apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx` | 326 |  executable and render-expression audit  | `b9c613e8146c` |
| `apps/frontend/src/pages/desktop/DesktopAnalysis.tsx` | 363 |  executable and render-expression audit  | `c70238c4c46c` |
| `apps/frontend/src/pages/desktop/DesktopBoxCheck.tsx` | 863 |  focused source/flow audit  | `c3dba4f164b1` |
| `apps/frontend/src/pages/desktop/DesktopClients.tsx` | 307 |  focused source/flow audit  | `2a29abbbb954` |
| `apps/frontend/src/pages/desktop/DesktopCoordinator.tsx` | 726 |  focused source/flow audit  | `0e5a454387da` |
| `apps/frontend/src/pages/desktop/DesktopDashboard.tsx` | 272 |  executable and render-expression audit  | `ba2c3f81152b` |
| `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` | 2198 |  focused source/flow audit  | `0fd352ffac05` |
| `apps/frontend/src/pages/desktop/DesktopInternalTxns.tsx` | 414 |  executable and render-expression audit  | `621199085bed` |
| `apps/frontend/src/pages/desktop/DesktopInventory.tsx` | 1386 |  focused source/flow audit  | `cd87e54c6fee` |
| `apps/frontend/src/pages/desktop/DesktopInventoryEdit.tsx` | 1236 |  focused source/flow audit  | `5cfea02dea6d` |
| `apps/frontend/src/pages/desktop/DesktopInventoryTransfer.tsx` | 328 |  focused source/flow audit  | `0516d36fb628` |
| `apps/frontend/src/pages/desktop/DesktopMarket.tsx` | 777 |  executable and render-expression audit  | `a7354c1cae7b` |
| `apps/frontend/src/pages/desktop/DesktopOrders.tsx` | 838 |  focused source/flow audit  | `20038bf38ffd` |
| `apps/frontend/src/pages/desktop/DesktopPayments.tsx` | 1776 |  focused source/flow audit  | `dec2e0406918` |
| `apps/frontend/src/pages/desktop/DesktopSellOrderDraft.tsx` | 659 |  focused source/flow audit  | `19aee53fe680` |
| `apps/frontend/src/pages/desktop/DesktopSellOrderPack.tsx` | 1143 |  executable and render-expression audit  | `758507e13bfa` |
| `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` | 2242 |  focused source/flow audit  | `1e9f9061da17` |
| `apps/frontend/src/pages/desktop/DesktopSettings.tsx` | 99 |  executable and render-expression audit  | `10f2f55cff32` |
| `apps/frontend/src/pages/desktop/DesktopSettingsConnectors.tsx` | 598 |  executable and render-expression audit  | `2c085a6d8cdd` |
| `apps/frontend/src/pages/desktop/DesktopShipping.tsx` | 417 |  executable and render-expression audit  | `d47600321bd5` |
| `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` | 1430 |  focused source/flow audit  | `ac5e54f57f64` |
| `apps/frontend/src/pages/desktop/DesktopTracker.tsx` | 576 |  focused source/flow audit  | `077f9e1b7268` |
| `apps/frontend/src/pages/desktop/DesktopTransfers.tsx` | 280 |  focused source/flow audit  | `f66f3bf26311` |
| `apps/frontend/src/pages/desktop/DesktopWebSubmissionThread.tsx` | 323 |  executable and render-expression audit  | `868071807ef3` |
| `apps/frontend/src/pages/desktop/DesktopWebSubmissions.tsx` | 476 |  focused source/flow audit  | `81892d86f357` |
| `apps/frontend/src/pages/desktop/FleetAccounts.tsx` | 885 |  executable and render-expression audit  | `73520dd62ff7` |
| `apps/frontend/src/pages/desktop/FleetWatch.tsx` | 202 |  executable and render-expression audit  | `873524e972e0` |
| `apps/frontend/src/pages/desktop/InventoryProductTable.tsx` | 414 |  executable and render-expression audit  | `4a73d4a3fc6f` |
| `apps/frontend/src/pages/desktop/MarketPriceImportDialog.tsx` | 208 |  executable and render-expression audit  | `87718c7be5a6` |
| `apps/frontend/src/pages/desktop/PackageJourney.tsx` | 72 |  executable and render-expression audit  | `0fd71e9eeaf8` |
| `apps/frontend/src/pages/desktop/PaymentIgnoreRules.tsx` | 221 |  executable and render-expression audit  | `b3e321fd8846` |
| `apps/frontend/src/pages/desktop/ReviewModeEntry.tsx` | 123 |  executable and render-expression audit  | `aba42e3da723` |
| `apps/frontend/src/pages/desktop/SellOrderPriceImportDialog.tsx` | 308 |  executable and render-expression audit  | `e0c9a8285612` |
| `apps/frontend/src/pages/desktop/SellOrderSignoff.tsx` | 103 |  executable and render-expression audit  | `bee02ec028c6` |
| `apps/frontend/src/pages/desktop/ShippingAddLabel.tsx` | 160 |  executable and render-expression audit  | `7702d619f542` |
| `apps/frontend/src/pages/desktop/StepTimeline.tsx` | 40 |  executable and render-expression audit  | `281f495c3795` |
| `apps/frontend/src/pages/desktop/TransferManifest.tsx` | 73 |  executable and render-expression audit  | `c760f523f513` |
| `apps/frontend/src/pages/desktop/clients/AddClientModal.tsx` | 67 |  executable and render-expression audit  | `5368179da36c` |
| `apps/frontend/src/pages/desktop/clients/ClientDrawer.tsx` | 225 |  focused source/flow audit  | `beb6bd456261` |
| `apps/frontend/src/pages/desktop/clients/EditClient.tsx` | 129 |  executable and render-expression audit  | `49355ddb9292` |
| `apps/frontend/src/pages/desktop/clients/LogContact.tsx` | 119 |  executable and render-expression audit  | `cfffe4e88b87` |
| `apps/frontend/src/pages/desktop/order/CommissionTab.tsx` | 200 |  focused source/flow audit  | `14966495c5ac` |
| `apps/frontend/src/pages/desktop/order/DeliveryTab.tsx` | 182 |  executable and render-expression audit  | `67866314ed30` |
| `apps/frontend/src/pages/desktop/order/OrderFooter.tsx` | 78 |  executable and render-expression audit  | `dd17c4f7b439` |
| `apps/frontend/src/pages/desktop/order/OrderTabs.tsx` | 72 |  focused source/flow audit  | `636d9cbfc235` |
| `apps/frontend/src/pages/desktop/order/PoPaymentsLedger.tsx` | 90 |  focused source/flow audit  | `09df35d355e4` |
| `apps/frontend/src/pages/desktop/order/StageLookback.tsx` | 85 |  executable and render-expression audit  | `dc9c2227c865` |
| `apps/frontend/src/pages/desktop/order/StagePanel.tsx` | 197 |  focused source/flow audit  | `8d9974e9bde9` |
| `apps/frontend/src/pages/desktop/popoverPlacement.ts` | 134 |  executable and render-expression audit  | `085087b7dfdb` |
| `apps/frontend/src/pages/desktop/settings/AccountPanel.tsx` | 302 |  focused source/flow audit  | `6e09c6ad4c76` |
| `apps/frontend/src/pages/desktop/settings/CategoriesPanel.tsx` | 222 |  executable and render-expression audit  | `49d4fb95127b` |
| `apps/frontend/src/pages/desktop/settings/CustomersPanel.tsx` | 327 |  executable and render-expression audit  | `1d4843df29ea` |
| `apps/frontend/src/pages/desktop/settings/GeneralPanel.tsx` | 304 |  executable and render-expression audit  | `905941b41a5a` |
| `apps/frontend/src/pages/desktop/settings/MembersPanel.tsx` | 648 |  executable and render-expression audit  | `7bff129865fc` |
| `apps/frontend/src/pages/desktop/settings/WarehousesPanel.tsx` | 498 |  executable and render-expression audit  | `01a16199794a` |
| `apps/frontend/src/pages/desktop/settings/_shared.tsx` | 97 |  executable and render-expression audit  | `5ab8607e7f44` |
| `apps/frontend/src/pages/desktop/settings/dialogs.tsx` | 51 |  executable and render-expression audit  | `9a778855a395` |
| `apps/frontend/src/pages/desktop/submit/AddLineMenu.tsx` | 39 |  executable and render-expression audit  | `f53a9e6036d7` |
| `apps/frontend/src/pages/desktop/submit/DeskCamera.tsx` | 325 |  executable and render-expression audit  | `914cb2b50541` |
| `apps/frontend/src/pages/desktop/submit/DupPartDialog.tsx` | 64 |  executable and render-expression audit  | `f14b99ebbc11` |
| `apps/frontend/src/pages/desktop/submit/LineDrawer.tsx` | 817 |  focused source/flow audit  | `84abe1ebcf29` |
| `apps/frontend/src/pages/desktop/submit/LineFields.tsx` | 260 |  executable and render-expression audit  | `76cdb665fc82` |
| `apps/frontend/src/pages/desktop/submit/ProductNo.tsx` | 14 |  executable and render-expression audit  | `b0868a8e3e9a` |
| `apps/frontend/src/pages/desktop/submit/RamSheetScanDialog.tsx` | 765 |  executable and render-expression audit  | `b95f05037992` |
| `apps/frontend/src/pages/desktop/submit/editLine.ts` | 86 |  executable and render-expression audit  | `a5c6e29963da` |
| `apps/frontend/src/pages/desktop/submit/eligibleTargets.ts` | 22 |  executable and render-expression audit  | `700330018c6c` |
| `apps/frontend/src/pages/desktop/submit/line.ts` | 202 |  executable and render-expression audit  | `e36213885c81` |
| `apps/frontend/src/pages/desktop/submit/ramSheet.ts` | 150 |  executable and render-expression audit  | `ed1ba91e6d46` |
| `apps/frontend/src/sw.ts` | 76 |  focused source/flow audit  | `ecb49d158933` |
| `apps/frontend/src/vite-env.d.ts` | 6 |  declaration source read  | `27e6ffb4b414` |
| `packages/shared/src/activity.ts` | 88 |  shared full source read  | `d643d19eec5d` |
| `packages/shared/src/carriers.ts` | 61 |  shared full source read  | `a93f38785177` |
| `packages/shared/src/categoryOrder.ts` | 27 |  shared full source read  | `32c826894d66` |
| `packages/shared/src/chipNumber.ts` | 24 |  shared full source read  | `353f359cd612` |
| `packages/shared/src/closeReasons.ts` | 11 |  shared full source read  | `4820ac570690` |
| `packages/shared/src/goodsTotal.ts` | 37 |  shared full source read  | `45fc72e0df13` |
| `packages/shared/src/index.ts` | 24 |  shared full source read  | `9d7729c5e44b` |
| `packages/shared/src/itemTypes.ts` | 10 |  shared full source read  | `eeb0ba011a04` |
| `packages/shared/src/linePhotoUrl.ts` | 25 |  shared full source read  | `52b71c4d4c52` |
| `packages/shared/src/lineSpecFields.ts` | 63 |  shared full source read  | `dff994ed36b9` |
| `packages/shared/src/marketStaleness.ts` | 8 |  shared full source read  | `96607ecdf068` |
| `packages/shared/src/materialEdit.ts` | 27 |  shared full source read  | `f3f6450355c1` |
| `packages/shared/src/packageSource.ts` | 9 |  shared full source read  | `93cf337032d4` |
| `packages/shared/src/partNumberCanon.ts` | 87 |  shared full source read  | `53397f242a21` |
| `packages/shared/src/partNumberSynth.ts` | 60 |  shared full source read  | `ceeab0c22083` |
| `packages/shared/src/passwordPolicy.ts` | 6 |  shared full source read  | `845ff34ab38a` |
| `packages/shared/src/paymentNote.ts` | 5 |  shared full source read  | `e946336f17d8` |
| `packages/shared/src/ramFamily.ts` | 74 |  shared full source read  | `5d88d0ec6371` |
| `packages/shared/src/ramPartDecode.ts` | 681 |  shared full source read  | `7dbd8c9bdafa` |
| `packages/shared/src/ramSheetSegment.ts` | 447 |  shared full source read  | `28123f85c5c6` |
| `packages/shared/src/reporting.ts` | 122 |  shared full source read  | `cff54421c59f` |
| `packages/shared/src/sellPrice.ts` | 25 |  shared full source read  | `8fc971b5a468` |
| `packages/shared/src/serials.ts` | 50 |  shared full source read  | `21ef96a86f23` |
| `packages/shared/src/specCascade.ts` | 283 |  shared full source read  | `c4d71280fd0f` |
