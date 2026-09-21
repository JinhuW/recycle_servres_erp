import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { ImageLightbox } from '../components/ImageLightbox';
import { OrderActivityLog } from '../components/OrderActivityLog';
import { PhFold, type PhFoldMark } from '../components/PhFold';
import { PhCommissionFields, PhCommissionSheet } from '../components/PhCommissionSheet';
import { RevertNoticeDialog } from '../components/RevertNoticeDialog';
import { StatusChangeDialog } from '../components/StatusChangeDialog';
import { PhHandoffSheet } from '../components/PhHandoffSheet';
import { AttachmentChip } from '../components/AttachmentChip';
import { AttachmentDropzone } from '../components/AttachmentDropzone';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { useEffectiveUser } from '../lib/tweaks';
import { api, deleteOrder, archiveOrder, unarchiveOrder } from '../lib/api';
import { readArchiveConflict, type ArchiveConflict } from '../lib/archiveConflict';
import { ArchiveConflictList } from '../components/ArchiveConflictList';
import { navigate, poProductsPath, type PoScreen } from '../lib/route';
import { OrderProductsBody, itemLabel } from './OrderProductsBody';
import { handleFetchError, showErrorDialog } from '../lib/errorToast';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import { profitTone } from '../lib/orderPresentation';
import { isPricedSellPrice } from '@recycle-erp/shared';
import { poEffectiveCost, parseFeeInput } from '../lib/poTotals';
import type { HandoffDelivery, HandoffMethod } from '../lib/handoff';
import { NEED_SHORT_KEY, poReadiness } from '../lib/poReadiness';
import { resolveTracking } from '../lib/useTrackingInput';
import { CARRIERS, type Carrier } from '../lib/carrierDetect';
import { PACKAGE_SOURCES, packageSourceLabelKey, type PackageSource } from '../lib/packageSource';
import { FMT_HINT_KEY } from '../lib/useAddPackageForm';
import { refreshPackage } from '../lib/packages';
import { lookbackFacts, type StageId } from '../lib/orderLookback';
import { LIFECYCLE_LABEL } from '../lib/orderPresentation';
import { PackageJourney } from './desktop/PackageJourney';
import { fmtDate } from '../lib/format';
import { useOrderEvents } from '../lib/useOrderEvents';
import { ApiError } from '../lib/api';
import { usePaymentProof, type ProofAttachment } from '../lib/usePaymentProof';
import { PaymentFields } from '../components/PaymentFields';
import { CommissionPaymentFields, type CommissionShots } from '../components/CommissionPaymentFields';
import {
  ORDER_STATUSES, LIFECYCLE_STATUS, statusTone, spineStatus, isClosedBook, warehouseGateLockedStatuses,
} from '../lib/status';
import { addableCategories, categoryTone } from '../lib/lookups';
import type { Category, Order, Warehouse } from '../lib/types';
import { loadWarehouses } from '../lib/warehouses';

/**
 * The order-level edits in flight on this screen. They live in the shell, not
 * here: opening a line form unmounts this component, and a fee typed for the
 * very line being added must not go with it. `version` is the server state
 * they were made against — edits are dropped once the server moves on.
 */
export type OrderMetaDraft = {
  version: string;
  warehouseId: string;
  payment: 'company' | 'self';
  paymentMethod: HandoffMethod | null;
  paypalTxnId: string;
  notes: string;
  fees: { amount: string; note: string };
  // The hand-off facts, the Delivery fold's to edit until Ready to Pay. The
  // tracking number is kept raw with its manual carrier pick; the carrier is
  // derived the way the checkpoint derives it (lib/useTrackingInput.ts).
  source: PackageSource | null;
  delivery: HandoffDelivery | null;
  byUserId: string;
  tracking: { raw: string; pick: Carrier | null };
  // The Commission fold's, a manager's to edit until Ready to Pay. The rate
  // is kept as the typed percentage; '' is "no rate", saved as null.
  ownerId: string;
  commissionPct: string;
};

type FoldId = 'delivery' | 'payment' | 'commission' | 'notes' | 'activity';
// The fold a stage is about; the others start closed.
const STAGE_FOLD: Record<string, FoldId> = { 'In Transit': 'delivery', 'Ready to Pay': 'commission' };

type Props = {
  order: Order;
  /**
   * Which of the PO's two phone screens to show. One instance renders both
   * — the shell keeps the element in place across the switch — so the order
   * copy, the unsaved fields and the once-per-visit revert warning carry
   * over instead of each screen starting from a stale prop.
   */
  section: PoScreen;
  /** Unsaved order-level edits carried across trips into the line form. */
  meta: OrderMetaDraft | null;
  onMetaChange: Dispatch<SetStateAction<OrderMetaDraft | null>>;
  onCancel: () => void;
  onSaved: (msg: string) => void;
  onDeleted: () => void;
  /** Opens the line form on an existing line. Returns here when it closes. */
  onEditLine: (order: Order, idx: number) => void;
  onAddLine: (order: Order, cat: Category) => void;
};

export function OrderDetail({
  order: initialOrder, section, meta: metaDraft, onMetaChange,
  onCancel, onSaved, onDeleted, onEditLine, onAddLine,
}: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const { user } = useAuth();
  const [order, setOrder] = useState<Order>(initialOrder);
  useEffect(() => { setOrder(initialOrder); }, [initialOrder]);

  const isPurchaser = user?.role !== 'manager';
  // The final-sell row follows the role-preview tweak, like the API does.
  const showFinalSell = useEffectiveUser()?.role === 'manager';
  const effectiveStatus = LIFECYCLE_STATUS[order.lifecycle] ?? order.status;
  // Locked from Ready to Pay on: the review is over and the figure is what
  // the purchaser gets paid on.
  // An archived order is locked too: its lines are out of stock, and every
  // write the backend would take is refused until it is unarchived.
  const isArchived = !!order.archivedAt;
  const orderLocked = isClosedBook(effectiveStatus) || isArchived;
  // The purchaser keeps their order until it is Done. Past Draft the edit
  // costs them the stage: the backend sends the order back to Draft, so
  // `revertOnSave` warns before the first write that does it.
  const canEditOrder = !orderLocked;
  const revertOnSave = isPurchaser && !orderLocked && effectiveStatus !== 'Draft';
  // A reverted order is a Draft again but not a fresh one — once submitted it
  // is archived, never deleted (the backend enforces the same).
  const canDelete = canEditOrder && effectiveStatus === 'Draft' && !order.everSubmitted;
  // The note outlives the purchaser's edit window — the manager owns pricing
  // from Reviewing on, but whoever raised the PO keeps documenting it until
  // Done. Mirrors the backend's notes-only gate.
  const isOwnerOrManager = !isPurchaser || order.userId === user?.id;
  const canAnnotate = !orderLocked && isOwnerOrManager;

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  // What the server says the order's meta is, as one comparable string. The
  // backend rebuilds `statusMeta` as a fresh object on every response, so its
  // identity changes when nothing did — keying anything on it wiped the fields
  // the user was typing into on every refetch.
  const serverVersion = JSON.stringify([
    order.id,
    order.warehouse?.id ?? '',
    order.payment,
    order.paymentMethod ?? '',
    order.paypalTxnId ?? '',
    order.notes ?? '',
    order.otherFees,
    order.otherFeesNote ?? '',
    order.source ?? '',
    order.handoffMethod ?? '',
    order.handoffBy?.id ?? '',
    order.package?.trackingNumber ?? '',
    order.userId,
    order.commissionRate ?? '',
    ...(order.statusMeta?.['Submission']?.attachments ?? []).map(a => a.id),
    ...(order.statusMeta?.['Payment']?.attachments ?? []).map(a => a.id),
    ...(order.statusMeta?.['Commission']?.attachments ?? []).map(a => a.id),
  ]);
  // Edits made against an older server state are stale: the order moved on, so
  // the fields show what it now holds.
  const currentMeta = (draft: OrderMetaDraft | null): OrderMetaDraft =>
    draft?.version === serverVersion ? draft : {
      version: serverVersion,
      warehouseId: order.warehouse?.id ?? '',
      payment: order.payment,
      paymentMethod: order.paymentMethod ?? null,
      paypalTxnId: order.paypalTxnId ?? '',
      notes: order.notes ?? '',
      fees: {
        amount: order.otherFees ? order.otherFees.toFixed(2) : '',
        note: order.otherFeesNote ?? '',
      },
      source: order.source ?? null,
      delivery: order.handoffMethod ?? null,
      byUserId: order.handoffBy?.id ?? '',
      tracking: {
        raw: order.handoffMethod === 'label' ? order.package?.trackingNumber ?? '' : '',
        pick: order.handoffMethod === 'label' ? (order.package?.carrier as Carrier | undefined) ?? null : null,
      },
      ownerId: order.userId,
      commissionPct: order.commissionRate != null ? String(+(order.commissionRate * 100).toFixed(2)) : '',
    };
  const meta = currentMeta(metaDraft);
  const { warehouseId, payment, paymentMethod, paypalTxnId, notes, fees, source, delivery, byUserId, ownerId, commissionPct } = meta;
  const tracking = resolveTracking(meta.tracking.raw, meta.tracking.pick);
  // Merged into the draft as it stands, not the one this render saw: the
  // PayPal screenshot scan writes its id seconds later, and notes typed in
  // the meantime would otherwise be reverted by it.
  const setMeta = (patch: Partial<OrderMetaDraft>) =>
    onMetaChange(prev => ({ ...currentMeta(prev), ...patch }));
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  // Which lines have their whole photo row open. Collapsed, a line shows the
  // first few and says how many more there are.
  const [expandedPhotos, setExpandedPhotos] = useState<ReadonlySet<string>>(() => new Set());
  const [removingLineId, setRemovingLineId] = useState<string | null>(null);
  // Holds the answer callback while the "this returns the order to Draft"
  // warning is up; acknowledging once covers the rest of the visit.
  const [revertConfirm, setRevertConfirm] = useState<((ok: boolean) => void) | null>(null);
  const [revertAcked, setRevertAcked] = useState(false);
  const [pendingRevert, setPendingRevert] = useState(initialOrder.pendingRevert ?? []);
  // MobileApp swaps one order for another in place rather than remounting this
  // screen, so seeding from the initial prop alone leaves order A's change set
  // on screen under order B — and "Got it" then acks B, clearing changes nobody
  // read. The revert acknowledgement is per-visit and doesn't carry over either.
  useEffect(() => {
    setPendingRevert(initialOrder.pendingRevert ?? []);
    setRevertAcked(false);
  }, [initialOrder]);
  const [saving, setSaving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [doneDialogOpen, setDoneDialogOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [commissionOpen, setCommissionOpen] = useState(false);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [showDelete, setShowDelete] = useState(false);
  const [typedId, setTypedId] = useState('');
  const [deleting, setDeleting] = useState(false);
  // The payment proof — chat (Submission), cash screenshot (Payment) and
  // commission screenshot (Commission) attachments plus the PayPal scan —
  // shared with the hand-off sheet.
  const proof = usePaymentProof({
    orderId: order.id,
    chatAtts: order.statusMeta?.['Submission']?.attachments ?? [],
    proofAtts: order.statusMeta?.['Payment']?.attachments ?? [],
    commissionAtts: order.statusMeta?.['Commission']?.attachments ?? [],
    setTxnId: v => setMeta({ paypalTxnId: v }),
  });
  const submissionAtts = proof.chatAtts;
  // The commission screenshot as the fold and the Done dialog both see it —
  // one store, so a file attached in either shows in the other. Writes
  // through, so it sits outside the meta draft and its dirty flags.
  const commissionShots: CommissionShots = {
    atts: proof.commissionAtts,
    uploading: proof.commissionUploading,
    add: files => void proof.addCommissionFiles(files).then(() => setActivityRefreshKey(k => k + 1)),
    remove: att => void proof.removeCommissionAtt(att).then(() => setActivityRefreshKey(k => k + 1)),
  };

  // Archive (mobile): owner-or-manager, non-Draft. No type-to-confirm —
  // archive is reversible so we keep the gesture short, matching the
  // platform's "one tap, one sheet" rhythm.
  // Mirrors the backend: a reverted order is a Draft that HAS been submitted,
  // and Delete refuses exactly those — so Archive has to take it, or the order
  // offers neither. Unarchiving is always available once archived.
  const canArchive = isOwnerOrManager
    && (isArchived || effectiveStatus !== 'Draft' || !!order.everSubmitted);
  const [showArchive, setShowArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // The archive endpoint's answer when stock sits on open sell orders: the
  // modal turns into that question until the user confirms or cancels.
  const [archiveConflict, setArchiveConflict] = useState<ArchiveConflict | null>(null);

  // Re-read the evidence list when the server's own version of it moves —
  // never on a mere refetch that returned the same thing.
  useEffect(() => {
    proof.sync(
      order.statusMeta?.['Submission']?.attachments ?? [],
      order.statusMeta?.['Payment']?.attachments ?? [],
      order.statusMeta?.['Commission']?.attachments ?? [],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverVersion]);

  useEffect(() => {
    let alive = true;
    loadWarehouses()
      .then(items => { if (alive) setWarehouses(items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);
  // Every role may pick a collector — the names list, as the hand-off uses.
  const [memberNames, setMemberNames] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let alive = true;
    api.get<{ items: { id: string; name: string }[] }>('/api/members/names')
      .then(r => { if (alive) setMemberNames(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  const totals = useMemo(() => {
    let qty = 0, cost = 0, margin = 0, revenue = 0, priced = 0;
    for (const l of order.lines) {
      qty += l.qty;
      cost += l.qty * l.unitCost;
      // Priced lines only, the way the PO list's Profit column counts it.
      if (isPricedSellPrice(l.sellPrice)) {
        priced += 1;
        revenue += l.qty * Number(l.sellPrice);
        margin += l.qty * (Number(l.sellPrice) - l.unitCost);
      }
    }
    return { qty, cost, margin, revenue, priced };
  }, [order.lines]);

  // Reads the fee being typed, not the saved one, so the total tracks the box.
  const feesValue = parseFeeInput(fees.amount);
  const cost = poEffectiveCost({
    lineSubtotal: totals.cost,
    totalCostOverride: order.totalCost,
    otherFees: feesValue,
  });

  const notesDirty = (notes || '') !== (order.notes || '');
  const warehouseDirty = (warehouseId || '') !== (order.warehouse?.id ?? '');
  const paymentDirty = payment !== order.payment;
  // Only a company order carries a method; the server clears it on a flip to
  // self, so the local value is not a change until the order is company again.
  const methodDirty = payment === 'company' && paymentMethod !== (order.paymentMethod ?? null);
  const paypalDirty = paypalTxnId !== (order.paypalTxnId ?? '');
  const feesDirty =
    feesValue !== (order.otherFees ?? 0) ||
    (fees.note.trim() || null) !== (order.otherFeesNote || null);
  const sourceDirty = (source ?? '') !== (order.source ?? '');
  const deliveryDirty = (delivery ?? '') !== (order.handoffMethod ?? '');
  const byUserDirty = delivery === 'pickup' && byUserId !== (order.handoffBy?.id ?? '');
  const trackingDirty = delivery === 'label' && tracking.tn !== ''
    && (tracking.tn !== (order.package?.trackingNumber ?? '') || (tracking.carrier ?? '') !== (order.package?.carrier ?? ''));
  const facts = sourceDirty || deliveryDirty || byUserDirty || trackingDirty;
  // Manager-only fields; a purchaser's copy never counts as a change. A
  // blank rate and a saved null are the same thing, as on the desktop page.
  const ownerDirty = !isPurchaser && ownerId !== order.userId;
  const parsedPct = commissionPct.trim() === '' ? null : Number(commissionPct);
  const commissionRateValue = parsedPct === null || !Number.isFinite(parsedPct) ? null : parsedPct / 100;
  const commissionDirty = !isPurchaser && (parsedPct === null || Number.isFinite(parsedPct))
    && (commissionRateValue ?? 0) !== (order.commissionRate ?? 0);
  const commission = ownerDirty || commissionDirty;
  const dirty = notesDirty || warehouseDirty || paymentDirty || methodDirty || paypalDirty || feesDirty || facts || commission;

  const refetchOrder = async () => {
    try {
      const r = await api.get<{ order: Order }>(`/api/orders/${order.id}`);
      setOrder(r.order);
    } catch (e) {
      // Refetch is best-effort after a save; the save toast already confirmed
      // the write succeeded. Surface refetch failures so the user knows the
      // on-screen state may be stale.
      handleFetchError(e);
    }
  };

  // A purchaser's first write to a submitted order costs it the stage. Ask
  // once per visit, then let the rest of the visit through.
  const askRevert = (): Promise<boolean> => {
    if (!revertOnSave || revertAcked) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      setRevertConfirm(() => (ok: boolean) => {
        setRevertConfirm(null);
        if (ok) setRevertAcked(true);
        resolve(ok);
      });
    });
  };

  // The line editor is a different screen and writes straight through when it
  // saves, so the warning has to happen here — before the purchaser starts.
  // Nothing on the capture side has a dialog to raise.
  const editLine = async (i: number) => {
    if (!(await askRevert())) return;
    onEditLine(order, i);
  };
  const addLine = async (cat: Category) => {
    if (!(await askRevert())) return;
    onAddLine(order, cat);
  };

  const save = async () => {
    if (!canAnnotate) return;
    // A note is not a change to the order itself and leaves the stage alone.
    const material = warehouseDirty || paymentDirty || methodDirty || paypalDirty || feesDirty || facts || commission;
    if (material && !(await askRevert())) return;
    setSaving(true);
    try {
      // Only what changed. Sending a field the user didn't touch is how the
      // old review screen wrote its blank defaults over a saved order; past
      // the purchaser's edit window it would also trip the backend's 403,
      // since only the note stays theirs to change.
      // No totalCost: the goods figure is derived from the lines.
      await api.patch(`/api/orders/${order.id}`, canEditOrder ? {
        notes:         notesDirty     ? notes                       : undefined,
        warehouseId:   warehouseDirty ? (warehouseId || null)       : undefined,
        payment:       paymentDirty   ? payment                     : undefined,
        paymentMethod: methodDirty    ? paymentMethod               : undefined,
        paypalTxnId:   paypalDirty    ? (paypalTxnId || null)       : undefined,
        otherFees:     feesDirty      ? feesValue                   : undefined,
        otherFeesNote: feesDirty      ? (fees.note.trim() || null)  : undefined,
        source:        sourceDirty    ? source                      : undefined,
        handoffMethod: deliveryDirty  ? delivery                    : undefined,
        handoffBy:     byUserDirty || (deliveryDirty && delivery === 'pickup') ? (byUserId || null) : undefined,
        ...(trackingDirty && tracking.carrier
          ? { trackingNumber: tracking.tn, carrier: tracking.carrier }
          : {}),
        onBehalfOfUserId: ownerDirty ? ownerId : undefined,
        commissionRate: commissionDirty ? commissionRateValue : undefined,
      } : { notes });
      await refetchOrder();
      setActivityRefreshKey(k => k + 1);
      onSaved(t('savedShort'));
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Line removal commits immediately — there is no Submit step on an order
  // that already exists. The backend 409s when a sell order has claimed the
  // line, which is the one case the user needs told about.
  const removeLine = async (lineId: string) => {
    setRemovingLineId(null);
    if (!(await askRevert())) return;
    try {
      await api.patch(`/api/orders/${order.id}`, { removeLineIds: [lineId] });
      await refetchOrder();
      setActivityRefreshKey(k => k + 1);
      onSaved(t('lineRemoved'));
    } catch (e) {
      handleFetchError(e);
    }
  };

  // Submitting is the purchaser's one stage move — everything past it belongs
  // to the manager, and the backend rejects the rest from them anyway. Into
  // Reviewing and Ready to Pay it has to be the warehouse's own manager; the
  // button here posts against the saved warehouse, so the gate reads that.
  const gateWarehouse = warehouses.find(w => w.id === order.warehouse?.id);
  const gateLocked = isPurchaser ? [] : warehouseGateLockedStatuses(effectiveStatus, gateWarehouse, user?.id);
  const nextStatus: string | null = (() => {
    if (isArchived) return null;
    if (effectiveStatus === 'Draft') return 'In Transit';
    if (isPurchaser) return null;
    const i = ORDER_STATUSES.indexOf(spineStatus(effectiveStatus) as typeof ORDER_STATUSES[number]);
    const next = i >= 0 ? ORDER_STATUSES[i + 1] ?? null : null;
    return next && !gateLocked.includes(next) ? next : null;
  })();
  const canAdvance = !!nextStatus && !advancing && !saving;

  const doAdvance = async () => {
    setAdvancing(true);
    try {
      await api.post(`/api/orders/${order.id}/advance`, {});
      await refetchOrder();
      setActivityRefreshKey(k => k + 1);
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('advanceFailed'));
    } finally {
      setAdvancing(false);
    }
  };

  const advance = async () => {
    if (!canAdvance) return;
    // Leaving Draft is the hand-off sheet's job: how the goods get here and
    // who paid, saved and advanced in one call. It is seeded from the fields
    // on screen, so an edit typed here is what it writes.
    if (effectiveStatus === 'Draft') {
      // The cost lives on this page, not in the sheet, so it is asked for
      // here; the server refuses a $0 PO as well. Only on the first
      // submission: a PO an edit sent back to Draft re-submits as it was
      // accepted.
      if (!(cost.goods > 0) && !order.everSubmitted) {
        showErrorDialog(t('poCostRequired'), undefined, t('errCantSubmitTitle'));
        return;
      }
      setHandoffOpen(true);
      return;
    }
    // Ready to Pay fixes the commission, so the manager confirms it on the
    // way in — the sheet saves the fields and then advances.
    if (nextStatus === 'Ready to Pay') { setCommissionOpen(true); return; }
    // Done asks for the commission screenshot first — unless one is already
    // on file, in which case the move is as plain as any other. Confirming in
    // the dialog fires the actual advance.
    if (nextStatus === 'Done' && proof.commissionAtts.length === 0) { setDoneDialogOpen(true); return; }
    await doAdvance();
  };

  // The commission sheet's Confirm: write the fields if they changed, then
  // move the stage. A failed write leaves the sheet up with the error.
  const confirmCommission = async () => {
    setAdvancing(true);
    try {
      if (commission) {
        await api.patch(`/api/orders/${order.id}`, {
          onBehalfOfUserId: ownerDirty ? ownerId : undefined,
          commissionRate: commissionDirty ? commissionRateValue : undefined,
        });
      }
      await api.post(`/api/orders/${order.id}/advance`, {});
      setCommissionOpen(false);
      await refetchOrder();
      setActivityRefreshKey(k => k + 1);
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('advanceFailed'));
    } finally {
      setAdvancing(false);
    }
  };

  // Uploads through the proof hook; the activity log is nudged here because
  // the hook does not know this page has one.
  const addSubmissionFiles = async (fl: FileList | null) => {
    await proof.addChatFiles(fl);
    setActivityRefreshKey(k => k + 1);
  };
  const removeSubmissionAtt = async (att: ProofAttachment) => {
    await proof.removeChatAtt(att);
    setActivityRefreshKey(k => k + 1);
  };

  const removeDoneAtt = async (attachmentId: string) => {
    try {
      await api.delete(`/api/orders/${order.id}/status-meta/Done/attachments/${attachmentId}`);
      await refetchOrder();
      setActivityRefreshKey(k => k + 1);
    } catch {
      // Chip stays; the next interaction resurfaces the state.
    }
  };

  const doneMeta = order.statusMeta?.['Done'];

  const itemsUnits = `${order.lines.length} ${order.lines.length === 1 ? t('item') : t('items')} · ${totals.qty} ${totals.qty === 1 ? t('unit') : t('units2')}`;
  // The id is the title on both screens: it is what the purchaser searched
  // for and what they will say out loud. The stage sits under it, with
  // "locked" spelled out where the page used to hide the id behind "View
  // order (locked)".
  const headerTitle = section === 'products' ? `${t('products')} · ${order.lines.length}` : order.id;
  const headerSub = section === 'products'
    ? `${order.id} · ${totals.qty} ${totals.qty === 1 ? t('unit') : t('units2')}`
    : orderLocked ? `${effectiveStatus} · ${t('poLockedShort')}` : `${effectiveStatus} · ${itemsUnits}`;
  const unpricedCount = order.lines.filter(l => !isPricedSellPrice(l.sellPrice)).length;

  // What the Delivery fold reads back when closed, and what the readiness
  // row says when it is met.
  const collectorName = memberNames.find(m => m.id === byUserId)?.name ?? order.handoffBy?.name ?? null;
  const whShort = warehouses.find(w => w.id === warehouseId)?.short ?? order.warehouse?.short ?? null;
  const deliverySummary = [
    source ? t(packageSourceLabelKey(source)) : null,
    whShort,
    delivery === 'pickup' ? [t('hoPickup'), collectorName].filter(Boolean).join(' · ')
      : delivery === 'label' ? [tracking.carrier, tracking.tn].filter(Boolean).join(' ') : null,
  ].filter(Boolean).join(' · ') || t('poDeliveryUnset');

  // What still stands between a Draft and Submit, from the one readiness
  // rule every surface shares (lib/poReadiness.ts) so this list, the desktop
  // panel and the checkpoint can never disagree. The sheet's own questions
  // (how the goods arrive) are stubbed as answered here: this screen has no
  // delivery fields yet, so only the products and payment sections can fire.
  // Reads the fields as typed, not as saved.
  const readiness: { key: string; met: boolean; label: string; target: 'products' | 'delivery' | 'payment' }[] =
    effectiveStatus === 'Draft' && !isArchived ? (() => {
      const items = poReadiness({
        rules: {
          source, delivery, trackingValid: tracking.valid, carrier: tracking.carrier,
          paidBy: payment, method: paymentMethod, txnId: paypalTxnId,
          chatAttachmentCount: proof.chatAtts.length,
          proofAttachmentCount: proof.proofAtts.length,
          saved: order,
        },
        lines: { count: order.lines.length, goods: cost.goods, everSubmitted: order.everSubmitted === true },
        serverBlockers: order.blockers,
        dirty: { delivery: warehouseDirty || facts, payment: paymentDirty || methodDirty || paypalDirty },
      });
      const products = items.find(i => i.tab === 'products')!;
      const deliveryItem = items.find(i => i.tab === 'delivery')!;
      const blockers = new Set(items.find(i => i.tab === 'payment')!.needKeys);
      const rows: typeof readiness = [{
        key: 'products', met: products.ok, target: 'products',
        label: products.ok
          ? `${order.lines.length} ${order.lines.length === 1 ? t('item') : t('items')} · ${fmtUSD(cost.goods, locale)}`
          : t(products.needKeys[0]),
      }, {
        key: 'delivery', met: deliveryItem.ok, target: 'delivery',
        label: deliveryItem.ok
          ? deliverySummary
          : t('eoNeeds', { what: deliveryItem.needKeys.map(k => t(NEED_SHORT_KEY[k] ?? k)).join(', ') }),
      }];
      // A rule the saved order is exempt from (pre-cutoff) with nothing on
      // file is neither met nor missing — it has no row.
      const paymentRow = (key: string, metLabel: string | null) => {
        if (blockers.has(key)) rows.push({ key, met: false, target: 'payment', label: t(key) });
        else if (metLabel) rows.push({ key, met: true, target: 'payment', label: metLabel });
      };
      const files = (n: number) => n > 0 ? t('poReadyFiles', { n }) : null;
      if (payment === 'company') {
        paymentRow('hoNeedMethod', paymentMethod === 'cash' ? t('hoMethodCash') : t('hoMethodPaypal'));
        if (paymentMethod === 'paypal') paymentRow('poTxnRequired', paypalTxnId.trim() || null);
        if (paymentMethod === 'cash') paymentRow('hoNeedCashShot', files(proof.proofAtts.length));
      } else {
        paymentRow('hoNeedChatShot', files(proof.chatAtts.length));
      }
      return rows;
    })() : [];
  // Which fold is open. The stage picks one to start with — the twin of the
  // desktop's tab suggestion: Draft opens the first section the hand-off is
  // waiting on, In Transit the shipment's, Ready to Pay the commission it
  // fixed — and picks again when the stage moves. Any fold can still be
  // opened by hand; the suggestion never overrides a toggle already made.
  const stageFold = (): FoldId | null => {
    if (effectiveStatus === 'Draft') {
      const first = readiness.find(r => !r.met && r.target !== 'products')?.target;
      return first === 'delivery' || first === 'payment' ? first : null;
    }
    return STAGE_FOLD[effectiveStatus] ?? null;
  };
  const [openFold, setOpenFold] = useState<FoldId | null>(stageFold);
  const seenStatus = useRef(effectiveStatus);
  useEffect(() => {
    if (seenStatus.current === effectiveStatus) return;
    seenStatus.current = effectiveStatus;
    setOpenFold(stageFold());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveStatus]);
  const toggleFold = (id: FoldId) => setOpenFold(o => o === id ? null : id);
  // A readiness row opens the fold and lands on its first field; the fold
  // has to be open before the scroll can find anything.
  const showFold = (id: FoldId) => {
    setOpenFold(id);
    requestAnimationFrame(() => {
      const el = id === 'payment'
        ? document.getElementById('ph-paidby') ?? document.getElementById('ph-txn')
        : document.getElementById(`ph-fold-${id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: id === 'payment' ? 'center' : 'start' });
    });
  };
  const paymentSummary = payment === 'self'
    ? t('paySelfShort')
    : [t('payCompanyShort'), paymentMethod === 'cash' ? t('hoMethodCash') : paymentMethod === 'paypal' ? t('hoMethodPaypal') : null, paypalTxnId.trim() || null]
        .filter(Boolean).join(' · ');
  // The owner select must be able to show the order as-is even when its
  // owner has left the member list, as the desktop's does.
  const ownerOptions = useMemo(() => {
    const opts = [...memberNames];
    if (!opts.some(m => m.id === order.userId)) opts.unshift({ id: order.userId, name: order.userName ?? order.userId });
    return opts;
  }, [memberNames, order.userId, order.userName]);
  const commissionSummary = [
    ownerOptions.find(o => o.id === ownerId)?.name ?? order.userName,
    commissionPct.trim() === '' ? null : `${commissionPct}%`,
    proof.commissionAtts.length > 0 ? t('cpPaid') : null,
  ].filter(Boolean).join(' · ');
  const notesSummary = [
    notes.trim() ? notes.trim().split('\n')[0] : t('phNoNotes'),
    submissionAtts.length > 0 ? t('poReadyFiles', { n: submissionAtts.length }) : null,
  ].filter(Boolean).join(' · ');
  const commissionMath = {
    payment, revenue: totals.revenue, totalCost: cost.total,
    pricedCount: totals.priced, lineCount: order.lines.length,
  };
  const canEditCommission = !isPurchaser && canEditOrder;
  // The fold marks: amber where the hand-off is still waiting, blue where an
  // edit is unsaved — the desktop tabs' two dots.
  const needs = (id: FoldId) => readiness.some(r => r.target === id && !r.met);
  const markFor = (id: FoldId, isDirty: boolean): PhFoldMark => needs(id) ? 'need' : isDirty ? 'dirty' : null;

  // The enabled set, not the fixed four: a fifth category has to reach the
  // dock too, and a single docked row cannot wrap to hold it.
  const cats = addableCategories();

  const currentIdx = ORDER_STATUSES.indexOf(spineStatus(effectiveStatus) as typeof ORDER_STATUSES[number]);
  // The furthest dot this user could reach: purchasers stop at In Transit,
  // a manager held by the warehouse gate stops just short of it.
  const canReachIdx = isPurchaser
    ? (effectiveStatus === 'Draft' ? ORDER_STATUSES.indexOf('In Transit') : currentIdx)
    : gateLocked.length ? ORDER_STATUSES.indexOf(gateLocked[0]) - 1 : ORDER_STATUSES.length - 1;
  // A finished dot, tapped, swaps the card's body for what that stage
  // recorded; the stage moving snaps it back.
  const [view, setView] = useState<string | null>(null);
  useEffect(() => { setView(null); }, [effectiveStatus]);
  const viewStageId = view === null ? null
    : (Object.keys(LIFECYCLE_LABEL).find(k => LIFECYCLE_LABEL[k] === view) as StageId | undefined) ?? null;
  const events = useOrderEvents(order.id, activityRefreshKey);
  // The linked box, kept locally so a Refresh replaces it without a refetch.
  const [pkg, setPkg] = useState(order.package ?? null);
  useEffect(() => { setPkg(order.package ?? null); }, [order.package]);
  const [refreshState, setRefreshState] = useState<'idle' | 'busy' | { error: string }>('idle');
  const refreshPkg = async () => {
    if (!pkg) return;
    setRefreshState('busy');
    try {
      const r = await refreshPackage(pkg.id);
      setPkg({ ...pkg, ...r.package, trackingStatus: r.package.trackingStatus ?? pkg.trackingStatus });
      setRefreshState('idle');
    } catch (e) {
      setRefreshState({ error: e instanceof ApiError && e.status === 501 ? e.message : t('poPkgRefreshFailed') });
    }
  };

  return (
    <div className="phone-app">
      <PhHeader
        title={headerTitle}
        sub={headerSub}
        leading={<button className="ph-icon-btn" onClick={onCancel} aria-label={t('back')}><Icon name="chevronLeft" size={16} /></button>}
      />
      {section === 'products' && (
        <>
          <div className="ph-scroll" style={{ paddingTop: 12, paddingBottom: canEditOrder ? 168 : 110 }}>
            <OrderProductsBody
              order={order}
              canEditOrder={canEditOrder}
              showFinalSell={showFinalSell}
              locale={locale}
              expandedPhotos={expandedPhotos}
              onExpandPhotos={id => setExpandedPhotos(prev => new Set(prev).add(id))}
              onOpenPhoto={setLightboxUrl}
              onEditLine={i => { void editLine(i); }}
              onRemoveLine={setRemovingLineId}
            />
          </div>
          <div className="ph-action-bar stacked">
            {/* One target per category, matching the capture screen. A single
                "Add another" button would put the old category lock back in the
                user's head — the PO is not in a mode. Docked rather than in flow:
                the list it appends to grows every time it is used, and the screen
                reopens at the top after each line, so in flow it only ever got
                further away. */}
            {canEditOrder && (
              <div className="ph-add-dock" style={{ gridTemplateColumns: `repeat(${cats.length}, 1fr)` }}>
                {cats.map(cat => (
                  <button
                    key={cat}
                    onClick={() => { void addLine(cat as Category); }}
                    aria-label={t('subAddCatLine', { cat })}
                    style={{
                      height: 44, borderRadius: 12, minWidth: 0,
                      border: '1.5px dashed ' + categoryTone(cat).tone,
                      background: 'var(--bg-elev)', color: categoryTone(cat).strong,
                      fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
                      padding: '0 6px', cursor: 'pointer',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    + {cat}
                  </button>
                ))}
              </div>
            )}
            {/* The goods figure moves as lines are added, so it sits with the
                dock that changes it; fees and the full total stay on the
                order screen where they are typed. */}
            <div className="ph-action-row" style={{ justifyContent: 'space-between', padding: '0 4px' }}>
              <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{t('goodsTotal')} · {itemsUnits}</span>
              <span className="mono" style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {fmtUSD(cost.goods, locale)}
              </span>
            </div>
          </div>
        </>
      )}
      {section === 'info' && (
      <>
      <div className="ph-scroll" style={{ paddingBottom: 110 }}>
        {isArchived && (
          <div className="ph-card" style={{
            margin: '10px 12px 0', padding: '10px 12px',
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'oklch(0.97 0.025 295)', borderStyle: 'dashed',
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: 6,
              background: 'oklch(0.92 0.05 295)', color: 'oklch(0.40 0.16 295)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon name="box" size={13} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
              <strong style={{ color: 'var(--fg)' }}>{t('orderArchivedBadge')}</strong> {t('orderArchivedRestoreHint')}
            </div>
          </div>
        )}
        <div className="ph-section-h" style={{ paddingTop: 10 }}>
          <span>{t('orderStatus')}</span>
        </div>

        <div className="ph-card" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            {ORDER_STATUSES.map((s, i) => {
              const reached = currentIdx >= 0 && i <= currentIdx;
              const active = i === currentIdx;
              // A sold order sits on Done's step under its own name.
              const label = active && effectiveStatus === 'Sold' ? 'Sold' : s;
              const tone = statusTone(label);
              const locked = i > canReachIdx;
              const dotColor = active
                ? `var(--${tone === 'warn' ? 'warn' : tone === 'pos' ? 'pos' : tone === 'info' ? 'info-strong, var(--info)' : tone === 'accent' ? 'accent' : tone === 'cool' ? 'cool' : 'fg'})`
                : reached
                  ? 'var(--fg)'
                  : 'var(--border-strong)';
              return (
                <div key={s} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, position: 'relative' }}>
                  {i > 0 && (
                    <span aria-hidden style={{
                      position: 'absolute', top: 10, right: '50%', width: '100%', height: 2,
                      background: i <= currentIdx ? 'var(--fg)' : 'var(--border)',
                      zIndex: 0,
                    }} />
                  )}
                  <span
                    role={reached && !active ? 'button' : undefined}
                    tabIndex={reached && !active ? 0 : undefined}
                    aria-label={reached && !active ? t('eoLookbackTip', { s }) : undefined}
                    onClick={reached && !active ? () => setView(view === s ? null : s) : active ? () => setView(null) : undefined}
                    style={{
                      width: 22, height: 22, borderRadius: '50%',
                      background: reached ? dotColor : 'var(--bg-elev)',
                      border: '2px solid ' + (active ? dotColor : reached ? 'var(--fg)' : 'var(--border-strong)'),
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      color: reached ? 'white' : 'var(--fg-subtle)',
                      fontSize: 10, fontWeight: 700,
                      position: 'relative', zIndex: 1,
                      boxShadow: active ? '0 0 0 3px color-mix(in oklch, ' + dotColor + ' 18%, transparent)'
                        : view === s ? '0 0 0 3px var(--bg-soft), 0 0 0 4px var(--fg)' : 'none',
                      cursor: reached && !active ? 'pointer' : undefined,
                    }}
                  >
                    {locked ? <Icon name="lock" size={10} /> : reached && !active ? <Icon name="check" size={10} stroke={3} /> : (i + 1)}
                  </span>
                  <span style={{
                    fontSize: 10.5, fontWeight: active ? 600 : 500,
                    color: active ? 'var(--fg)' : 'var(--fg-subtle)',
                    textAlign: 'center', lineHeight: 1.1,
                  }}>{label}</span>
                </div>
              );
            })}
          </div>

          {view !== null && viewStageId && (
            <div style={{ marginTop: 14, borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {t('eoLookbackTitle', { s: view })}
                </span>
                <button type="button" className="ph-btn ghost" style={{ marginLeft: 'auto', height: 30, padding: '0 10px' }} onClick={() => setView(null)}>
                  {t('eoBackToCurrent', { s: effectiveStatus })}
                </button>
              </div>
              {(() => {
                const facts = lookbackFacts(viewStageId, events.events);
                if (!events.loaded) return null;
                if (facts.length === 0) return <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{t('eoLookbackNone')}</div>;
                return (
                  <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                    {facts.map((f, i) => {
                      switch (f.kind) {
                        case 'submitted':
                          return <div key={i}><b>{t('eoLookbackSubmitted', { who: f.who ?? t('eoSomeone'), when: fmtDate(f.when, locale) })}</b> <span style={{ color: 'var(--fg-subtle)' }}>· {t('subUnitsCost', { n: f.qty, cost: fmtUSD(f.totalCost, locale) })}</span></div>;
                        case 'handoffPickup':
                          return <div key={i}>{t('acHandoffPickup')} <span style={{ color: 'var(--fg-subtle)' }}>· {f.byName ?? '—'}</span></div>;
                        case 'handoffLabel':
                          return <div key={i}>{t('acHandoffLabel')} <span className="mono" style={{ color: 'var(--fg-subtle)' }}>· {[f.carrier, f.trackingNumber].filter(Boolean).join(' ')}</span></div>;
                        case 'advanced':
                          if (f.to === 'sold') return <div key={i}>{t('eoLookbackSoldOut', { when: fmtDate(f.when, locale) })}</div>;
                          return <div key={i}>{t('eoLookbackAdvanced', { who: f.who ?? t('eoSomeone'), when: fmtDate(f.when, locale), to: LIFECYCLE_LABEL[f.to] ?? f.to })}</div>;
                        case 'doneNote':
                          return <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{f.note}</div>;
                        case 'doneFile':
                          return <div key={i}><Icon name="paperclip" size={11} /> {f.filename}</div>;
                      }
                    })}
                  </div>
                );
              })()}
              {viewStageId === 'in_transit' && pkg && <div style={{ marginTop: 10 }}><PackageJourney pkg={pkg} /></div>}
            </div>
          )}

          {view === null && effectiveStatus === 'In Transit' && (
            <div style={{ marginTop: 14, borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
              {order.handoffMethod === 'pickup' ? (
                <div style={{ fontSize: 13 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{t('hoPickup')}</div>
                  {t('poCollectedBy', { name: order.handoffBy?.name ?? '—' })}
                  <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>{t('eoPickupNoCarrier', { wh: order.warehouse?.short ?? '' })}</div>
                </div>
              ) : pkg ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{t('orderShipment')}</span>
                    <button
                      type="button"
                      className="ph-btn ghost"
                      style={{ marginLeft: 'auto', height: 30, padding: '0 10px' }}
                      onClick={() => void refreshPkg()}
                      disabled={refreshState === 'busy'}
                    >
                      <Icon name="refresh" size={12} /> {refreshState === 'busy' ? t('poPkgRefreshing') : t('poPkgRefresh')}
                    </button>
                  </div>
                  <PackageJourney pkg={pkg} />
                  {typeof refreshState === 'object' && (
                    <div style={{ fontSize: 12, color: 'var(--warn-strong)', marginTop: 6 }} role="status">{refreshState.error}</div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{t('eoNoDeliveryRecorded')}</div>
              )}
            </div>
          )}

          {view === null && readiness.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
              <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
                {t('poReadyTitle')}
              </div>
              {readiness.map(r => (
                <button
                  key={r.key}
                  type="button"
                  className={'ph-check-row' + (r.met ? ' met' : '')}
                  onClick={() => r.target === 'products' ? navigate(poProductsPath(order.id))
                    : showFold(r.target)}
                >
                  <span className="ph-check-dot" aria-hidden>{r.met && <Icon name="check" size={10} stroke={3} />}</span>
                  <span>{r.label}</span>
                  <Icon name="chevronRight" size={13} className="arrow" />
                </button>
              ))}
            </div>
          )}
          {view === null && nextStatus && (
            <button
              className="ph-btn dark"
              style={{ width: '100%', marginTop: 14, height: 44 }}
              onClick={advance}
              disabled={!canAdvance}
            >
              <Icon name="flag" size={14} />
              {advancing
                ? t('advancing')
                : nextStatus === 'Done' ? t('lifecycleMarkDone')
                  : nextStatus === 'Ready to Pay' ? t('lifecycleMarkReadyToPay')
                  : t('lifecycleAdvance', { status: nextStatus })}
            </button>
          )}
          {!nextStatus && orderLocked && !isArchived && (
            <div style={{
              marginTop: 12, padding: '8px 12px', borderRadius: 10,
              background: 'var(--bg-soft)', color: 'var(--fg-subtle)',
              fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--border)',
            }}>
              <Icon name="lock" size={12} />
              {effectiveStatus === 'Ready to Pay' ? t('lifecycleReadyToPayNote')
                : effectiveStatus === 'Sold' ? t('lifecycleSoldNote') : t('lifecycleDoneNote')}
            </div>
          )}
          {!nextStatus && !orderLocked && !isPurchaser && gateLocked.length > 0 && (
            <div style={{
              marginTop: 12, padding: '8px 12px', borderRadius: 10,
              background: 'var(--bg-soft)', color: 'var(--fg-subtle)',
              fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--border)',
            }}>
              <Icon name="lock" size={12} />
              {t('lifecycleWarehouseMgrLock', {
                name: gateWarehouse?.manager ?? '', wh: gateWarehouse?.short ?? '', stage: gateLocked[0],
              })}
            </div>
          )}
          {!nextStatus && !orderLocked && isPurchaser && effectiveStatus === 'Reviewing' && (
            <div style={{
              marginTop: 12, padding: '8px 12px', borderRadius: 10,
              background: 'var(--bg-soft)', color: 'var(--fg-subtle)',
              fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--border)',
            }}>
              <Icon name="eye" size={12} /> {t('lifecycleManagerLock')}
            </div>
          )}
          {doneMeta && (doneMeta.note || doneMeta.attachments.length > 0) && (
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 10,
              background: 'var(--bg-soft)', border: '1px solid var(--border)',
              display: 'grid', gap: 8,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
                textTransform: 'uppercase', letterSpacing: '0.06em',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <Icon name="paperclip" size={11} /> {t('poDoneEvidenceTitle')}
              </div>
              {doneMeta.note && (
                <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                  {doneMeta.note}
                </div>
              )}
              {doneMeta.attachments.map(a => (
                <AttachmentChip
                  key={a.id}
                  a={a}
                  // Done evidence stays editable after the transition — the
                  // dialog only opens on the way into Done. Manager-only,
                  // mirroring the backend canWriteMeta gate.
                  onRemove={!isPurchaser ? () => removeDoneAtt(a.id) : undefined}
                />
              ))}
            </div>
          )}
        </div>

        {/* The lines live on their own screen: an 18-line PO is longer than a
            phone, and the order's stage, cost and fields were being scrolled
            past to reach them. The row states what that screen holds. */}
        <button
          className="ph-row"
          onClick={() => navigate(poProductsPath(order.id))}
          style={{ width: '100%', marginTop: 12, fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer' }}
        >
          <div className="ph-inv-thumb" style={{ width: 34, height: 34 }}>
            <Icon name="box" size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {t('products')} <span className="mono" style={{ color: 'var(--fg-subtle)' }}>· {order.lines.length}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {order.lines.length === 0
                ? t('poProductsRowEmpty')
                : <>{totals.qty} {totals.qty === 1 ? t('unit') : t('units2')} · {fmtUSD(cost.goods, locale)}{unpricedCount > 0 && <span style={{ color: 'var(--warn)' }}> · {t('grpUnpriced', { n: unpricedCount })}</span>}</>}
            </div>
          </div>
          <Icon name="chevronRight" size={15} className="arrow" />
        </button>

        {/* The money comes right after the products row it is computed from;
            the order's warehouse and payment type were answered once and are
            rarely revisited, so they follow. */}
        <div className="ph-card" style={{ marginTop: 12, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {t('costBreakdown')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontVariantNumeric: 'tabular-nums' }}>
              {totals.qty} {totals.qty === 1 ? t('unit') : t('units2')} · {order.lines.length} {order.lines.length === 1 ? t('item') : t('items')}
            </div>
          </div>

          {/* Goods, then fees, then the total they add up to — the same stack
              the desktop edit page shows, so the number is never a surprise.
              The commission rate and the PayPal id live in their folds. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 10 }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('goodsTotal')}</span>
            <span className="mono">{fmtUSD(cost.goods, locale)}</span>
          </div>

          {canEditOrder ? (
            <div className="ph-field-row" style={{ gridTemplateColumns: '110px 1fr', marginTop: 8 }}>
              <div className="ph-field" style={{ marginTop: 0 }}>
                <label>{t('otherFees')}</label>
                <input
                  className="input mono"
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={fees.amount}
                  placeholder="0.00"
                  onChange={e => setMeta({ fees: { ...fees, amount: e.target.value } })}
                />
              </div>
              <div className="ph-field" style={{ marginTop: 0 }}>
                <label>{t('otherFeesNote')}</label>
                <input
                  className="input"
                  maxLength={280}
                  value={fees.note}
                  placeholder={t('otherFeesPh')}
                  onChange={e => setMeta({ fees: { ...fees, note: e.target.value } })}
                />
              </div>
            </div>
          ) : cost.fees > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: 12, marginTop: 6 }}>
              <span style={{ color: 'var(--fg-subtle)', minWidth: 0, paddingRight: 10 }}>
                {t('otherFees')}
                {order.otherFeesNote && (
                  <span style={{ display: 'block', fontSize: 11, opacity: 0.8 }}>{order.otherFeesNote}</span>
                )}
              </span>
              <span className="mono">{fmtUSD(cost.fees, locale)}</span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <span>{t('totalCost')}</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {fmtUSD(cost.total, locale)}
            </span>
          </div>

          {/* The two profits, managers only. Unrealized is the list column's
              figure — margin on priced lines less the fee; Realized is what
              the units earned on completed sell orders, net of the commission
              paid, and only speaks for the units that sold. */}
          {showFinalSell && (() => {
            const unrealized = totals.margin - (order.otherFees ?? 0);
            const rz = order.realized ?? null;
            const fill = rz && rz.boughtQty > 0 ? Math.min(100, (rz.soldQty / rz.boughtQty) * 100) : 0;
            return (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                  <span style={{ color: 'var(--fg-subtle)' }}>{t('unrealizedProfit')}</span>
                  <span className="mono" style={{ fontWeight: 600, color: `var(--${profitTone(unrealized)})` }}>
                    {fmtUSD(unrealized, locale)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 6 }}>
                  <span style={{ color: 'var(--fg-subtle)' }}>{t('realizedProfit')}</span>
                  {rz ? (
                    <span className="mono" style={{ fontWeight: 600, color: `var(--${profitTone(rz.profit)})` }}>
                      {fmtUSD(rz.profit, locale)}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--fg-subtle)' }}>{t('nothingSoldYet')}</span>
                  )}
                </div>
                {rz && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 11, color: 'var(--fg-subtle)' }}>
                    <span aria-hidden="true" style={{ flex: 1, height: 2, background: 'var(--border)', position: 'relative' }}>
                      <span style={{ position: 'absolute', inset: 0, width: `${fill}%`, background: 'var(--pos)' }} />
                    </span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{t('soldOfUnits', { n: rz.soldQty, of: rz.boughtQty })}</span>
                  </div>
                )}
              </>
            );
          })()}
        </div>

        <div className="ph-section-h">
          <span>{t('orderDetails')}</span>
          <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
            {canEditOrder ? t('phDetailsEditable') : t('phDetailsClosed')}
          </span>
        </div>

        {/* The desktop's tabs, as folds: same five, same order, same names,
            so the two shells never disagree about where a fact lives. */}
        <PhFold
          id="delivery"
          title={t('eoTabDelivery')}
          summary={<span className={needs('delivery') ? 'miss' : ''}>{deliverySummary}</span>}
          open={openFold === 'delivery'}
          onToggle={() => toggleFold('delivery')}
          mark={markFor('delivery', warehouseDirty || facts)}
        >
          <div className="ph-fold-ro">
            <div className="ph-field">
              <label htmlFor="ph-source">{t('hoSource')}</label>
              <select
                id="ph-source"
                className="select"
                value={source ?? ''}
                onChange={e => setMeta({ source: (e.target.value || null) as PackageSource | null })}
                disabled={!canEditOrder}
              >
                <option value="">{t('hoSourcePick')}</option>
                {PACKAGE_SOURCES.map(o => <option key={o} value={o}>{t(packageSourceLabelKey(o))}</option>)}
              </select>
            </div>
            <div className="ph-field">
              <label htmlFor="ph-warehouse">{t('warehouse')}</label>
              <select
                id="ph-warehouse"
                className="select"
                value={warehouseId}
                onChange={e => setMeta({ warehouseId: e.target.value })}
                disabled={!canEditOrder}
              >
                {/* An unset warehouse must not borrow the first option's name. */}
                {(warehouses.length === 0 || !warehouseId) && (
                  <option value={warehouseId}>{order.warehouse?.name ?? order.warehouse?.short ?? '—'}</option>
                )}
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.short} — {w.region}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="ph-field">
            <label>{t('poDeliveryHow')}</label>
            <div className="seg ho-seg" role="radiogroup" aria-label={t('poDeliveryHow')}>
              {(['label', 'pickup'] as const).map(d => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={delivery === d}
                  className={delivery === d ? 'active' : ''}
                  onClick={() => canEditOrder && setMeta({ delivery: d })}
                  disabled={!canEditOrder}
                >
                  {t(d === 'pickup' ? 'hoPickup' : 'hoLabel')}
                </button>
              ))}
            </div>
          </div>
          {delivery === 'pickup' && (
            <div className="ph-field">
              <label htmlFor="ph-by">{t('hoPickedBy')}</label>
              <select
                id="ph-by"
                className="select"
                value={byUserId}
                onChange={e => setMeta({ byUserId: e.target.value })}
                disabled={!canEditOrder}
              >
                <option value="">{t('poCollectorPick')}</option>
                {memberNames.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          )}
          {delivery === 'label' && (
            <>
              <div className="ph-field">
                <label htmlFor="ph-tracking">{t('shipAddTrackingLabel')}</label>
                <input
                  id="ph-tracking"
                  className="input mono"
                  value={meta.tracking.raw}
                  onChange={e => setMeta({ tracking: { raw: e.target.value, pick: null } })}
                  placeholder={t('shipAddTrackingPh')}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canEditOrder}
                />
              </div>
              <div className="ho-carriers" role="radiogroup" aria-label={t('shipAddCarrierTitle')}>
                {CARRIERS.map(c => {
                  const lit = tracking.detected.includes(c);
                  const selected = tracking.carrier === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={'ho-carrier' + (lit ? ' lit' : '') + (selected ? ' selected' : '')}
                      data-carrier={c}
                      onClick={() => canEditOrder && setMeta({ tracking: { ...meta.tracking, pick: c } })}
                      disabled={!canEditOrder}
                    >
                      <span className="ho-carrier-name">{c}</span>
                      <span className="ho-carrier-fmt mono">{t(FMT_HINT_KEY[c])}</span>
                      {selected && <Icon name="check" size={13} />}
                    </button>
                  );
                })}
              </div>
              <div className="ship-add-hint" aria-live="polite">{tracking.hintKey ? t(tracking.hintKey) : ' '}</div>
            </>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.45 }}>
            {canEditOrder ? t('eoDeliveryEditableUntil') : t('eoDeliveryFrozen')}
          </div>
        </PhFold>

        <PhFold
          id="payment"
          title={t('eoTabPayment')}
          summary={<span className={needs('payment') ? 'miss' : ''}>{paymentSummary}</span>}
          open={openFold === 'payment'}
          onToggle={() => toggleFold('payment')}
          mark={markFor('payment', paymentDirty || methodDirty || paypalDirty)}
          bodyClassName="ph-pay"
        >
          <PaymentFields
            paidBy={payment} onPaidBy={v => canEditOrder && setMeta({ payment: v })}
            method={paymentMethod} onMethod={v => canEditOrder && setMeta({ paymentMethod: v })}
            txnId={paypalTxnId} onTxnId={v => canEditOrder && setMeta({ paypalTxnId: v })}
            txnRequired={order.txnRequired === true}
            disabled={!canEditOrder}
            phone
            proof={proof}
            canEditProof={canAnnotate}
            idPrefix="ph"
          />
        </PhFold>

        <PhFold
          id="commission"
          title={t('eoTabCommission')}
          summary={commissionSummary}
          open={openFold === 'commission'}
          onToggle={() => toggleFold('commission')}
          mark={markFor('commission', commission)}
        >
          <PhCommissionFields
            ownerId={ownerId} onOwner={id => setMeta({ ownerId: id })}
            ownerOptions={ownerOptions}
            commissionPct={commissionPct} onCommissionPct={v => setMeta({ commissionPct: v })}
            editable={canEditCommission}
            math={commissionMath}
            locale={locale}
            note={isPurchaser ? t('phCommissionByManager') : canEditOrder ? t('phCommissionEditableUntil') : t('phCommissionFixed')}
          />
          {/* The payment itself, under the maths. Its own .ph-pay wrapper:
              the phone rules for the labels hang off that class, and the fold
              body is shared with the fields above. */}
          <div className="ph-pay">
            <CommissionPaymentFields shots={commissionShots} editable={!isPurchaser} phone />
          </div>
        </PhFold>

        <PhFold
          id="notes"
          title={t('eoTabNotes')}
          summary={notesSummary}
          open={openFold === 'notes'}
          onToggle={() => toggleFold('notes')}
          mark={markFor('notes', notesDirty)}
        >
          <div className="ph-field">
            <label htmlFor="ph-notes">{t('orderNotes')}</label>
            <textarea
              id="ph-notes"
              className="input"
              value={notes}
              onChange={e => setMeta({ notes: e.target.value })}
              placeholder={t('orderNotesPh')}
              rows={3}
              disabled={!canAnnotate}
              style={{ width: '100%', resize: 'vertical', minHeight: 70, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.45, padding: '10px 12px' }}
            />
          </div>
          {(submissionAtts.length > 0 || canAnnotate) && (
            <div className="ph-field">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="paperclip" size={12} /> {t('poSubmissionEvidenceTitle')}
              </label>
              <div style={{ display: 'grid', gap: 8 }}>
                {submissionAtts.map(a => (
                  <AttachmentChip
                    key={a.id}
                    a={a}
                    onRemove={canAnnotate ? () => void removeSubmissionAtt(a) : undefined}
                  />
                ))}
                {canAnnotate && (
                  <AttachmentDropzone
                    boxHint={t('poSubmitAttachHint')}
                    uploading={proof.chatUploading}
                    onFiles={files => void addSubmissionFiles(files)}
                  />
                )}
              </div>
            </div>
          )}
        </PhFold>

        <PhFold
          id="activity"
          title={t('eoTabActivity')}
          summary={events.loaded ? t('phEventsN', { n: events.events.length }) : ''}
          open={openFold === 'activity'}
          onToggle={() => toggleFold('activity')}
        >
          <div style={{ margin: '-12px -14px -14px' }}>
            <OrderActivityLog orderId={order.id} refreshKey={activityRefreshKey} bare events={events} />
          </div>
        </PhFold>

      </div>
      <div className="ph-action-bar">
        <div className="ph-action-row">
          {/* The total belongs where the decision is made, not 2,000px up the
              scroll. It states the figure; it is never typed. */}
          <div style={{ flex: '0 0 auto', paddingRight: 4, minWidth: 0 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>
              {t('totalCost')}
            </div>
            <div className="mono" style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>
              {fmtUSD(cost.total, locale)}
            </div>
          </div>
          <button
            className="ph-icon-btn"
            onClick={() => api.download(`/api/orders/${order.id}/spreadsheet`, `${order.id}.xlsx`).catch(handleFetchError)}
            aria-label={t('downloadPoXlsx')}
            style={{
              width: 50, height: 50, borderRadius: 14,
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-elev)', color: 'var(--fg-muted)',
              flex: '0 0 auto',
            }}
          >
            <Icon name="download" size={16} />
          </button>
          {canDelete && (
            <button
              className="ph-icon-btn"
              onClick={() => { setTypedId(''); setShowDelete(true); }}
              aria-label={t('deleteOrder')}
              style={{
                width: 50, height: 50, borderRadius: 14,
                border: '1px solid var(--border-strong)',
                background: 'var(--bg-elev)',
                color: 'var(--neg)',
                flex: '0 0 auto',
              }}
            >
              <Icon name="trash" size={16} />
            </button>
          )}
          {canArchive && (
            <button
              className="ph-icon-btn"
              onClick={async () => {
                if (isArchived) {
                  setArchiving(true);
                  try {
                    await unarchiveOrder(order.id);
                    // Mobile stays on the page (desktop navigates away), so
                    // the banner and the restored lines have to be re-read.
                    await refetchOrder();
                    onSaved(t('orderRestoredToast'));
                  } catch (e) {
                    handleFetchError(e);
                  } finally {
                    setArchiving(false);
                  }
                } else {
                  setShowArchive(true);
                }
              }}
              disabled={archiving}
              aria-label={isArchived ? t('unarchiveOrder') : t('archiveOrder')}
              style={{
                width: 50, height: 50, borderRadius: 14,
                border: '1px solid var(--border-strong)',
                background: isArchived ? 'oklch(0.96 0.04 295)' : 'var(--bg-elev)',
                color: isArchived ? 'oklch(0.45 0.16 295)' : 'var(--fg-muted)',
                flex: '0 0 auto',
              }}
            >
              <Icon name={isArchived ? 'rotate' : 'box'} size={16} />
            </button>
          )}
          {dirty && canAnnotate && (
            <button
              className="ph-btn dark"
              onClick={save}
              disabled={saving}
            >
              <Icon name="check" size={16} /> {saving ? '…' : t('save')}
            </button>
          )}
        </div>
      </div>
      </>
      )}

      {revertConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) revertConfirm(false); }}>
          <div className="modal-shell" style={{ maxWidth: 380, width: '92vw' }} onClick={e => e.stopPropagation()}>
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
              <button className="btn primary" onClick={() => revertConfirm(true)}>{t('revertWarnConfirm')}</button>
            </div>
          </div>
        </div>
      )}

      {pendingRevert.length > 0 && (
        <RevertNoticeDialog
          orderId={order.id}
          changes={pendingRevert}
          onAcknowledged={() => { setPendingRevert([]); setActivityRefreshKey(k => k + 1); }}
          onDismiss={() => setPendingRevert([])}
        />
      )}

      {removingLineId && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setRemovingLineId(null); }}>
          <div className="modal-shell" style={{ maxWidth: 380, width: '92vw' }} onClick={e => e.stopPropagation()}>
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
                  <div className="modal-title">
                    {t('removeLineTitle', {
                      name: itemLabel(order.lines.find(l => l.id === removingLineId)!) || '—',
                    })}
                  </div>
                  <div className="modal-sub">{t('removeLineSub')}</div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setRemovingLineId(null)}>{t('cancel')}</button>
              <button
                className="btn"
                style={{ background: 'var(--neg)', color: 'white', borderColor: 'var(--neg)' }}
                onClick={() => removeLine(removingLineId)}
              >
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDelete && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !deleting) setShowDelete(false); }}>
          <div className="modal-shell" style={{ maxWidth: 380, width: '92vw' }} onClick={e => e.stopPropagation()}>
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
                  <div className="modal-sub">{t('deleteOrderSub')}</div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <div className="field">
                <label className="label">
                  {t('deleteOrderTypeConfirm', { id: order.id })}
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
                    onDeleted();
                  } catch (e) {
                    handleFetchError(e);
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? t('deleting') : t('deleteOrderConfirmCta')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showArchive && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !archiving) { setShowArchive(false); setArchiveConflict(null); } }}>
          <div className="modal-shell" style={{ maxWidth: archiveConflict ? 440 : 380, width: '92vw' }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'oklch(0.96 0.04 295)', color: 'oklch(0.45 0.16 295)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="box" size={18} />
                </div>
                <div>
                  <div className="modal-title">
                    {archiveConflict ? t('archiveConflictTitle') : t('archivePromptTitle', { id: order.id })}
                  </div>
                  <div className="modal-sub">
                    {archiveConflict ? t('archiveConflictIntro', { id: order.id }) : t('archivePromptSub')}
                  </div>
                </div>
              </div>
            </div>
            {archiveConflict && (
                <div className="modal-body" style={{ paddingTop: 0 }}>
                  <ArchiveConflictList conflict={archiveConflict} />
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
                    await refetchOrder();
                    setShowArchive(false);
                    setArchiveConflict(null);
                    setArchiving(false);
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
                {archiving ? '…' : archiveConflict ? t('archiveConflictConfirm') : t('archive')}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxUrl && (
        <ImageLightbox url={lightboxUrl} alt={t('aiPhotoLabel')} onClose={() => setLightboxUrl(null)} />
      )}

      {handoffOpen && user && (
        <PhHandoffSheet
          init={{
            order,
            warehouseId: warehouseId || (order.warehouse?.id ?? ''),
            payment,
            paymentMethod,
            paypalTxnId,
            proof,
            currentUser: { id: user.id, name: user.name },
          }}
          onClose={() => setHandoffOpen(false)}
          onDone={async () => {
            setHandoffOpen(false);
            // The scan preview belongs to the hand-off that just consumed it;
            // this page stays mounted, so it would linger in the PayPal panel.
            proof.removeScreenshot();
            await refetchOrder();
            setActivityRefreshKey(k => k + 1);
          }}
        />
      )}
      {commissionOpen && (
        <PhCommissionSheet
          ownerId={ownerId} onOwner={id => setMeta({ ownerId: id })}
          ownerOptions={ownerOptions}
          commissionPct={commissionPct} onCommissionPct={v => setMeta({ commissionPct: v })}
          editable
          math={commissionMath}
          locale={locale}
          deliverySummary={deliverySummary}
          paymentSummary={paymentSummary}
          busy={advancing}
          onClose={() => setCommissionOpen(false)}
          onConfirm={() => void confirmCommission()}
        />
      )}
      {doneDialogOpen && (
        <StatusChangeDialog
          orderId={order.id}
          to="Done"
          currentStatus={effectiveStatus}
          initialNote={doneMeta?.note ?? ''}
          initialAttachments={doneMeta?.attachments ?? []}
          attachments={commissionShots}
          apiBase="/api/orders"
          variant="purchase"
          // The note live-saves inside the dialog, so a cancel still needs a
          // refetch for the read-only block to reflect it.
          onCancel={() => { setDoneDialogOpen(false); refetchOrder(); }}
          onConfirm={async () => { setDoneDialogOpen(false); await doAdvance(); }}
          onMutated={() => setActivityRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}
