import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { useEffectiveUser } from '../../lib/tweaks';
import { api, deleteOrder, archiveOrder, unarchiveOrder } from '../../lib/api';
import { readArchiveConflict, type ArchiveConflict } from '../../lib/archiveConflict';
import { ArchiveConflictList } from '../../components/ArchiveConflictList';
import { handleFetchError, showErrorDialog } from '../../lib/errorToast';
import { fmtUSD, fmtDateShort } from '../../lib/format';
import {
  ORDER_STATUSES, LIFECYCLE_STATUS, isClosedBook, spineStatus, warehouseGateLockedStatuses,
} from '../../lib/status';
import { poEffectiveCost, parseFeeInput, feeEq, readStoredGoodsTotal } from '../../lib/poTotals';
import type { Category, Order, OrderLine, Warehouse } from '../../lib/types';
import {
  LineDrawer, blankLine, findDuplicatePartNumbers, brandConfirmPending,
  type Line, type DuplicatePartGroup,
} from './DesktopSubmit';
import { AddLineMenu } from './submit/AddLineMenu';
import { OrderCategoryChips } from '../../components/OrderCategoryChips';
import {
  linePhotos, deleteLinePhoto, uploadedPhotoCount, useLinePhotoBuffer,
  type LinePhoto, type PendingPhoto,
} from '../../lib/linePhotos';
import { groupLines, shouldGroup, displayRows, catTone, pricedTotals } from '../../lib/lineGroups';
import { CostTape } from '../../components/CostTape';
import { useMarketLookup } from '../../lib/useMarketLookup';
import { ImageLightbox } from '../../components/ImageLightbox';
import { serialIssue, isPricedSellPrice } from '@recycle-erp/shared';
import { lineRequirements, missingFieldNames } from '../../lib/lineRequirements';
import { SerialCheckDialog, type SerialLineIssue } from '../../components/SerialCheckDialog';
import { OrderActivityLog } from '../../components/OrderActivityLog';
import { RevertNoticeDialog } from '../../components/RevertNoticeDialog';
import { HandoffDialog } from '../../components/HandoffDialog';
import { PaymentFields } from '../../components/PaymentFields';
import type { HandoffDelivery, HandoffMethod } from '../../lib/handoff';
import { usePaymentProof } from '../../lib/usePaymentProof';
import { useCommissionPayment } from '../../lib/useCommissionPayment';
import { navigate, readHashQuery, replaceHashQuery } from '../../lib/route';
import { poReadiness, type ReadinessTab } from '../../lib/poReadiness';
import { useOrderEvents } from '../../lib/useOrderEvents';
import type { StageId } from '../../lib/orderLookback';
import { useTrackingInput } from '../../lib/useTrackingInput';
import { packageSourceLabelKey, type PackageSource } from '../../lib/packageSource';
import { refreshPackage } from '../../lib/packages';
import { ApiError } from '../../lib/api';
import { OrderTabs, type TabId } from './order/OrderTabs';
import { DeliveryTab } from './order/DeliveryTab';
import { CommissionTab } from './order/CommissionTab';
import { StagePanel, type RefreshState } from './order/StagePanel';
import { StageLookback } from './order/StageLookback';
import { OrderFooter } from './order/OrderFooter';
import { PoPaymentsLedger } from './order/PoPaymentsLedger';
import { StatusChangeDialog, type StatusAttachment } from '../../components/StatusChangeDialog';
import { AttachmentChip } from '../../components/AttachmentChip';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';
import { loadWarehouses } from '../../lib/warehouses';



// `order.status` is derived from the SET of line statuses and collapses to
// 'Mixed' when a (still-open) order's lines disagree — e.g. a draft whose
// lines were autosaved as 'In Transit'. Gating edit-access on that ambiguous
// string locked purchasers out of their own draft. `lifecycle` is the
// authoritative stage (see orders.ts), so derive the canonical status from it
// (LIFECYCLE_STATUS) and only fall back to the derived string for unknown
// lifecycles.

// The uppercase heading over each block of the action card.
const SectionHead = ({ icon, children }: { icon: IconName; children: ReactNode }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    marginBottom: 10,
  }}>
    <Icon name={icon} size={12} /> {children}
  </div>
);

// The tab whose facts a stage is about. Draft keeps Delivery (its readiness
// rows already jump wherever they need to); Reviewing and Done suggest nothing.
const STAGE_TAB: Partial<Record<string, TabId>> = {
  'In Transit': 'delivery',
  'Ready to Pay': 'commission',
};

type Props = {
  order: Order;
  onCancel: () => void;
  onSaved: (msg: string) => void;
  /** Re-reads the order and remounts the page on it — after a stage move,
   *  so the user lands on the new stage's panel instead of back on the list.
   *  Optional so an older shell that still navigates away keeps working. */
  onReload?: () => Promise<void>;
};

// Internal line state — the shared `Line` plus the original DB id (when the
// line came from the server), the line's persisted status, and a dirty
// marker so we can scope the PATCH.
type EditLine = Line & { _id?: string; _status?: string; _dirty?: boolean };

// Edit-order page lifted from design/dashboard.jsx#EditOrderPage. Table is
// read-only summary rows; clicking a row opens the right-side LineDrawer
// (same component the new-order flow uses), passed `editing={true}` so the
// drawer adds sell-price + revenue/profit/margin. Meta row + status stepper
// + Cancel/Save sit in a sticky bottom card.
//
// Purchasers stay in control through Draft and In Transit, then hand the
// order off to the manager at Reviewing (where pricing happens). Managers may
// move it through any stage and edit prices/qty. Once an order reaches "Done"
// the whole page becomes read-only.
export function DesktopEditOrder({ order, onCancel, onSaved, onReload }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const { user } = useAuth();
  const isPurchaser = user?.role !== 'manager';
  // The final-sell column follows the role-preview tweak (the API nulls the
  // figure under it); edit rights above stay on the real role.
  const isManager = useEffectiveUser()?.role === 'manager';
  // Edit-gating keys off the authoritative lifecycle, not the 'Mixed'-prone
  // derived status, so an owner is never locked out of their own draft.
  const effectiveStatus = LIFECYCLE_STATUS[order.lifecycle] ?? order.status;
  // Locked from Ready to Pay on: the review is over and the figure is what
  // the purchaser gets paid on. Managers keep the stage moves (below).
  // An archived order is locked too: its lines are out of stock, and every
  // write the backend would take is refused until it is unarchived.
  const isArchived = !!order.archivedAt;
  const orderLocked = isClosedBook(effectiveStatus) || isArchived;
  // The purchaser keeps their order until the review closes it. Editing it
  // after submission is allowed and costs them the stage: the backend sends it
  // back to Draft, so `revertOnSave` warns before the first such save.
  const purchaserCanEdit = !isPurchaser || !orderLocked;
  const canEditOrder = purchaserCanEdit && !orderLocked;
  const revertOnSave = isPurchaser && !orderLocked && effectiveStatus !== 'Draft';
  // Notes and submission evidence outlive the purchaser's edit window: the
  // manager owns pricing from Reviewing on, but whoever raised the PO can keep
  // documenting it until the book closes. Mirrors the backend's notes-only
  // gate.
  const isOwnerOrManager = !isPurchaser || order.userId === user?.id;
  const canAnnotate = !orderLocked && isOwnerOrManager;
  // A closed order keeps its stage moves for managers: Done can go back to
  // Ready to Pay or Reviewing, Ready to Pay forward to Done or back to
  // Reviewing (the backend guards lines committed to sell orders).
  // Everything else stays read-only until such a move lands.
  const canReopen = !isPurchaser && orderLocked && !isArchived;
  // Sold is never a right-hand value: the backend alone writes it.
  const REOPEN_TARGETS: Record<string, string[]> = {
    'Done': ['Reviewing', 'Ready to Pay'],
    'Sold': ['Reviewing', 'Ready to Pay'],
    'Ready to Pay': ['Reviewing', 'Done'],
  };
  const [status, setStatus] = useState(effectiveStatus);
  // The stage as last written. Normally the one the page opened with, but a
  // save that has to keep the user here (a photo upload that failed) has
  // already advanced the order — re-sending it would step it on again.
  const [savedStatus, setSavedStatus] = useState(effectiveStatus);
  // Declared up here because the stepper gate below reads the selected
  // warehouse; the field itself renders with the rest of the order details.
  const [warehouseId, setWarehouseId] = useState<string>(order.warehouse?.id ?? '');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  // Submitting is the one stage move a purchaser makes. Everything after it is
  // the manager's, and a purchaser edit moves the stage on its own — so past
  // Draft the stepper offers nothing to pick.
  //
  // Keyed off `savedStatus`, not the `order` prop: an edit that sent the order
  // back to Draft has already moved the stage, and the prop does not refetch
  // while this page is open. Reading the prop leaves the purchaser told to
  // "submit it again" with only the stage they just left on offer.
  //
  // A manager who is not the warehouse's manager is held off Reviewing and
  // Ready to Pay (and any jump past them). The gate follows the warehouse
  // *selected* in the form — Save writes it before it advances — so picking
  // another warehouse can lock or unlock the steps on the spot.
  const gateWarehouse = warehouses.find(w => w.id === warehouseId);
  const gateLocked = useMemo(
    () => (isPurchaser ? [] : warehouseGateLockedStatuses(savedStatus, gateWarehouse, user?.id)),
    [isPurchaser, savedStatus, gateWarehouse, user?.id],
  );
  const allowedStatuses = isPurchaser
    ? savedStatus === 'Draft' ? ['Draft', 'In Transit'] : [savedStatus]
    : ORDER_STATUSES.filter(s => !gateLocked.includes(s));
  useEffect(() => {
    if (gateLocked.includes(status as typeof gateLocked[number])) setStatus(savedStatus);
  }, [gateLocked, status, savedStatus]);
  // Optional Done evidence (note + attachments). The dialog live-saves to the
  // backend; these mirror its latest confirmed state for the read-only block.
  const [doneDialogOpen, setDoneDialogOpen] = useState(false);
  // The Draft → In Transit hand-off: opened from the stepper, it saves its own
  // fields and advances in one call, so it wants a clean page underneath.
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [doneNote, setDoneNote] = useState(order.statusMeta?.['Done']?.note ?? '');
  const [doneAttachments, setDoneAttachments] = useState<StatusAttachment[]>(
    order.statusMeta?.['Done']?.attachments ?? [],
  );
  // Owner may edit until the order is Done; managers always. Mirrors the
  // backend gate.
  const canEditSubmission = canAnnotate;
  // Kept in the server's canon (uppercase, no spaces) so dirty-compare is
  // exact against what a save round-trips.
  const [paypalTxn, setPaypalTxn] = useState<string>(order.paypalTxnId ?? '');
  // The payment proof — chat (Submission) and cash screenshot (Payment)
  // attachments plus the PayPal scan — shared with the hand-off dialog.
  const proof = usePaymentProof({
    orderId: order.id,
    chatAtts: order.statusMeta?.['Submission']?.attachments ?? [],
    proofAtts: order.statusMeta?.['Payment']?.attachments ?? [],
    setTxnId: setPaypalTxn,
  });
  const submissionAtts = proof.chatAtts;
  // How the purchaser was paid their commission. Live-saved — it is recorded
  // once the PO is a closed book, where Save is off — so it is not in the
  // page's draft or its dirty count.
  const commissionPayment = useCommissionPayment({
    orderId: order.id,
    method: order.commissionMethod ?? null,
    txnId: order.commissionTxnId ?? '',
    atts: order.statusMeta?.['Commission']?.attachments ?? [],
    onMutated: () => setActivityKey(k => k + 1),
  });

  // Done evidence stays editable after the transition — the dialog only opens
  // on the way into Done, so without this a wrong photo was stuck forever.
  // Manager-only, mirroring the backend canWriteMeta gate.
  const removeDoneAtt = async (att: StatusAttachment) => {
    try {
      await api.delete<{ ok: true }>(`/api/orders/${order.id}/status-meta/Done/attachments/${att.id}`);
      setDoneAttachments(prev => prev.filter(a => a.id !== att.id));
      setActivityKey(k => k + 1);
    } catch (e) {
      handleFetchError(e);
    }
  };
  const [activityKey, setActivityKey] = useState(0);
  const [lines, setLines] = useState<EditLine[]>(() => order.lines.map(orderLineToEditLine));
  // Files picked for a line that has no DB id to hang them off yet — one added
  // in this session and not yet confirmed. Keyed by _cid, the only handle such
  // a line has, and flushed once the id lands.
  const photos = useLinePhotoBuffer((cid, saved) =>
    setLines(ls => ls.map(l =>
      (l._cid === cid ? { ...l, photos: [...(l.photos ?? []), ...saved] } : l))));

  // Upload what was buffered for a line, now that it has an id. Returns how
  // many are still queued because their upload failed: those keep their File
  // and their preview, since it is the only copy of that picture there is.
  const flushPendingPhotos = async (
    cid: string, lineId: string, items?: PendingPhoto[],
  ): Promise<number> => (await photos.flush(cid, order.id, lineId, items)).failed.length;

  // A line that came from the server has somewhere to put a photo right away;
  // one added in this session doesn't until Confirm line or Save gives it an id.
  const addLinePhotos = (idx: number, files: FileList | null) => {
    const l = lines[idx];
    if (!l) return;
    const added = photos.add(l._cid, uploadedPhotoCount(l.photos), files);
    if (!added.length || !l._id) return;
    void flushPendingPhotos(l._cid, l._id, added)
      .then(failed => { if (failed) showErrorDialog(t('linePhotoUploadFailed')); });
  };

  // Photos held against a line that already has somewhere to put them: an
  // upload that failed, nothing else. What the Retry action offers.
  const retryablePhotos = lines.reduce(
    (n, l) => n + (l._id ? photos.queuedFor(l._cid).length : 0), 0);

  // Set when a save wrote the order but left photos behind: the page has to
  // stay put, so it also owes the user the exit once they are uploaded.
  const [heldAfterSave, setHeldAfterSave] = useState(false);

  const retryQueuedPhotos = async () => {
    const flushed = await Promise.all(lines
      .filter(l => l._id && photos.queuedFor(l._cid).length)
      .map(l => flushPendingPhotos(l._cid, l._id!)));
    if (flushed.reduce((a, b) => a + b, 0) > 0) {
      showErrorDialog(t('linePhotoUploadFailed'));
      return;
    }
    if (heldAfterSave) onSaved('Saved ' + order.id);
  };

  const removeLinePhoto = async (idx: number, photo: LinePhoto) => {
    const l = lines[idx];
    if (!l?._id) return;
    try {
      await deleteLinePhoto(order.id, l._id, photo.id);
      setLines(ls => ls.map((x, j) =>
        (j === idx ? { ...x, photos: (x.photos ?? []).filter(p => p.id !== photo.id) } : x)));
    } catch { showErrorDialog(t('linePhotoDeleteFailed')); }
  };
  // Line ids that exist in the DB. Seeded from the server's set and grown by
  // the drawer's Confirm-line write-through — `order.lines` is a snapshot from
  // page load and never learns about those, so a line added+confirmed and then
  // removed would otherwise be missed by save()'s removeLineIds diff.
  const [persistedIds, setPersistedIds] = useState<string[]>(() => order.lines.map(l => l.id));
  const [notes, setNotes] = useState<string>(order.notes ?? '');
  const [payment, setPayment] = useState<'company' | 'self'>(order.payment);
  const [paymentMethod, setPaymentMethod] = useState<HandoffMethod | null>(order.paymentMethod ?? null);
  // The hand-off's facts, now the Delivery tab's to edit: where the goods came
  // from, how they travel, who collected them, which box carries them. The
  // box is read from the order's newest package and kept locally so a Refresh
  // can replace it without a refetch.
  const [source, setSource] = useState<PackageSource | null>(order.source ?? null);
  const [delivery, setDelivery] = useState<HandoffDelivery | null>(order.handoffMethod ?? null);
  const [byUserId, setByUserId] = useState<string>(order.handoffBy?.id ?? '');
  const tracking = useTrackingInput(
    order.handoffMethod === 'label' ? order.package?.trackingNumber ?? '' : '',
    order.handoffMethod === 'label' ? order.package?.carrier ?? null : null,
  );
  const [pkg, setPkg] = useState(order.package ?? null);
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');
  const refreshPkg = async () => {
    if (!pkg) return;
    setRefreshState('busy');
    try {
      const r = await refreshPackage(pkg.id);
      setPkg({ ...pkg, ...r.package, trackingStatus: r.package.trackingStatus ?? pkg.trackingStatus });
      setRefreshState('idle');
    } catch (e) {
      // 501 is "tracking is not switched on" and reaches the page verbatim;
      // anything else is the provider's or the network's fault, said briefly.
      setRefreshState({ error: e instanceof ApiError && e.status === 501 ? e.message : t('poPkgRefreshFailed') });
    }
  };
  // Every role may pick a collector: the names list is what the hand-off
  // uses, and it is not the manager-only member list below.
  const [memberNames, setMemberNames] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let alive = true;
    api.get<{ items: { id: string; name: string }[] }>('/api/members/names')
      .then(r => { if (alive) setMemberNames(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);
  // Which stage the status section is showing. Null follows the order; a
  // reached step sets it to look back at what that stage recorded. Any
  // stage change snaps it back — a staged or committed move is the news.
  const [view, setView] = useState<string | null>(null);
  // The open tab, kept in the route's query so a readiness row, a reload and
  // a copied link all land on the same section. A copied link wins; otherwise
  // the stage suggests the tab its facts live under — the box while In
  // Transit, the commission once it is owed — and the user may pick another.
  const [tab, setTabState] = useState<TabId>(() => {
    const q = readHashQuery().get('tab');
    return (['delivery', 'payment', 'commission', 'notes', 'activity'] as TabId[]).includes(q as TabId)
      ? (q as TabId) : STAGE_TAB[status] ?? 'delivery';
  });
  const setTab = (next: TabId) => {
    setTabState(next);
    const q = readHashQuery();
    if (next === 'delivery') q.delete('tab'); else q.set('tab', next);
    replaceHashQuery(q);
  };
  const events = useOrderEvents(order.id, activityKey);
  // A stage change — staged from the panel or the stepper, or an Undo — snaps
  // the look-back shut and re-suggests the tab. Judged against the stage the
  // page last saw, not "first run": the deep link above has had its say, and
  // React's dev double-mount must not read as a change.
  const seenStatus = useRef(status);
  useEffect(() => {
    setView(null);
    if (seenStatus.current === status) return;
    seenStatus.current = status;
    const suggested = STAGE_TAB[status];
    if (suggested) setTab(suggested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  // Default to 0% when no rate has been set on the order yet, so the field
  // and the side commission summary show a concrete value out of the gate
  // instead of a blank input. Saving 0 against a still-null DB rate is
  // suppressed below by treating null and 0 as equivalent.
  const [commissionPct, setCommissionPct] = useState<string>(
    order.commissionRate != null ? String(+(order.commissionRate * 100).toFixed(2)) : '0');
  // Fees are charged on top of the goods total, so they get their own input
  // rather than being folded into the override. '' renders as no fee.
  const [otherFeesInput, setOtherFeesInput] = useState<string>(
    order.otherFees > 0 ? order.otherFees.toFixed(2) : '',
  );
  const [otherFeesNote, setOtherFeesNote] = useState<string>(order.otherFeesNote ?? '');
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [typedId, setTypedId] = useState('');
  const [deleting, setDeleting] = useState(false);
  // A reverted order is a Draft again, but it is not a fresh one: once it has
  // been submitted the record stays, and archive is the way to hide it.
  const canDelete = canEditOrder && effectiveStatus === 'Draft' && !order.everSubmitted;

  // Archive: owner-or-manager, any non-Draft stage. Either flips to the other.
  // (Draft uses Delete instead; the backend enforces the same split.)
  // Mirrors the backend: a reverted order is a Draft that HAS been submitted,
  // and Delete refuses exactly those — so Archive has to take it, or the order
  // offers neither. Unarchiving is always available once archived.
  const canArchive = isOwnerOrManager
    && (!!order.archivedAt || effectiveStatus !== 'Draft' || !!order.everSubmitted);
  const [showArchive, setShowArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // The archive endpoint's answer when stock sits on open sell orders: the
  // modal turns into that question until the user confirms or cancels.
  const [archiveConflict, setArchiveConflict] = useState<ArchiveConflict | null>(null);
  // Filled when save() detects duplicate part numbers; the modal then drives a
  // "Save anyway" path that bypasses the check.
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);
  // Serial-rule violations (DDR5 requires serials; serial count must equal
  // qty) caught at save time — shown as a blocking dialog, nothing persists.
  const [serialIssues, setSerialIssues] = useState<SerialLineIssue[] | null>(null);
  // Holds the answer callback while the "this returns the order to Draft"
  // warning is up; acknowledging once covers the rest of the visit.
  const [revertConfirm, setRevertConfirm] = useState<((ok: boolean) => void) | null>(null);
  const [revertAcked, setRevertAcked] = useState(false);
  // The purchaser's unreviewed changes, shown to a manager opening the order.
  const [pendingRevert, setPendingRevert] = useState(order.pendingRevert ?? []);

  useEffect(() => {
    let alive = true;
    loadWarehouses()
      .then(items => { if (alive) setWarehouses(items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  // A manager may hand the PO to any other member — purchaser or manager —
  // (or take it back) at any stage short of Done; ownership drives commission
  // and "my orders".
  const [ownerId, setOwnerId] = useState(order.userId);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (isPurchaser) return;
    let alive = true;
    api.get<{ items: { id: string; name: string }[] }>('/api/members')
      .then(r => { if (alive) setMembers(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [isPurchaser]);
  const ownerDirty = ownerId !== order.userId;
  // The member list holds active members only; a deactivated owner still
  // needs a row so the select can show the order as-is. The signed-in user is
  // ensured too, so the list never loses "take it back" while it loads.
  const ownerOptions = useMemo(() => {
    const opts = members.map(m => ({ ...m }));
    const ensure = (id?: string, name?: string | null) => {
      if (!id || opts.some(o => o.id === id)) return;
      opts.unshift({ id, name: name ?? id });
    };
    ensure(order.userId, order.userName);
    ensure(user?.id, user?.name);
    return opts;
  }, [members, order.userId, order.userName, user?.id, user?.name]);

  // Escape closes the drawer; if none open, closes the page.
  // When the delete modal is open, Escape dismisses it (if not mid-delete)
  // and does NOT fall through to the page-close / drawer-close logic.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showDelete) {
        if (!deleting) setShowDelete(false);
        return;
      }
      if (showArchive) {
        if (!archiving) setShowArchive(false);
        return;
      }
      if (activeIdx !== null) setActiveIdx(null);
      else onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIdx, onCancel, showDelete, deleting, showArchive, archiving]);

  const updateLine = (i: number, patch: Partial<EditLine>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch, _dirty: true } : l)));

  const addLine = (cat: Category) => {
    setLines(ls => [...ls, { ...blankLine(cat), _dirty: true }]);
    setActiveIdx(lines.length);
  };

  const removeLine = (i: number) => {
    setLines(ls => (ls.length <= 1 ? ls : ls.filter((_, j) => j !== i)));
    setActiveIdx(idx => {
      if (lines.length <= 1) return null;
      if (i === idx) return null;
      if (idx != null && i < idx) return idx - 1;
      return idx;
    });
  };

  const marketFor = useMarketLookup(lines.map(l => l.partNumber));

  // ── Category grouping ──────────────────────────────────────────────────
  // Only when the PO actually spans categories: a single-category order gets
  // one header restating a total the ledger already shows, which is noise.
  const groups = useMemo(() => groupLines(lines), [lines]);
  const grouped = useMemo(() => shouldGroup(lines), [lines]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFold = (cat: string) => setFolded(prev => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    return next;
  });

  // Which rows the table walks, and which the fold hides — see lib/lineGroups.
  // Kept out of the render so it can be tested without one.
  const rows = useMemo(
    () => displayRows(lines, groups, grouped, folded),
    [lines, groups, grouped, folded],
  );
  const groupByCat = useMemo(
    () => new Map(groups.map(g => [g.category, g])),
    [groups],
  );

  const groupHead = (category: string) => {
    const g = groupByCat.get(category);
    if (!g) return null;
    return (
      <tr className="grp-row" style={catTone(category)}>
        <td colSpan={8 + (canEditOrder ? 1 : 0) + (isManager ? 1 : 0)}>
          <button
            type="button"
            className="grp-hd"
            aria-expanded={!folded.has(category)}
            onClick={e => { e.stopPropagation(); toggleFold(category); }}
          >
            <span className={'grp-tw' + (folded.has(category) ? ' closed' : '')}>
              <Icon name="chevronDown" size={13} />
            </span>
            <span className="grp-chip">{category}</span>
            <span className="grp-meta">
              {g.lines.length === 1
                ? t('historyLineCountOne', { n: g.lines.length })
                : t('historyLineCountMany', { n: g.lines.length })}
              {' · '}{t('grpUnits', { n: g.units.toLocaleString(locale) })}
              {g.unpriced > 0 && <span className="grp-unpriced"> · {t('grpUnpriced', { n: g.unpriced })}</span>}
            </span>
            <span className="grp-amt mono">{fmtUSD(g.goods, locale)}</span>
            <span className={'grp-pl mono ' + (g.profit > 0 ? 'pos' : g.profit < 0 ? 'neg' : 'muted')}>
              {g.profit ? (g.profit > 0 ? '+' : '−') + fmtUSD(Math.abs(g.profit), locale) : '—'}
            </span>
          </button>
        </td>
      </tr>
    );
  };

  const dupGroups = useMemo(() => findDuplicatePartNumbers(lines), [lines]);
  // Lookup table keyed by line index → other 1-based line numbers sharing its
  // part #. Drives the inline drawer warning.
  const dupByIdx = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const g of dupGroups) {
      for (const ln of g.lineNums) {
        m.set(ln - 1, g.lineNums.filter(n => n !== ln));
      }
    }
    return m;
  }, [dupGroups]);

  const totals = useMemo(() => {
    let qty = 0, cost = 0, revenue = 0, profit = 0;
    for (const l of lines) {
      const q = Number(l.qty) || 0;
      const c = Number(l.unitCost) || 0;
      // An unpriced line still costs what it cost; it just earns nothing yet.
      const sp = isPricedSellPrice(l.sellPrice) ? Number(l.sellPrice) : 0;
      qty += q;
      cost += q * c;
      revenue += q * sp;
      profit += q * (sp - c);
    }
    // The priced subset — what can actually contribute to a realised
    // commission — through the rule the capture screen and the cost tape use.
    const priced = pricedTotals(lines);
    return {
      qty, cost, revenue, profit,
      pricedCount: priced.count, pricedProfit: priced.profit, pricedCost: priced.cost,
    };
  }, [lines]);

  const statusDirty = status !== savedStatus;
  const linesDirty = lines.some(l => l._dirty) || lines.length !== persistedIds.length;
  const notesDirty = (notes || '') !== (order.notes || '');
  const warehouseDirty = (warehouseId || '') !== (order.warehouse?.id ?? '');
  const paymentDirty = payment !== order.payment;
  // Only a company order carries a method; the server clears it on a flip to
  // self, so the local value is not a change until the order is company again.
  const methodDirty = payment === 'company' && paymentMethod !== (order.paymentMethod ?? null);
  // '' = explicitly unset (null). Non-numeric intermediate input (e.g. "5e")
  // must NOT be treated as a change — the same guard the other-fees field uses.
  const parsedCommission =
    commissionPct.trim() === '' ? null : Number(commissionPct);
  const commissionValid =
    parsedCommission === null || Number.isFinite(parsedCommission);
  const commissionRateValue =
    parsedCommission === null ? null : parsedCommission / 100;
  // null (unset) and 0 are equivalent — both yield zero commission — so
  // opening an order with a null DB rate at the default 0% UI value isn't
  // flagged as a pending change.
  const commissionDirty =
    commissionValid && (commissionRateValue ?? 0) !== (order.commissionRate ?? 0);
  // Non-numeric intermediate input ("5e") must not read as a change.
  const parsedOtherFees = parseFeeInput(otherFeesInput);
  // Compared in cents, not as raw floats: the input is seeded from
  // `toFixed(2)` and a plain !== on floats would call an untouched order
  // dirty on mount — which costs a purchaser the stage for opening the page.
  // The column is NUMERIC(12,2); that is the precision a change has to show
  // up at.
  const otherFeesDirty = !feeEq(parsedOtherFees, order.otherFees);
  const otherFeesNoteDirty = otherFeesNote.trim() !== (order.otherFeesNote ?? '');
  const paypalDirty = paypalTxn !== (order.paypalTxnId ?? '');
  const sourceDirty = (source ?? '') !== (order.source ?? '');
  const deliveryDirty = (delivery ?? '') !== (order.handoffMethod ?? '');
  // The collector only counts on a pickup, the box only on a label — the
  // server NULLs and unlinks the other side on a flip, which deliveryDirty
  // already covers.
  const byUserDirty = delivery === 'pickup' && byUserId !== (order.handoffBy?.id ?? '');
  const trackingDirty = delivery === 'label' && tracking.tn !== ''
    && (tracking.tn !== (pkg?.trackingNumber ?? '') || (tracking.carrier ?? '') !== (pkg?.carrier ?? ''));

  // The goods total is no longer editable here: it is the sum of the lines, and
  // anything paid on top of the goods is the fee — so line costs + fee is what
  // the purchaser actually paid, with nothing to reconcile between two fields.
  //
  // The stored total is read straight off the record, never round-tripped
  // through form state, because no control on this page can change it. Whether
  // it is a negotiated lot price worth preserving or just a mirror of the lines
  // is settled ONCE, against the subtotal the order arrived with — the same
  // instant the backend settles it (services/orderGoodsTotal.ts). Judge it
  // against the live sum instead and every unit-cost edit turns the mirror into
  // a fake override: the tape, the footer and the commission preview all freeze
  // on the figure the page opened with, while the save that follows stores the
  // new one. A real negotiated price does stay pinned, and the tape and footer
  // say so rather than leaving the arithmetic looking wrong.
  const loadedLineSubtotal = useMemo(
    () => order.lines.reduce((sum, l) => sum + l.qty * l.unitCost, 0),
    [order.lines],
  );
  const storedGoods = useMemo(
    () => readStoredGoodsTotal(order.totalCost, loadedLineSubtotal),
    [order.totalCost, loadedLineSubtotal],
  );
  const goodsOverridden = storedGoods.negotiated;

  // Derived values for the side Payment-detail panel.
  // Self pay → the purchaser is reimbursed for what they paid out of pocket
  // (effectiveTotalCost) AND earns commission on profit. Company pay → only
  // the commission on profit. When the order carries a negotiated goods total,
  // that price is the authoritative goods cost for EVERY part of the formula
  // — including (Revenue − Cost), so the commission preview reconciles cleanly
  // with the Self-pay reimbursement instead of mixing two cost figures. Fees
  // land on top of it, so they reduce profit and therefore commission.
  const cost = poEffectiveCost({
    lineSubtotal: totals.cost,
    totalCostOverride: storedGoods.override,
    otherFees: parsedOtherFees,
  });
  const effectiveTotalCost = cost.total;
  const effectiveProfit = totals.revenue - effectiveTotalCost;
  const commissionRateApplied = commissionRateValue ?? 0;
  const commissionOnProfit = effectiveProfit * commissionRateApplied;
  const purchaserEarn =
    (payment === 'self' ? effectiveTotalCost : 0) + commissionOnProfit;

  // Unsaved edits by section — the tabs' blue dots and the footer's count.
  // "products" is the items card above the tabs: no tab, but it counts.
  const dirtyBy = {
    products: linesDirty || otherFeesDirty || otherFeesNoteDirty,
    delivery: warehouseDirty || sourceDirty || deliveryDirty || byUserDirty || trackingDirty,
    payment: paymentDirty || methodDirty || paypalDirty,
    commission: commissionDirty || ownerDirty,
    notes: notesDirty,
  };
  const dirty = statusDirty || Object.values(dirtyBy).some(Boolean);
  // What the backend reads as a change to the order itself — the set that
  // sends a purchaser's submitted order back to Draft. A note is not one.
  const materialDirty =
    linesDirty || warehouseDirty || paymentDirty || methodDirty || otherFeesDirty
    || otherFeesNoteDirty || paypalDirty || sourceDirty || deliveryDirty || byUserDirty || trackingDirty;

  // What still stands between this Draft and In Transit — the one rule every
  // surface shares (lib/poReadiness.ts), the form's values overlaid on the
  // server's list for the sections the user has touched.
  const readiness = poReadiness({
    rules: {
      source, delivery, trackingValid: tracking.valid, carrier: tracking.carrier,
      paidBy: payment, method: paymentMethod, txnId: paypalTxn,
      chatAttachmentCount: proof.chatAtts.length,
      proofAttachmentCount: proof.proofAtts.length,
      saved: order,
    },
    lines: { count: lines.length, goods: cost.goods, everSubmitted: order.everSubmitted === true },
    commission: isPurchaser ? null : { rate: commissionRateValue },
    serverBlockers: savedStatus === 'Draft' ? order.blockers : null,
    dirty: dirtyBy,
  });

  // A company-paid PO names the payment that funded it before it leaves Draft.
  // The server decides whether the rule governs this order (its cutoff lives in
  // the DB), and refuses the advance regardless — this only saves the
  // round-trip. `=== true` deliberately: an older backend omits the field.
  // The local method decides, not only the saved one: a manager who picks
  // Cash and stage-jumps in one Save must not be held for an id the server
  // will not ask for once the PATCH lands. The saved verdicts were computed
  // for the saved paid-by and method, though — one about the other path says
  // nothing, so a flip blocks and the server judges.
  // Only the proof rules: the facts (source, delivery, tracking, method)
  // are the checkpoint's to collect, and a manager's stage-jump through Save
  // is not held to them — exactly what the server enforces on /advance.
  const leavingDraft = statusDirty && status !== 'Draft';
  const PROOF_KEYS = new Set(['poTxnRequired', 'hoNeedCashShot', 'hoNeedChatShot']);
  const proofBlockedKey = leavingDraft
    ? readiness.find(r => r.tab === 'payment')?.needKeys.find(k => PROOF_KEYS.has(k)) ?? null
    : null;
  const txnBlocked = proofBlockedKey === 'poTxnRequired';
  const cashShotBlocked = proofBlockedKey === 'hoNeedCashShot' || proofBlockedKey === 'hoNeedChatShot';

  // A cost is asked of a line that is new or that the user touched. Hundreds
  // of legacy lines sit at $0 (and lot-priced POs keep theirs there on
  // purpose); Save checks every line, so demanding a cost of an untouched
  // one would lock those orders against any edit.
  const costRequired = (l: EditLine) => !l._id || !!l._dirty;
  const lineReady = (l: EditLine) => lineRequirements(l, { requireCost: costRequired(l) }).ready;
  // A note-only save (purchaser past In Transit) sends no lines, so an
  // incomplete legacy line must not block it — they can't fix it at that stage.
  // Line readiness gates only the saves that actually write lines. A note-only
  // save sends none, so an incomplete legacy line must not block it — the
  // purchaser can't fix that line at this stage anyway.
  const canSave =
    dirty && !saving && !txnBlocked && !cashShotBlocked && (!orderLocked || (canReopen && statusDirty))
    && (!canEditOrder || !(linesDirty || statusDirty) || lines.every(lineReady));

  // Localized "Brand, Quantity" list of what a line is still waiting on. The
  // capture screen asks the same question, and used to name the same blank
  // field by a different word.
  const missingNamesFor = (l: EditLine): string | null =>
    missingFieldNames(lineRequirements(l, { requireCost: costRequired(l) }).missingKeys, t, lang);

  // Serial rules fire only where the backend's will: on new lines, and on
  // edits that change serial/qty/generation from what the server holds.
  // Untouched legacy serial-less lines stay saveable for price/status.
  const originalById = useMemo(() => {
    const m = new Map<string, EditLine>();
    for (const ol of order.lines) m.set(ol.id, orderLineToEditLine(ol));
    return m;
  }, [order.lines]);
  // The final sell price is read straight off the server line: it is derived
  // from sell orders, never edited here, so it stays out of EditLine.
  const serverLineById = useMemo(
    () => new Map(order.lines.map(ol => [ol.id, ol] as const)),
    [order.lines],
  );
  const changesSerialFields = (l: EditLine): boolean => {
    const o = l._id ? originalById.get(l._id) : undefined;
    if (!o) return true;
    return (l.generation ?? null) !== (o.generation ?? null)
      || Number(l.qty) !== Number(o.qty)
      || (l.serialNumber ?? '') !== (o.serialNumber ?? '');
  };
  const serialIssueFor = (l: EditLine) => (changesSerialFields(l) ? serialIssue(l) : null);

  // Everything standing between the user and a save, one entry per problem.
  // Save stays clickable while these exist: clicking opens a dialog listing
  // them, which beats a dead button next to a hint that's easy to miss.
  const saveBlockers: string[] =
    saving || canSave  ? []
  : isArchived         ? [t('saveBlockedArchived')]
  : orderLocked        ? [t('saveBlockedLocked')]
  : !dirty             ? [t('saveBlockedNoChanges')]
  : proofBlockedKey    ? [t(proofBlockedKey)]
  : lines.flatMap((l, i) => {
      if (brandConfirmPending(l)) {
        return [lines.length === 1
          ? t('subConfirmBrandThis')
          : t('subConfirmBrandLine', { n: i + 1 })];
      }
      if (lineReady(l)) return [];
      const fields = missingNamesFor(l);
      if (fields) {
        return [lines.length === 1
          ? t('subMissingFieldsThis', { fields })
          : t('subMissingFieldsLine', { n: i + 1, fields })];
      }
      return [lines.length === 1 ? t('subFillThisLine') : t('subFillLineN', { n: i + 1 })];
    });

  const attemptSave = () => {
    if (saveBlockers.length) {
      showErrorDialog(t('errCantSaveMsg'), saveBlockers, t('errCantSaveTitle'));
      return;
    }
    void save();
  };

  const doSave = async () => {
    setSaving(true);
    try {
      // Past the purchaser's edit window only the note is theirs to change;
      // sending the line/pricing keys too would trip the backend's 403.
      if (!canEditOrder) {
        if (notesDirty) await api.patch(`/api/orders/${order.id}`, { notes });
        // Manager reopening a Done order — the one stage move a closed order
        // accepts. /advance cascades line statuses server-side, so no line
        // patch is needed alongside it.
        if (statusDirty && !isPurchaser) {
          const toStage = Object.keys(LIFECYCLE_STATUS).find(k => LIFECYCLE_STATUS[k] === status);
          await api.post(`/api/orders/${order.id}/advance`, { toStage });
          setSavedStatus(status);
          if (onReload) {
            window.__showToast?.('Saved ' + order.id, 'success');
            await onReload();
            return;
          }
        }
        onSaved('Saved ' + order.id);
        return;
      }
      const presentIds = new Set(lines.filter(l => l._id).map(l => l._id!));
      const removeLineIds = persistedIds.filter(id => !presentIds.has(id));
      const addedLines = lines.filter(l => !l._id);
      const r = await api.patch<{
        ok: true; addedLineIds: string[]; lifecycle: string; paymentsLinked?: number;
      }>(`/api/orders/${order.id}`, {
        notes:         notesDirty     ? notes                  : undefined,
        warehouseId:   warehouseDirty ? (warehouseId || null)  : undefined,
        payment:       paymentDirty   ? payment                : undefined,
        paymentMethod: methodDirty    ? paymentMethod          : undefined,
        commissionRate: commissionDirty ? commissionRateValue : undefined,
        paypalTxnId:   paypalDirty     ? (paypalTxn || null)   : undefined,
        onBehalfOfUserId: ownerDirty ? ownerId : undefined,
        source:        sourceDirty   ? source                 : undefined,
        handoffMethod: deliveryDirty ? delivery               : undefined,
        handoffBy:     byUserDirty || (deliveryDirty && delivery === 'pickup') ? (byUserId || null) : undefined,
        ...(trackingDirty && tracking.carrier
          ? { trackingNumber: tracking.tn, carrier: tracking.carrier }
          : {}),
        otherFees:     otherFeesDirty ? parsedOtherFees : undefined,
        otherFeesNote: otherFeesNoteDirty ? (otherFeesNote.trim() || null) : undefined,
        lines: lines
          .filter(l => l._id && (l._dirty || statusDirty))
          .map(l => editLineToPatch(l, statusDirty ? status : undefined)),
        addLines: addedLines.map(l => editLineToInsert(l, status)),
        removeLineIds: removeLineIds.length ? removeLineIds : undefined,
      });
      // addedLineIds comes back aligned 1:1 with the addLines we sent, so a
      // photo buffered against a line that had no id can finally reach it.
      // Before onSaved, which navigates away and takes the buffer with it.
      const idByCid = new Map<string, string>();
      addedLines.forEach((l, i) => { if (r.addedLineIds[i]) idByCid.set(l._cid, r.addedLineIds[i]); });
      // Written back before anything can keep the user on this page: a second
      // save must patch these lines, not append them a second time.
      setLines(ls => ls.map(l => {
        const id = idByCid.get(l._cid);
        return id ? { ...l, _id: id, _dirty: false } : (l._dirty ? { ...l, _dirty: false } : l);
      }));
      setPersistedIds([...persistedIds.filter(id => presentIds.has(id)), ...idByCid.values()]);
      let stillQueued = 0;
      for (const [cid, newId] of idByCid) stillQueued += await flushPendingPhotos(cid, newId);
      // A photo picked for an existing line whose upload failed is queued too,
      // and this is its last chance before the page goes away.
      for (const l of lines) {
        if (l._id && photos.queuedFor(l._cid).length) {
          stillQueued += await flushPendingPhotos(l._cid, l._id);
        }
      }
      // The stepper's stage lives on orders.lifecycle, which PATCH never
      // touches — only /advance moves it (and cascades the line statuses).
      // Without this the save returns 200, the lines flip, but the stage snaps
      // back on reload. Managers may jump straight to the target stage;
      // purchasers can only step forward and the backend rejects `toStage` for
      // them, so send an empty body to advance one stage.
      let movedStage = false;
      if (statusDirty) {
        const toStage = Object.keys(LIFECYCLE_STATUS).find(k => LIFECYCLE_STATUS[k] === status);
        await api.post(`/api/orders/${order.id}/advance`, isPurchaser ? {} : { toStage });
        setSavedStatus(status);
        movedStage = true;
      } else {
        applyLifecycle(r.lifecycle);
      }
      // The order is saved either way, but those Files exist nowhere else and
      // this page is the only thing holding them — leaving now would discard
      // them. Retry is in the footer.
      if (stillQueued > 0) {
        setHeldAfterSave(true);
        showErrorDialog(t('linePhotoRetryHold', { n: stillQueued }));
        return;
      }
      // Saving a transaction id reconciles the payment on the way past, and the
      // page is about to navigate away — so the toast is where the manager
      // finds out it happened.
      const msg = r.paymentsLinked ? t('eoPaymentLinkedToast', { id: order.id }) : 'Saved ' + order.id;
      // A stage move is the news the status section exists to show: stay on
      // the page, on the new stage's panel. A plain save returns to the list
      // as it always has.
      if (movedStage && onReload) {
        window.__showToast?.(msg, 'success');
        await onReload();
        return;
      }
      onSaved(msg);
    } catch (e) {
      // Keep the editor open and the user's edits intact on failure — calling
      // onSaved here would navigate away and discard unsaved work.
      showErrorDialog(e instanceof Error ? e.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // PATCH returns where the order ended up: a purchaser's material change sends
  // it back to Draft. Every write path has to take this, or the page keeps
  // showing the stage the order left and the stepper offers no way back.
  const applyLifecycle = (lifecycle: string | undefined) => {
    const next = lifecycle ? LIFECYCLE_STATUS[lifecycle] : undefined;
    if (!next || next === savedStatus) return;
    setStatus(next);
    setSavedStatus(next);
  };

  // A purchaser's first write to a submitted order costs it the stage, so ask
  // once per visit before any of the paths that write — Save, and the drawer's
  // own Confirm. Answering resolves whichever call is waiting.
  const askRevert = (material = true): Promise<boolean> => {
    if (!revertOnSave || revertAcked || !material) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      setRevertConfirm(() => (ok: boolean) => {
        setRevertConfirm(null);
        if (ok) setRevertAcked(true);
        resolve(ok);
      });
    });
  };

  const save = async () => {
    const issues = lines
      .map((l, idx) => ({ lineNo: idx + 1, label: l.partNumber || itemType(l), issue: serialIssueFor(l) }))
      .filter((x): x is SerialLineIssue => x.issue !== null);
    if (issues.length) {
      setSerialIssues(issues);
      return;
    }
    if (dupGroups.length > 0) {
      setDupConfirm(dupGroups);
      return;
    }
    if (!(await askRevert(materialDirty))) return;
    await doSave();
  };

  // Drawer "Confirm line" writes that one line straight to the DB instead of
  // parking it in local state until Save. Closing the tab after confirming
  // therefore loses nothing — matching what Confirm already means on the
  // new-order screen. Save still exists for order-level fields and the stage.
  // Throws on failure so the drawer keeps itself open and shows the reason.
  const confirmLine = async (i: number): Promise<void> => {
    const l = lines[i];
    if (!l) return;
    // Backstop for the drawer's own gate — this is the funnel every confirm
    // goes through, so the rule can't be routed around here.
    if (brandConfirmPending(l)) throw new Error(t('subConfirmBrandThis'));
    if (!lineReady(l)) throw new Error(t('subFillThisLine'));
    // Nothing to push for an untouched server line; skip the round trip.
    if (l._id && !l._dirty) return;
    const issue = serialIssueFor(l);
    if (issue) {
      setSerialIssues([{ lineNo: i + 1, label: l.partNumber || itemType(l), issue }]);
      // Thrown so the drawer keeps itself open for the fix.
      throw new Error(t('serialCheckTitle'));
    }
    // Confirm writes straight through, so the stage warning belongs here too —
    // but after the checks that can still abort, or a save that never happens
    // spends the once-per-visit acknowledgement.
    if (!(await askRevert())) throw new Error(t('revertWarnCancelled'));
    const r = await api.patch<{ ok: true; addedLineIds: string[]; lifecycle: string }>(
      `/api/orders/${order.id}`,
      l._id
        ? { lines: [editLineToPatch(l)] }
        : { addLines: [editLineToInsert(l, status)] },
    );
    // A purchaser's confirm can send the order back to Draft. Without this the
    // page keeps showing the old stage, the stepper still offers only that
    // stage, and there is no way to re-submit short of a reload.
    applyLifecycle(r.lifecycle);
    const newId = l._id ?? r.addedLineIds[0];
    setLines(ls => ls.map((x, j) => (j === i ? { ...x, _id: newId, _dirty: false } : x)));
    if (!l._id && newId) {
      setPersistedIds(ids => [...ids, newId]);
      if (await flushPendingPhotos(l._cid, newId)) showErrorDialog(t('linePhotoUploadFailed'));
    }
    setActivityKey(k => k + 1);
    window.__showToast?.(t('drawerLineSaved', { n: i + 1 }), 'success');
  };

  const itemType = (l: EditLine) =>
      l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()
    : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
    : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
    : (l.description ?? '—');
  const itemSpec = (l: EditLine) =>
      l.category === 'RAM' ? [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')
    : l.category === 'SSD' ? [l.formFactor, l.health != null && (l.health + '%'), l.condition].filter(Boolean).join(' · ')
    : l.category === 'HDD' ? [l.interface, l.formFactor, l.health != null && (l.health + '%'), l.condition].filter(Boolean).join(' · ')
    : (l.condition ?? '');

  // ── The status section's model ──────────────────────────────────────────
  const currentIdx = ORDER_STATUSES.indexOf(spineStatus(status) as typeof ORDER_STATUSES[number]);
  const viewStageId = view === null ? null
    : (Object.keys(LIFECYCLE_STATUS).find(k => LIFECYCLE_STATUS[k] === view) as StageId | undefined) ?? null;
  // On a closed order every move is off except the manager's ways out of it
  // (REOPEN_TARGETS); the warehouse gate holds the two review stages.
  const stepDisabled = (s: string) =>
    !allowedStatuses.includes(s)
    || (orderLocked && !(canReopen && REOPEN_TARGETS[savedStatus]?.includes(s)));
  // The move to a stage — the panel's button and the stepper's next step call
  // the same thing. Done gets the evidence dialog first; leaving Draft is the
  // checkpoint's job; everything else is staged and Save commits it.
  const advanceTo = (s: string) => {
    if (stepDisabled(s)) return;
    if (s === 'Done') { setDoneDialogOpen(true); return; }
    if (s === 'In Transit' && savedStatus === 'Draft') {
      // The checkpoint writes its own fields and advances in one call, so
      // unsaved page edits would be left behind — ask for the save first.
      if (dirty) { showErrorDialog(t('hoSaveFirst')); return; }
      // The cost is fixed on this page, not in the dialog, so it is asked for
      // here — and the server refuses it too. First submission only: a PO an
      // edit sent back to Draft re-submits as it was accepted.
      if (!(cost.goods > 0) && !order.everSubmitted) {
        showErrorDialog(t('poCostRequired'), undefined, t('errCantSubmitTitle'));
        return;
      }
      setHandoffOpen(true);
      return;
    }
    setStatus(s);
  };
  const nextStage = ORDER_STATUSES[currentIdx + 1] ?? null;
  const nextStep = nextStage ? {
    label: t('eoMarkAs', { s: nextStage }),
    onClick: () => advanceTo(nextStage),
    disabled: stepDisabled(nextStage),
    hint: stepDisabled(nextStage)
      ? (isPurchaser ? t('eoStepLockedTooltip')
        : gateLocked.includes(nextStage as typeof gateLocked[number])
          ? t('eoStepWarehouseMgrTooltip', { name: gateWarehouse?.manager ?? '', wh: gateWarehouse?.short ?? '', stage: nextStage })
          : null)
      : nextStage === 'In Transit' ? t('eoNextInTransitHint') : null,
  } : null;
  // What each met readiness row reads back — the page's live values, so a
  // just-typed answer shows before it is saved.
  const collectorName = memberNames.find(m => m.id === byUserId)?.name ?? order.handoffBy?.name ?? null;
  const readySummaries: Partial<Record<ReadinessTab, string>> = {
    products: t('subUnitsCost', { n: totals.qty, cost: fmtUSD(cost.goods, locale) }),
    delivery: [
      source ? t(packageSourceLabelKey(source)) : null,
      gateWarehouse?.short ?? order.warehouse?.short ?? null,
      delivery === 'pickup' ? [t('hoPickup'), collectorName].filter(Boolean).join(' · ')
        : delivery === 'label' ? [tracking.carrier, tracking.tn].filter(Boolean).join(' ') : null,
    ].filter(Boolean).join(' · '),
    payment: [
      payment === 'self' ? t('paySelfShort') : t('payCompanyShort'),
      payment === 'company' ? (paymentMethod === 'cash' ? t('hoMethodCash') : paymentMethod === 'paypal' ? t('hoMethodPaypal') : null) : null,
      payment === 'company' && paymentMethod === 'paypal' ? paypalTxn.trim() || null : null,
    ].filter(Boolean).join(' · '),
    commission: [ownerOptions.find(o => o.id === ownerId)?.name ?? order.userName, `${commissionPct || '0'}%`].join(' · '),
  };
  // A readiness row is a link to what fixes it: the items card for products,
  // the tab (and its first field) for everything else.
  const goTo = (target: ReadinessTab) => {
    if (target === 'products') {
      tableScrollRef.current?.closest('.oe-items-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setTab(target);
    const focusId = target === 'delivery' ? (source ? (delivery === 'label' ? 'oe-tracking' : 'oe-by') : 'oe-source')
      : target === 'payment' ? (paymentMethod === 'paypal' ? 'eo-txn' : 'eo-paidby')
      : 'eo-rate';
    requestAnimationFrame(() => {
      const el = document.getElementById(focusId) ?? document.getElementById('oe-tab-' + target);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.focus({ preventScroll: true });
    });
  };

  return (
    <>
      <div className="page-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <button
            onClick={onCancel}
            style={{
              background: 'none', border: 'none', padding: 0,
              color: 'var(--fg-subtle)', fontSize: 12.5,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
              marginBottom: 6,
            }}
          >
            <Icon name="chevronLeft" size={12} /> {t('backToOrders')}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title" style={{ margin: 0 }}>{t('editOrder')}</h1>
            <span className="mono" style={{
              fontSize: 13, fontWeight: 600, padding: '3px 9px',
              borderRadius: 5, background: 'var(--bg-soft)',
              border: '1px solid var(--border)', whiteSpace: 'nowrap',
            }}>{order.id}</span>
            <OrderCategoryChips categories={order.categories} max={3} />
          </div>
          <div className="page-sub" style={{ marginTop: 6 }}>
            {fmtDateShort(order.createdAt, locale)} · {t('submittedBy')} {order.userName.split(' ')[0]} · {lines.length === 1 ? t('historyLineCountOne', { n: lines.length }) : t('historyLineCountMany', { n: lines.length })} · {t('editOrderSub')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
          {canArchive && (
            isArchived ? (
              <button
                className="btn"
                style={{ color: 'var(--accent-strong)', borderColor: 'var(--accent)' }}
                disabled={archiving}
                onClick={async () => {
                  setArchiving(true);
                  try {
                    await unarchiveOrder(order.id);
                    onSaved(t('orderRestoredToast'));
                  } catch (e) {
                    handleFetchError(e);
                    setArchiving(false);
                  }
                }}
                title={t('eoUnarchiveTooltip')}
              >
                <Icon name="rotate" size={13} /> {archiving ? '…' : t('eoUnarchive')}
              </button>
            ) : (
              <button
                className="btn"
                onClick={() => setShowArchive(true)}
                title={t('eoArchiveTooltip')}
              >
                <Icon name="box" size={13} /> {t('archiveOrder')}
              </button>
            )
          )}
          {canDelete && (
            <button
              className="btn"
              style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
              onClick={() => { setTypedId(''); setShowDelete(true); }}
            >
              <Icon name="trash" size={13} /> {t('deleteOrder')}
            </button>
          )}
        </div>
      </div>
      {isArchived && (
        <div className="card" style={{
          padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--bg-soft)', borderStyle: 'dashed',
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            background: 'oklch(0.96 0.04 295)', color: 'oklch(0.45 0.16 295)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Icon name="box" size={14} />
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.45 }}>
            <strong style={{ color: 'var(--fg)' }}>{t('historyArchived')}</strong> · {t('eoArchivedBannerBody')}
          </div>
        </div>
      )}

      {/* --oe-rows mirrors the visible line count (capped at 10) so the activity
          log's max height tracks the item table — short table, short log. */}
      <div className="oe-body" style={{ ['--oe-rows' as string]: String(Math.min(lines.length, 10)) }}>
      <div className={'card oe-items-card' + (!canEditOrder ? ' order-readonly' : '')}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('orderDetails')}</div>
            <div className="card-sub">{t('subOrderContainsMixed')}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="chip mono">{t('subUnitsCost', { n: totals.qty, cost: fmtUSD(totals.cost, locale) })}</span>
            <span className="chip mono">{order.id} · {t('subStatusEditing')}</span>
            {canEditOrder && (
              <span style={{ marginLeft: 'auto' }}><AddLineMenu onAdd={addLine} /></span>
            )}
          </div>
        </div>
        <div className="table-scroll" ref={tableScrollRef}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th>{t('item')}</th>
                <th>{t('partNumber')}</th>
                <th className="num">{t('qty')}</th>
                <th className="num">{t('unitCost')}</th>
                <th className="num">{t('sellUnit')}</th>
                {isManager && <th className="num">{t('finalSellPrice')}</th>}
                <th className="num">{t('revenue')}</th>
                <th className="num">{t('profit')}</th>
                {canEditOrder && <th style={{ width: 40 }}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ line: l, index: i, head, hidden }) => {
                const qty = Number(l.qty) || 0;
                const lCost = Number(l.unitCost) || 0;
                const sp = l.sellPrice == null || l.sellPrice === '' ? 0 : Number(l.sellPrice);
                const profit = qty * (sp - lCost);
                const lossy = sp > 0 && sp < lCost;
                const server = l._id ? serverLineById.get(l._id) : undefined;
                const finalPrice = server?.finalSellPrice ?? null;
                const finalQty = server?.finalSoldQty ?? null;
                const filled = !!l.brand || !!l.description;
                const isActive = i === activeIdx;
                // A folded group still emits its header row, just none of its
                // lines — otherwise the group would vanish along with them.
                // Every member drops out, not only the one carrying the head.
                if (hidden) {
                  return head ? <Fragment key={'g-' + head}>{groupHead(head)}</Fragment> : null;
                }
                // Rows open the drawer at every stage — a locked order gets a
                // read-only drawer, not an unreachable one.
                return (
                  <Fragment key={l._id ?? l._cid}>
                  {head && groupHead(head)}
                  <tr
                    className="row-hover"
                    style={{
                      cursor: 'pointer',
                      background: isActive ? 'var(--accent-soft)' : undefined,
                    }}
                    onClick={() => setActiveIdx(i)}
                  >
                    <td className="mono" style={{ color: isActive ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontWeight: isActive ? 600 : 400 }}>{i + 1}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {(() => {
                          // Any line may carry photos now, not just the RAM
                          // ones an AI scan happened to produce. Shows the
                          // first with a +N when there are more.
                          const shots = linePhotos(l);
                          if (!shots.length) return null;
                          return (
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); setLightboxUrl(shots[0].url); }}
                              title={t('linePhotos')}
                              style={{
                                width: 40, height: 40, borderRadius: 8, flexShrink: 0, position: 'relative',
                                border: '1px solid var(--border)', overflow: 'hidden',
                                padding: 0, background: 'var(--bg-soft)', cursor: 'pointer',
                              }}
                            >
                              <img
                                src={shots[0].url}
                                alt={t('linePhotos')}
                                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                              />
                              {shots.length > 1 && (
                                <span style={{
                                  position: 'absolute', right: 0, bottom: 0,
                                  background: 'rgba(15,23,42,0.72)', color: 'white',
                                  fontSize: 9, fontWeight: 700, padding: '1px 4px',
                                  borderTopLeftRadius: 5,
                                }}>+{shots.length - 1}</span>
                              )}
                            </button>
                          );
                        })()}
                        <div style={{ minWidth: 0 }}>
                          {filled ? (
                            <>
                              <div style={{ fontWeight: 500 }}>{itemType(l)}</div>
                              <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{itemSpec(l)}</div>
                            </>
                          ) : (
                            <span className="muted" style={{ fontStyle: 'italic' }}>
                              {isActive ? t('subEditingFill') : t('subNotFilled')}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{l.partNumber || '—'}</td>
                    <td className="num mono">{qty}</td>
                    <td className="num mono">{lCost ? fmtUSD(lCost, locale) : '—'}</td>
                    <td className="num mono">{sp ? fmtUSD(sp, locale) : '—'}</td>
                    {isManager && (
                      <td className="num mono">
                        {finalPrice != null ? fmtUSD(finalPrice, locale) : '—'}
                        {finalPrice != null && finalQty != null && finalQty !== qty && (
                          <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>×{finalQty}</span>
                        )}
                      </td>
                    )}
                    <td className="num mono">{sp && qty ? fmtUSD(sp * qty, locale) : '—'}</td>
                    <td className={'num mono ' + (sp ? (profit >= 0 ? 'pos' : 'neg') : 'muted')}>
                      {sp ? fmtUSD(profit, locale) : '—'}
                      {lossy && <Icon name="alert" size={11} style={{ marginLeft: 4, color: 'var(--warn)' }} />}
                    </td>
                    {canEditOrder && (
                      <td>
                        <button
                          className="btn icon sm"
                          onClick={e => { e.stopPropagation(); removeLine(i); }}
                          title={t('soRemoveLineTooltip')}
                          disabled={lines.length <= 1}
                          style={lines.length <= 1 ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </td>
                    )}
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* The PO's money as a receipt — see components/CostTape. The fee is
            the one editable cell in it: a cost that never was a line. */}
        <div className="oe-items-foot">
          <CostTape
            groups={groups}
            grouped={grouped}
            lineCount={lines.length}
            units={totals.qty}
            goods={cost.goods}
            fees={parsedOtherFees}
            total={effectiveTotalCost}
            revenue={totals.revenue}
            pricedCost={totals.pricedCost}
            pricedProfit={totals.pricedProfit}
            pricedCount={totals.pricedCount}
            locale={locale}
            showRealized={isManager}
            realized={order.realized ?? null}
            commissionRate={order.commissionRate}
            goodsNote={goodsOverridden ? (
              <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · {t('subOverride')}</span>
            ) : undefined}
            feeField={canEditOrder ? (
              <span style={{ position: 'relative', display: 'inline-block' }}>
                <span className="mono oe-ledger-currency" aria-hidden="true">$</span>
                <input
                  id="oe-other-fees"
                  // Its visible label is a receipt row inside CostTape, not a
                  // <label>, so the field is unnamed without this.
                  aria-label={t('otherFees')}
                  className="input mono tape-money"
                  type="number"
                  min={0}
                  step="0.01"
                  value={otherFeesInput}
                  placeholder="0.00"
                  onChange={e => setOtherFeesInput(e.target.value)}
                  onFocus={e => e.target.select()}
                  style={{ paddingLeft: 22 }}
                />
              </span>
            ) : undefined}
            feeNoteField={canEditOrder ? (
              <input
                className="input tape-note"
                type="text"
                maxLength={280}
                value={otherFeesNote}
                placeholder={t('otherFeesPh')}
                onChange={e => setOtherFeesNote(e.target.value)}
                aria-label={t('otherFeesNote')}
              />
            ) : (otherFeesNote.trim() ? <span className="muted" style={{ fontSize: 11.5 }}>{otherFeesNote.trim()}</span> : undefined)}
          />
        </div>
      </div>

      {/* ── Order status: the stepper and, under it, what the current stage is
          about — or what a finished stage recorded, when a reached step is
          clicked. The one section that is always visible. ── */}
      <div className="card oe-status-card">
        <div className="oe-status-head">
          <SectionHead icon="flag">
            {t('orderStatus')}
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              {view !== null
                ? t('eoLookingBack', { s: view })
                : t('eoStepperHint')}
            </span>
          </SectionHead>
          <div className="so-stepper">
            {ORDER_STATUSES.map((s, i) => {
              const active = s === spineStatus(status);
              // A sold order sits on Done's step under its own name.
              const label = active && status === 'Sold' ? 'Sold' : s;
              const reached = currentIdx >= 0 && i < currentIdx;
              const isNext = i === currentIdx + 1;
              const movable = !stepDisabled(s);
              // Reached steps are always a look-back; the next step is the
              // move; anything further is locked — including the manager's
              // two-stage jump, which the panel's button never offered.
              const locked = !reached && !active && !(isNext && movable);
              const viewingThis = view === s;
              return (
                <Fragment key={s}>
                  <button
                    type="button"
                    className={'so-step' + (active ? ' active' : '') + (reached ? ' reached' : '')
                      + (locked ? ' locked' : '') + (viewingThis ? ' viewing' : '')
                      + (active && status === 'Sold' ? ' sold' : '')}
                    onClick={() => {
                      if (reached) { setView(s); return; }
                      if (active) { setView(null); return; }
                      if (isNext && movable) advanceTo(s);
                    }}
                    disabled={locked}
                    title={reached ? t('eoLookbackTip', { s })
                      : active ? t('eoCurrentStage')
                      : !movable
                        ? (isPurchaser
                          ? t('eoStepLockedTooltip')
                          : t('eoStepWarehouseMgrTooltip', {
                            name: gateWarehouse?.manager ?? '', wh: gateWarehouse?.short ?? '', stage: gateLocked[0] ?? s,
                          }))
                        : isNext ? t('eoSetStatusTo', { s }) : t('eoStepLater')}
                  >
                    <span className="so-step-dot">
                      {reached ? <Icon name="check" size={10} stroke={3} /> : locked && !movable && isNext ? <Icon name="lock" size={10} /> : (i + 1)}
                    </span>
                    <span className="so-step-label">{label}</span>
                  </button>
                  {i < ORDER_STATUSES.length - 1 && (
                    <span className={'so-step-bar' + (i < currentIdx ? ' reached' : '')} />
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>

        {view !== null && viewStageId ? (
          <StageLookback
            stage={view}
            stageId={viewStageId}
            currentStage={status}
            events={events.events}
            eventsLoaded={events.loaded}
            pkg={pkg}
            onBack={() => setView(null)}
            moveBack={!stepDisabled(view) && view !== status ? () => { setStatus(view); setView(null); } : null}
            locale={locale}
          />
        ) : (
          <StagePanel
            status={status}
            order={order}
            readiness={savedStatus === 'Draft' ? readiness : []}
            summaries={readySummaries}
            onGoTo={goTo}
            next={nextStep}
            pkg={pkg}
            onRefreshPkg={() => void refreshPkg()}
            refreshState={refreshState}
            doneEvidence={(doneNote || doneAttachments.length > 0) && (
              <div style={{
                marginTop: 4, padding: '10px 12px', borderRadius: 8,
                background: 'var(--bg-elev)', border: '1px solid var(--border)',
                display: 'grid', gap: 8,
              }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <Icon name="paperclip" size={11} /> {t('poDoneEvidenceTitle')}
                </div>
                {doneNote && (
                  <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{doneNote}</div>
                )}
                {doneAttachments.map(a => (
                  <AttachmentChip
                    key={a.id}
                    a={a}
                    onRemove={!isPurchaser ? () => removeDoneAtt(a) : undefined}
                  />
                ))}
              </div>
            )}
            locale={locale}
          >
            {isPurchaser && !purchaserCanEdit && (
              <div className="oe-banner">
                <Icon name="lock" size={13} />
                {effectiveStatus === 'Ready to Pay' ? t('eoReadyToPayNote') : t('eoReviewedByMgr')}
              </div>
            )}
            {!isPurchaser && gateLocked.length > 0 && (
              <div className="oe-banner">
                <Icon name="lock" size={13} />
                {t('eoWarehouseMgrOnly', {
                  name: gateWarehouse?.manager ?? '', wh: gateWarehouse?.short ?? '', stage: gateLocked[0],
                })}
              </div>
            )}
            {revertOnSave && (
              <div className="oe-banner warn">
                <Icon name="rotate" size={13} />
                {t('revertHint')}
              </div>
            )}
            {statusDirty && (
              <div className="oe-banner accent">
                <Icon name="info" size={13} />
                {t('eoStatusChangeMgrPre')} <strong>{effectiveStatus}</strong> {t('eoStatusChangeMid')} <strong>{status}</strong> {isPurchaser ? t('eoStatusChangePurchPost') : t('eoStatusChangePost')}
              </div>
            )}
          </StagePanel>
        )}
      </div>

      {/* ── Five tabs, one fact each. ── */}
      <OrderTabs
        tab={tab}
        onTab={setTab}
        counts={{ notes: submissionAtts.length || undefined, activity: events.loaded ? events.events.length : undefined }}
        need={savedStatus === 'Draft' ? {
          delivery: readiness.some(r => r.tab === 'delivery' && !r.ok),
          payment: readiness.some(r => r.tab === 'payment' && !r.ok),
          commission: readiness.some(r => r.tab === 'commission' && !r.ok),
        } : {}}
        dirty={{ delivery: dirtyBy.delivery, payment: dirtyBy.payment, commission: dirtyBy.commission, notes: dirtyBy.notes }}
      >
        {{
          delivery: (
            <DeliveryTab
              source={source} onSource={setSource}
              warehouseId={warehouseId} onWarehouse={setWarehouseId}
              warehouses={warehouses}
              warehouseFallback={order.warehouse?.name ?? order.warehouse?.short ?? '—'}
              delivery={delivery} onDelivery={setDelivery}
              byUserId={byUserId} onByUser={setByUserId}
              members={memberNames}
              tracking={tracking}
              pkg={pkg}
              disabled={!canEditOrder}
              locale={locale}
            />
          ),
          payment: (
            <div className="oe-tabpad oe-pay">
              <PaymentFields
                paidBy={payment} onPaidBy={setPayment}
                method={paymentMethod} onMethod={setPaymentMethod}
                txnId={paypalTxn} onTxnId={setPaypalTxn}
                txnRequired={order.txnRequired === true}
                disabled={!canEditOrder}
                proof={proof}
                canEditProof={canEditSubmission}
                idPrefix="eo"
              />
              {/* Bank payments linked to this PO on the Payments page. Manager-only
                  (the API 403s everyone else) and invisible until something links. */}
              {user?.role === 'manager' && <PoPaymentsLedger orderId={order.id} locale={locale} />}
            </div>
          ),
          commission: (
            <CommissionTab
              ownerId={ownerId} onOwner={setOwnerId} ownerOptions={ownerOptions}
              commissionPct={commissionPct} onCommissionPct={setCommissionPct}
              isPurchaser={isPurchaser} orderLocked={orderLocked} isArchived={isArchived}
              payment={payment}
              purchaserEarn={purchaserEarn}
              effectiveTotalCost={effectiveTotalCost}
              revenue={totals.revenue}
              fees={cost.fees}
              otherFeesNote={otherFeesNote}
              effectiveProfit={effectiveProfit}
              commissionRateApplied={commissionRateApplied}
              commissionOnProfit={commissionOnProfit}
              lineCount={lines.length}
              pricedCount={totals.pricedCount}
              firstName={order.userName.split(' ')[0]}
              locale={locale}
              commissionPayment={commissionPayment}
              canEditCommissionPayment={!isPurchaser}
            />
          ),
          notes: (
            <div className="oe-tabpad" style={{ display: 'grid', gap: 14 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="eo-notes">{t('orderNotes')}</label>
                <textarea
                  id="eo-notes"
                  className="input"
                  rows={3}
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder={t('orderNotesPh')}
                  disabled={!canAnnotate}
                  style={{ width: '100%', resize: 'vertical', minHeight: 64, fontFamily: 'inherit', lineHeight: 1.5 }}
                />
              </div>
              {(submissionAtts.length > 0 || canEditSubmission) && (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="paperclip" size={12} /> {t('poSubmissionEvidenceTitle')}
                    <span style={{ fontWeight: 400, color: 'var(--fg-subtle)' }}>· {t('eoFilesNotProof')}</span>
                  </label>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {submissionAtts.map(a => (
                      <AttachmentChip
                        key={a.id}
                        a={a}
                        onRemove={canEditSubmission ? () => void proof.removeChatAtt(a) : undefined}
                      />
                    ))}
                    {canEditSubmission && (
                      <AttachmentDropzone
                        boxHint={t('poSubmitAttachHint')}
                        uploading={proof.chatUploading}
                        onFiles={files => void proof.addChatFiles(files)}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          ),
          activity: (
            <OrderActivityLog orderId={order.id} refreshKey={activityKey} events={events} className="oe-activity-tab" />
          ),
        }}
      </OrderTabs>

      <OrderFooter
        total={cost.total}
        fees={cost.fees}
        goodsOverridden={goodsOverridden}
        earnName={order.userName.split(' ')[0]}
        earn={purchaserEarn}
        dirtySections={[
          dirtyBy.products ? t('poReadyProducts') : null,
          dirtyBy.delivery ? t('eoTabDelivery') : null,
          dirtyBy.payment ? t('eoTabPayment') : null,
          dirtyBy.commission ? t('eoTabCommission') : null,
          dirtyBy.notes ? t('eoTabNotes') : null,
        ].filter((x): x is string => !!x)}
        stagePending={statusDirty ? status : null}
        onUndoStage={statusDirty ? () => setStatus(savedStatus) : null}
        retryablePhotos={retryablePhotos}
        onRetryPhotos={() => void retryQueuedPhotos()}
        retryDisabled={saving || photos.busy}
        onCancel={onCancel}
        onSave={attemptSave}
        saving={saving}
        saveTitle={saveBlockers[0]}
        locale={locale}
      />
      </div>

      {activeIdx !== null && lines[activeIdx] && (
        <LineDrawer
          // See DesktopSubmit: the drawer's per-line state (notably the
          // category-switch undo, which snapshots the whole line) must not
          // survive a move to another row.
          key={lines[activeIdx]._id ?? lines[activeIdx]._cid}
          line={lines[activeIdx]}
          idx={activeIdx}
          editing
          onChange={patch => updateLine(activeIdx, patch)}
          onClose={() => setActiveIdx(null)}
          onRemove={() => removeLine(activeIdx)}
          canRemove={lines.length > 1}
          onConfirmLine={() => confirmLine(activeIdx)}
          onConfirmError={showErrorDialog}
          duplicateOnLines={dupByIdx.get(activeIdx)}
          readOnly={!canEditOrder}
          missingFields={missingNamesFor(lines[activeIdx])}
          market={marketFor(lines[activeIdx].partNumber)}
          photoCtx={{
            orderId: order.id,
            // A line added in this session isn't persisted until Confirm line
            // or Save, so it has no id to hang a photo off yet — files picked
            // for it are buffered as local previews and uploaded when it lands.
            lineId: lines[activeIdx]._id ?? null,
            pending: photos.queuedFor(lines[activeIdx]._cid),
            onAddFiles: files => addLinePhotos(activeIdx, files),
            onRemovePending: p => photos.remove(lines[activeIdx]._cid, p),
            onRemoveSaved: photo => void removeLinePhoto(activeIdx, photo),
            busy: photos.busy,
          }}
        />
      )}

      {showDelete && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !deleting) setShowDelete(false); }}>
          <div className="modal-shell" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--neg-soft)', color: 'var(--neg)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="trash" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('deleteOrderTitle', { id: order.id })}</div>
                  <div className="modal-sub">
                    {t('eoDeleteSubFull')}
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <div className="field">
                <label className="label">
                  {t('dangerTypeToConfirmPrefix')} <span className="mono">{order.id}</span> {t('dangerTypeToConfirmSuffix')}
                </label>
                <input
                  className="input mono"
                  value={typedId}
                  onChange={e => setTypedId(e.target.value)}
                  placeholder={order.id}
                  autoFocus
                  disabled={deleting}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button
                className="btn"
                onClick={() => setShowDelete(false)}
                disabled={deleting}
              >
                {t('cancel')}
              </button>
              <button
                className="btn"
                style={{
                  background: 'var(--neg)', color: 'white', borderColor: 'var(--neg)',
                  opacity: deleting || typedId !== order.id ? 0.5 : 1,
                }}
                disabled={deleting || typedId !== order.id}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await deleteOrder(order.id);
                    onCancel();
                  } catch (e) {
                    handleFetchError(e);
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? '…' : t('deleteOrder')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showArchive && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !archiving) { setShowArchive(false); setArchiveConflict(null); } }}>
          <div className="modal-shell" style={{ maxWidth: archiveConflict ? 560 : 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  // Cool/violet tone — deliberately distinct from the destructive
                  // red of Delete. Archive is reversible; the colour should not
                  // alarm.
                  background: 'oklch(0.96 0.04 295)', color: 'oklch(0.45 0.16 295)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="box" size={18} />
                </div>
                <div>
                  <div className="modal-title">
                    {archiveConflict ? t('archiveConflictTitle') : t('eoArchiveModalTitle', { id: order.id })}
                  </div>
                  <div className="modal-sub">
                    {archiveConflict ? t('archiveConflictIntro', { id: order.id }) : t('eoArchiveModalBody')}
                  </div>
                </div>
              </div>
            </div>
            {archiveConflict && (
                <div className="modal-body" style={{ paddingTop: 0 }}>
                  <ArchiveConflictList conflict={archiveConflict} linkSellOrders />
                </div>
            )}
            <div className="modal-foot">
              <button
                className="btn"
                onClick={() => { setShowArchive(false); setArchiveConflict(null); }}
                disabled={archiving}
              >
                {t('cancel')}
              </button>
              <button
                className={archiveConflict ? 'btn' : 'btn accent'}
                style={archiveConflict ? { color: 'var(--neg)', borderColor: 'var(--neg)' } : undefined}
                disabled={archiving}
                onClick={async () => {
                  setArchiving(true);
                  try {
                    await archiveOrder(order.id, { removeFromSellOrders: !!archiveConflict });
                    onSaved(t('orderArchivedToast'));
                  } catch (e) {
                    const conflict = readArchiveConflict(e);
                    setArchiving(false);
                    if (conflict) { setArchiveConflict(conflict); return; }
                    handleFetchError(e);
                    setShowArchive(false);
                    setArchiveConflict(null);
                  }
                }}
              >
                {archiving ? '…' : archiveConflict ? t('archiveConflictConfirm') : t('archiveOrder')}
              </button>
            </div>
          </div>
        </div>
      )}

      {serialIssues && (
        <SerialCheckDialog issues={serialIssues} onClose={() => setSerialIssues(null)} />
      )}

      {dupConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !saving) setDupConfirm(null); }}>
          <div className="modal-shell" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="alert" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('dupPartModalTitle')}</div>
                  <div className="modal-sub">{t('dupPartModalSub')}</div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
                {dupConfirm.map(g => (
                  <li key={g.partNumber.toLowerCase()}>
                    {(g.lineNums.length === 1 ? t('dupPartModalRowOne') : t('dupPartModalRowMany'))
                      .replace('{pn}', g.partNumber)
                      .replace('{nums}', g.lineNums.join(', '))}
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDupConfirm(null)} disabled={saving}>
                {t('dupPartReview')}
              </button>
              <button
                className="btn primary"
                disabled={saving}
                onClick={async () => {
                  setDupConfirm(null);
                  if (!(await askRevert(materialDirty))) return;
                  await doSave();
                }}
              >
                {saving ? '…' : t('dupPartSaveAnyway')}
              </button>
            </div>
          </div>
        </div>
      )}

      {revertConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) revertConfirm(false); }}>
          <div className="modal-shell" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="rotate" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('revertWarnTitle')}</div>
                  <div className="modal-sub">{t('revertWarnBody')}</div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => revertConfirm(false)}>{t('cancel')}</button>
              <button className="btn primary" onClick={() => revertConfirm(true)}>
                {t('revertWarnConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRevert.length > 0 && (
        <RevertNoticeDialog
          orderId={order.id}
          changes={pendingRevert}
          onAcknowledged={() => { setPendingRevert([]); setActivityKey(k => k + 1); }}
          onDismiss={() => setPendingRevert([])}
        />
      )}

      {lightboxUrl && (
        <ImageLightbox url={lightboxUrl} alt={t('aiPhotoLabel')} onClose={() => setLightboxUrl(null)} />
      )}

      {handoffOpen && user && (
        <HandoffDialog
          init={{
            order,
            warehouseId,
            payment,
            paymentMethod,
            paypalTxnId: paypalTxn,
            proof,
            currentUser: { id: user.id, name: user.name },
          }}
          onCancel={() => setHandoffOpen(false)}
          onDone={() => {
            setHandoffOpen(false);
            setSavedStatus('In Transit');
            setStatus('In Transit');
            applyLifecycle('in_transit');
            setActivityKey(k => k + 1);
            // Land on the In Transit panel — the box's journey — rather than
            // back on the list.
            if (onReload) {
              window.__showToast?.(t('hoDone', { id: order.id }), 'success');
              void onReload();
              return;
            }
            onSaved(t('hoDone', { id: order.id }));
          }}
        />
      )}
      {doneDialogOpen && (
        <StatusChangeDialog
          orderId={order.id}
          to="Done"
          currentStatus={effectiveStatus}
          initialNote={doneNote}
          initialAttachments={doneAttachments}
          apiBase="/api/orders"
          variant="purchase"
          onCancel={() => setDoneDialogOpen(false)}
          onConfirm={({ note, attachments }) => {
            setDoneNote(note);
            setDoneAttachments(attachments);
            setDoneDialogOpen(false);
            setStatus('Done');
          }}
          onMutated={() => setActivityKey(k => k + 1)}
        />
      )}
    </>
  );
}

// ─── Conversion helpers ──────────────────────────────────────────────────────
function orderLineToEditLine(l: OrderLine): EditLine {
  return {
    _cid:           crypto.randomUUID(),
    _id:            l.id,
    _status:        l.status,
    category:       l.category,
    photos:         l.photos ?? [],
    brand:          l.brand ?? undefined,
    capacity:       l.capacity ?? undefined,
    type:           l.type ?? undefined,
    generation:     l.generation ?? undefined,
    classification: l.classification ?? undefined,
    rank:           l.rank ?? undefined,
    speed:          l.speed ?? undefined,
    interface:      l.interface ?? undefined,
    formFactor:     l.formFactor ?? undefined,
    description:    l.description ?? undefined,
    itemType:      l.itemType ?? undefined,
    partNumber:     l.partNumber ?? undefined,
    serialNumber:   l.serialNumber ?? undefined,
    chipNumber:     l.chipNumber ?? undefined,
    condition:      l.condition,
    qty:            l.qty,
    // An unpriced line (purchaser raised it, manager prices it at Reviewing)
    // opens the drawer blank rather than with a 0 to clear first.
    unitCost:       l.unitCost || '',
    sellPrice:      l.sellPrice ?? undefined,
    scanImageId:    l.scanImageId ?? undefined,
    scanImageUrl:   l.scanImageUrl ?? undefined,
    health:         l.health,
    rpm:            l.rpm,
  };
}

function editLineToPatch(l: EditLine, status?: string) {
  const sp = l.sellPrice;
  return {
    id:             l._id!,
    status,
    // Sent so a recategorisation made in the drawer survives Save. Without it
    // the backend keeps the stored category and silently drops the change.
    category:       l.category,
    sellPrice:      sp == null || sp === '' ? null : Number(sp),
    qty:            Number(l.qty) || 0,
    unitCost:       Number(l.unitCost) || 0,
    brand:          l.brand ?? null,
    capacity:       l.capacity ?? null,
    type:           l.type ?? null,
    generation:     l.generation ?? null,
    classification: l.classification ?? null,
    rank:           l.rank ?? null,
    speed:          l.speed ?? null,
    interface:      l.interface ?? null,
    formFactor:     l.formFactor ?? null,
    description:    l.description ?? null,
    itemType:      l.itemType ?? null,
    partNumber:     l.partNumber ?? null,
    serialNumber:   l.serialNumber ?? null,
    chipNumber:     l.chipNumber ?? null,
    condition:      l.condition,
    health:         l.health ?? null,
    rpm:            l.rpm ?? null,
    // A scan performed in the drawer must survive Save; null keeps the stored
    // value (the backend applies these with COALESCE, like every field here).
    scanImageId:    l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  };
}

function editLineToInsert(l: EditLine, status: string) {
  const sp = l.sellPrice;
  return {
    category:       l.category,
    status,
    sellPrice:      sp == null || sp === '' ? null : Number(sp),
    qty:            Number(l.qty) || 0,
    unitCost:       Number(l.unitCost) || 0,
    brand:          l.brand ?? null,
    capacity:       l.capacity ?? null,
    type:           l.type ?? null,
    generation:     l.generation ?? null,
    classification: l.classification ?? null,
    rank:           l.rank ?? null,
    speed:          l.speed ?? null,
    interface:      l.interface ?? null,
    formFactor:     l.formFactor ?? null,
    description:    l.description ?? null,
    itemType:      l.itemType ?? null,
    partNumber:     l.partNumber ?? null,
    serialNumber:   l.serialNumber ?? null,
    chipNumber:     l.chipNumber ?? null,
    condition:      l.condition,
    health:         l.health ?? null,
    rpm:            l.rpm ?? null,
    scanImageId:    l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  };
}
