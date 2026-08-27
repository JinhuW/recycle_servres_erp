import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { ImageLightbox } from '../components/ImageLightbox';
import { OrderActivityLog } from '../components/OrderActivityLog';
import { RevertNoticeDialog } from '../components/RevertNoticeDialog';
import { StatusChangeDialog, type StatusAttachment } from '../components/StatusChangeDialog';
import { AttachmentChip } from '../components/AttachmentChip';
import { AttachmentDropzone } from '../components/AttachmentDropzone';
import { LineSpecChips, lineHasSpecChips } from '../components/LineSpecChips';
import { SerialNumbers } from '../components/SerialNumbers';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { linePhotos } from '../lib/linePhotos';
import { api, deleteOrder, archiveOrder, unarchiveOrder } from '../lib/api';
import { navigate } from '../lib/route';
import { handleFetchError, showErrorDialog } from '../lib/errorToast';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import { poEffectiveCost, parseFeeInput } from '../lib/poTotals';
import { ORDER_STATUSES, statusTone, isCompleted } from '../lib/status';
import { addableCategories, categoryTone } from '../lib/lookups';
import type { Category, Order, OrderLine, Warehouse } from '../lib/types';

// `order.status` can collapse to 'Mixed' when an order's lines disagree, which
// would falsely lock the owner out. `lifecycle` is authoritative, so we map it
// to the canonical status and only fall back for unknown lifecycles.
const LIFECYCLE_STATUS: Record<string, string> = {
  draft: 'Draft',
  in_transit: 'In Transit',
  reviewing: 'Reviewing',
  done: 'Done',
};

// How many of a line's photos the row shows before it offers the rest. Four
// 44px tiles is what fits next to the line's controls on a small phone.
const PHOTOS_COLLAPSED = 4;

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
  notes: string;
  fees: { amount: string; note: string };
};

type Props = {
  order: Order;
  /** Unsaved order-level edits carried across trips into the line form. */
  meta: OrderMetaDraft | null;
  onMetaChange: (meta: OrderMetaDraft) => void;
  onCancel: () => void;
  onSaved: (msg: string) => void;
  onDeleted: () => void;
  /** Opens the line form on an existing line. Returns here when it closes. */
  onEditLine: (order: Order, idx: number) => void;
  onAddLine: (order: Order, cat: Category) => void;
};

export function OrderDetail({
  order: initialOrder, meta: metaDraft, onMetaChange,
  onCancel, onSaved, onDeleted, onEditLine, onAddLine,
}: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const { user } = useAuth();
  const [order, setOrder] = useState<Order>(initialOrder);
  useEffect(() => { setOrder(initialOrder); }, [initialOrder]);

  const isPurchaser = user?.role !== 'manager';
  const effectiveStatus = LIFECYCLE_STATUS[order.lifecycle] ?? order.status;
  const orderLocked = isCompleted(effectiveStatus);
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

  // Shipping quick link — count only; the labels themselves live on /shipping,
  // so the detail payload carries the number instead of a second fetch.
  const shipmentCount = order.shipmentCount;

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  // What the server says the order's meta is, as one comparable string. The
  // backend rebuilds `statusMeta` as a fresh object on every response, so its
  // identity changes when nothing did — keying anything on it wiped the fields
  // the user was typing into on every refetch.
  const serverVersion = JSON.stringify([
    order.id,
    order.warehouse?.id ?? '',
    order.payment,
    order.notes ?? '',
    order.otherFees,
    order.otherFeesNote ?? '',
    ...(order.statusMeta?.['Submission']?.attachments ?? []).map(a => a.id),
  ]);
  // Edits made against an older server state are stale: the order moved on, so
  // the fields show what it now holds.
  const meta: OrderMetaDraft = metaDraft?.version === serverVersion ? metaDraft : {
    version: serverVersion,
    warehouseId: order.warehouse?.id ?? '',
    payment: order.payment,
    notes: order.notes ?? '',
    fees: {
      amount: order.otherFees ? order.otherFees.toFixed(2) : '',
      note: order.otherFeesNote ?? '',
    },
  };
  const { warehouseId, payment, notes, fees } = meta;
  const setMeta = (patch: Partial<OrderMetaDraft>) => onMetaChange({ ...meta, ...patch });
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
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [showDelete, setShowDelete] = useState(false);
  const [typedId, setTypedId] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [submissionAtts, setSubmissionAtts] = useState<StatusAttachment[]>(
    order.statusMeta?.['Submission']?.attachments ?? [],
  );
  const [submissionUploading, setSubmissionUploading] = useState(false);

  // Archive (mobile): owner-or-manager, non-Draft. No type-to-confirm —
  // archive is reversible so we keep the gesture short, matching the
  // platform's "one tap, one sheet" rhythm.
  const isArchived = !!order.archivedAt;
  // Mirrors the backend: a reverted order is a Draft that HAS been submitted,
  // and Delete refuses exactly those — so Archive has to take it, or the order
  // offers neither. Unarchiving is always available once archived.
  const canArchive = isOwnerOrManager
    && (isArchived || effectiveStatus !== 'Draft' || !!order.everSubmitted);
  const [showArchive, setShowArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

  // Re-read the evidence list when the server's own version of it moves —
  // never on a mere refetch that returned the same thing.
  useEffect(() => {
    setSubmissionAtts(order.statusMeta?.['Submission']?.attachments ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverVersion]);

  useEffect(() => {
    let alive = true;
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => { if (alive) setWarehouses(r.items); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  const totals = useMemo(() => {
    let qty = 0, cost = 0;
    for (const l of order.lines) {
      qty += l.qty;
      cost += l.qty * l.unitCost;
    }
    return { qty, cost };
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
  const feesDirty =
    feesValue !== (order.otherFees ?? 0) ||
    (fees.note.trim() || null) !== (order.otherFeesNote || null);
  const dirty = notesDirty || warehouseDirty || paymentDirty || feesDirty;

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
    const material = warehouseDirty || paymentDirty || feesDirty;
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
        otherFees:     feesDirty      ? feesValue                   : undefined,
        otherFeesNote: feesDirty      ? (fees.note.trim() || null)  : undefined,
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
  // to the manager, and the backend rejects the rest from them anyway.
  const nextStatus: string | null = (() => {
    if (effectiveStatus === 'Draft') return 'In Transit';
    if (isPurchaser) return null;
    if (effectiveStatus === 'In Transit') return 'Reviewing';
    if (effectiveStatus === 'Reviewing') return 'Done';
    return null;
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
    // Moving to Done first offers the optional evidence dialog (note +
    // attachments); confirming there fires the actual advance.
    if (nextStatus === 'Done') { setDoneDialogOpen(true); return; }
    await doAdvance();
  };

  const addSubmissionFiles = async (fl: FileList | null) => {
    const files = Array.from(fl || []);
    if (!files.length) return;
    setSubmissionUploading(true);
    try {
      for (const f of files) {
        // 50 MiB server hard cap; oversized images are shrunk server-side.
        if (f.size > 50 * 1024 * 1024) {
          showErrorDialog(t('fileTooLarge', { name: f.name }));
          continue;
        }
        const form = new FormData();
        form.append('file', f);
        const r = await api.upload<{ attachment: StatusAttachment }>(
          `/api/orders/${order.id}/status-meta/Submission/attachments`, form);
        setSubmissionAtts(prev => [...prev, r.attachment]);
      }
      setActivityRefreshKey(k => k + 1);
    } catch (e) {
      handleFetchError(e);
    } finally {
      setSubmissionUploading(false);
    }
  };

  const removeSubmissionAtt = async (attachmentId: string) => {
    try {
      await api.delete(`/api/orders/${order.id}/status-meta/Submission/attachments/${attachmentId}`);
      setSubmissionAtts(prev => prev.filter(a => a.id !== attachmentId));
      setActivityRefreshKey(k => k + 1);
    } catch (e) {
      handleFetchError(e);
    }
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

  const itemLabel = (l: OrderLine) =>
      l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()
    : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
    : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
    : (l.description ?? '—');

  const doneMeta = order.statusMeta?.['Done'];

  const headerTitle = orderLocked ? t('viewOrder') : t('editOrderId', { id: order.id });
  const headerSub = `${order.lines.length} ${order.lines.length === 1 ? t('item') : t('items')} · ${totals.qty} ${totals.qty === 1 ? t('unit') : t('units2')}`;

  const currentIdx = ORDER_STATUSES.indexOf(effectiveStatus as typeof ORDER_STATUSES[number]);
  const purchaserCanReachIdx = isPurchaser
    ? (effectiveStatus === 'Draft' ? ORDER_STATUSES.indexOf('In Transit')
      : effectiveStatus === 'In Transit' ? ORDER_STATUSES.indexOf('Reviewing')
      : currentIdx)
    : ORDER_STATUSES.length - 1;

  return (
    <div className="phone-app">
      <PhHeader
        title={headerTitle}
        sub={headerSub}
        leading={<button className="ph-icon-btn" onClick={onCancel}><Icon name="chevronLeft" size={16} /></button>}
      />
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
          <span style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
            {order.id}
          </span>
        </div>

        <div className="ph-card" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            {ORDER_STATUSES.map((s, i) => {
              const reached = currentIdx >= 0 && i <= currentIdx;
              const active = i === currentIdx;
              const tone = statusTone(s);
              const locked = isPurchaser && i > purchaserCanReachIdx;
              const dotColor = active
                ? `var(--${tone === 'warn' ? 'warn' : tone === 'pos' ? 'pos' : tone === 'info' ? 'info-strong, var(--info)' : 'fg'})`
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
                  <span style={{
                    width: 22, height: 22, borderRadius: '50%',
                    background: reached ? dotColor : 'var(--bg-elev)',
                    border: '2px solid ' + (active ? dotColor : reached ? 'var(--fg)' : 'var(--border-strong)'),
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    color: reached ? 'white' : 'var(--fg-subtle)',
                    fontSize: 10, fontWeight: 700,
                    position: 'relative', zIndex: 1,
                    boxShadow: active ? '0 0 0 3px color-mix(in oklch, ' + dotColor + ' 18%, transparent)' : 'none',
                  }}>
                    {locked ? <Icon name="lock" size={10} /> : (i + 1)}
                  </span>
                  <span style={{
                    fontSize: 10.5, fontWeight: active ? 600 : 500,
                    color: active ? 'var(--fg)' : 'var(--fg-subtle)',
                    textAlign: 'center', lineHeight: 1.1,
                  }}>{s}</span>
                </div>
              );
            })}
          </div>

          {nextStatus && (
            <button
              className="ph-btn dark"
              style={{ width: '100%', marginTop: 14, height: 44 }}
              onClick={advance}
              disabled={!canAdvance}
            >
              <Icon name="flag" size={14} />
              {advancing
                ? t('advancing')
                : (nextStatus === 'Done'
                    ? t('lifecycleMarkDone')
                    : t('lifecycleAdvance', { status: nextStatus }))}
            </button>
          )}
          {!nextStatus && orderLocked && (
            <div style={{
              marginTop: 12, padding: '8px 12px', borderRadius: 10,
              background: 'var(--bg-soft)', color: 'var(--fg-subtle)',
              fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
              border: '1px solid var(--border)',
            }}>
              <Icon name="lock" size={12} /> {t('lifecycleDoneNote')}
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

        {shipmentCount > 0 && (
          <button
            className="ph-row"
            onClick={() => navigate(`/shipping/${order.id}`)}
            style={{ width: '100%', marginTop: 12, fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer' }}
          >
            <div className="ph-inv-thumb" style={{ width: 34, height: 34 }}>
              <Icon name="truck" size={15} />
            </div>
            <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>
              {t('shipPanelTitle')} <span className="mono" style={{ color: 'var(--fg-subtle)' }}>· {shipmentCount}</span>
            </div>
            <Icon name="chevronRight" size={15} className="arrow" />
          </button>
        )}

        <div className="ph-section-h">
          <span>{t('products')} · {order.lines.length}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {order.lines.map((l, i) => {
            const shots = linePhotos(l);
            const shown = expandedPhotos.has(l.id) ? shots : shots.slice(0, PHOTOS_COLLAPSED);
            const hidden = shots.length - shown.length;
            return (
            <div
              key={l.id}
              className="ph-line"
              onClick={canEditOrder ? () => { void editLine(i); } : undefined}
              style={canEditOrder ? { cursor: 'pointer' } : undefined}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="lb-rank" style={{ width: 22, height: 22, fontSize: 11 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {l.category === 'Other' && !!(l.itemType ?? '').trim() && (
                      <span className="chip">{l.itemType}</span>
                    )}
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{itemLabel(l) || '—'}</span>
                  </div>
                  {lineHasSpecChips(l)
                    ? <LineSpecChips line={l} />
                    : l.partNumber && (
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.partNumber}
                      </div>
                    )}
                  {l.serialNumber && (
                    <div style={{ marginTop: 5 }}>
                      <SerialNumbers raw={l.serialNumber} max={4} size={10.5} />
                    </div>
                  )}
                </div>
                {canEditOrder && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); void editLine(i); }}
                      className="ph-icon-btn"
                      style={{ width: 28, height: 28, color: 'var(--fg-subtle)' }}
                      aria-label={t('edit')}
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setRemovingLineId(l.id); }}
                      className="ph-icon-btn"
                      style={{ width: 28, height: 28, color: 'var(--fg-subtle)' }}
                      aria-label={t('delete')}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </>
                )}
              </div>
              {/* Every picture the line carries, not just the first — the
                  phone is where they are taken, so it is where they are
                  checked. Taps stop here: the card itself opens the editor. */}
              {shots.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {shown.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={e => { e.stopPropagation(); setLightboxUrl(p.url); }}
                      title={p.filename ?? t('linePhotos')}
                      style={{
                        width: 44, height: 44, borderRadius: 8, flexShrink: 0,
                        border: '1px solid var(--border)', overflow: 'hidden',
                        padding: 0, background: 'var(--bg-soft)', cursor: 'pointer',
                      }}
                    >
                      <img
                        src={p.url}
                        alt={t('linePhotos')}
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                    </button>
                  ))}
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        setExpandedPhotos(prev => new Set(prev).add(l.id));
                      }}
                      aria-label={t('linePhotosShowAll', { n: hidden })}
                      style={{
                        width: 44, height: 44, borderRadius: 8, flexShrink: 0,
                        border: '1px dashed var(--border-strong)', background: 'var(--bg-soft)',
                        color: 'var(--fg-muted)', fontFamily: 'inherit',
                        fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0,
                      }}
                    >
                      +{hidden}
                    </button>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                <span>{t('qty')} <span style={{ color: 'var(--accent-strong)', fontWeight: 700, background: 'var(--accent-soft)', padding: '0 6px', borderRadius: 6, fontVariantNumeric: 'tabular-nums' }}>{l.qty}</span> · {fmtUSD(l.unitCost, locale)}</span>
                <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(l.qty * l.unitCost, locale)}</span>
              </div>
            </div>
            );
          })}
        </div>

        {/* One target per category, matching the capture screen. A single
            "Add another" button would put the old category lock back in the
            user's head — the PO is not in a mode. */}
        {canEditOrder && (
          <div style={{ marginTop: 14 }}>
            <div style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.09em',
              textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 8,
            }}>
              {t('addToThisOrder')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 7 }}>
              {addableCategories().map(cat => (
                <button
                  key={cat}
                  onClick={() => { void addLine(cat as Category); }}
                  aria-label={t('subAddCatLine', { cat })}
                  style={{
                    minHeight: 54, borderRadius: 13,
                    border: '1.5px dashed ' + categoryTone(cat).tone,
                    background: 'var(--bg-elev)', color: categoryTone(cat).strong,
                    fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
                    display: 'grid', placeItems: 'center', alignContent: 'center', gap: 1,
                    padding: '6px 2px', cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: 15, lineHeight: 1, opacity: 0.75 }}>+</span>
                  <span>{cat}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* The money sits directly under the lines it comes from: on a phone
            this is what the screen is for, and the order's warehouse and
            payment type were answered once and are rarely revisited. */}
        <div className="ph-card" style={{ marginTop: 16, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {t('costBreakdown')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontVariantNumeric: 'tabular-nums' }}>
              {totals.qty} {totals.qty === 1 ? t('unit') : t('units2')} · {order.lines.length} {order.lines.length === 1 ? t('item') : t('items')}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 10 }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('commissionRate')}</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {order.commissionRate != null ? (order.commissionRate * 100).toFixed(2) + '%' : '—'}
            </span>
          </div>

          {order.paypalTxnId && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 8 }}>
              <span style={{ color: 'var(--fg-subtle)' }}>{t('poPaypalTxn')}</span>
              <span className="mono" style={{ fontWeight: 600 }}>{order.paypalTxnId}</span>
            </div>
          )}

          {/* Goods, then fees, then the total they add up to — the same stack
              the desktop edit page shows, so the number is never a surprise. */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
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
        </div>

        <div className="ph-section-h"><span>{t('orderDetails')}</span></div>

        <div className="ph-field" style={{ marginTop: 0 }}>
          <label>{t('warehouse')}</label>
          <div style={{ position: 'relative' }}>
            <select
              value={warehouseId}
              onChange={e => setMeta({ warehouseId: e.target.value })}
              disabled={!canEditOrder}
              style={{
                width: '100%',
                appearance: 'none',
                WebkitAppearance: 'none',
                MozAppearance: 'none',
                border: '1px solid var(--border)',
                background: 'var(--bg-elev)',
                color: 'var(--fg)',
                padding: '11px 36px 11px 12px',
                borderRadius: 10,
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: canEditOrder ? 'pointer' : 'not-allowed',
                outline: 'none',
                opacity: canEditOrder ? 1 : 0.6,
              }}
            >
              {warehouses.length === 0 && (
                <option value={warehouseId}>{order.warehouse?.name ?? order.warehouse?.short ?? '—'}</option>
              )}
              {warehouses.map(w => (
                <option key={w.id} value={w.id}>{w.short} — {w.region}</option>
              ))}
            </select>
            <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--fg-subtle)', display: 'flex' }}>
              <Icon name="chevronDown" size={14} />
            </div>
          </div>
        </div>

        <div className="ph-field">
          <label>{t('payment')}</label>
          <div className="seg" style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
            <button
              className={payment === 'company' ? 'active' : ''}
              onClick={() => canEditOrder && setMeta({ payment: 'company' })}
              disabled={!canEditOrder}
            >{t('payCompany')}</button>
            <button
              className={payment === 'self' ? 'active' : ''}
              onClick={() => canEditOrder && setMeta({ payment: 'self' })}
              disabled={!canEditOrder}
            >{t('paySelf')}</button>
          </div>
        </div>

        <div className="ph-field">
          <label>{t('orderNotes')}</label>
          <textarea
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
                  onRemove={canAnnotate ? () => removeSubmissionAtt(a.id) : undefined}
                />
              ))}
              {canAnnotate && (
                <AttachmentDropzone
                  boxHint={t('poSubmitAttachHint')}
                  uploading={submissionUploading}
                  onFiles={addSubmissionFiles}
                />
              )}
            </div>
          </div>
        )}

        {/* Collapsed: it is the longest block on the page and the least often
            read. The header still states the count, so it costs one tap. */}
        <div style={{ marginTop: 14 }}>
          <OrderActivityLog orderId={order.id} refreshKey={activityRefreshKey} defaultOpen={false} />
        </div>

      </div>

      <div className="ph-action-bar">
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
                  onSaved(t('orderRestoredToast'));
                } catch (e) {
                  handleFetchError(e);
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
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !archiving) setShowArchive(false); }}>
          <div className="modal-shell" style={{ maxWidth: 380, width: '92vw' }} onClick={e => e.stopPropagation()}>
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
                  <div className="modal-title">{t('archivePromptTitle', { id: order.id })}</div>
                  <div className="modal-sub">
                    {t('archivePromptSub')}
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setShowArchive(false)} disabled={archiving}>
                {t('cancel')}
              </button>
              <button
                className="btn accent"
                disabled={archiving}
                onClick={async () => {
                  setArchiving(true);
                  try {
                    await archiveOrder(order.id);
                    onSaved(t('orderArchivedToast'));
                  } catch (e) {
                    handleFetchError(e);
                    setArchiving(false);
                    setShowArchive(false);
                  }
                }}
              >
                {archiving ? '…' : t('archive')}
              </button>
            </div>
          </div>
        </div>
      )}

      {lightboxUrl && (
        <ImageLightbox url={lightboxUrl} alt={t('aiPhotoLabel')} onClose={() => setLightboxUrl(null)} />
      )}

      {doneDialogOpen && (
        <StatusChangeDialog
          orderId={order.id}
          to="Done"
          currentStatus={effectiveStatus}
          initialNote={doneMeta?.note ?? ''}
          initialAttachments={doneMeta?.attachments ?? []}
          apiBase="/api/orders"
          variant="purchase"
          // Evidence live-saves inside the dialog, so a cancel still needs a
          // refetch for the read-only block to reflect what was uploaded.
          onCancel={() => { setDoneDialogOpen(false); refetchOrder(); }}
          onConfirm={async () => { setDoneDialogOpen(false); await doAdvance(); }}
          onMutated={() => setActivityRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}
