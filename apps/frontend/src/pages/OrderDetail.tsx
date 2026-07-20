import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { ImageLightbox } from '../components/ImageLightbox';
import { OrderActivityLog } from '../components/OrderActivityLog';
import { StatusChangeDialog } from '../components/StatusChangeDialog';
import { AttachmentChip } from '../components/AttachmentChip';
import { LineSpecChips, lineHasSpecChips } from '../components/LineSpecChips';
import { SerialNumbers } from '../components/SerialNumbers';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { api, deleteOrder, archiveOrder, unarchiveOrder } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import { ORDER_STATUSES, statusTone, isCompleted } from '../lib/status';
import type { Order, OrderLine, Warehouse } from '../lib/types';

// `order.status` can collapse to 'Mixed' when an order's lines disagree, which
// would falsely lock the owner out. `lifecycle` is authoritative, so we map it
// to the canonical status and only fall back for unknown lifecycles.
const LIFECYCLE_STATUS: Record<string, string> = {
  draft: 'Draft',
  in_transit: 'In Transit',
  reviewing: 'Reviewing',
  done: 'Done',
};

const realScan = (u?: string | null): u is string =>
  !!u && !u.startsWith('data:image/placeholder');

type Props = {
  order: Order;
  onCancel: () => void;
  onSaved: (msg: string) => void;
  onDeleted: () => void;
  onEditItems: (order: Order) => void;
};

export function OrderDetail({ order: initialOrder, onCancel, onSaved, onDeleted, onEditItems }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const { user } = useAuth();
  const [order, setOrder] = useState<Order>(initialOrder);
  useEffect(() => { setOrder(initialOrder); }, [initialOrder]);

  const isPurchaser = user?.role !== 'manager';
  const effectiveStatus = LIFECYCLE_STATUS[order.lifecycle] ?? order.status;
  const orderLocked = isCompleted(effectiveStatus);
  const purchaserCanEdit =
    !isPurchaser || effectiveStatus === 'Draft' || effectiveStatus === 'In Transit';
  const canEditOrder = purchaserCanEdit && !orderLocked;
  const canDelete = canEditOrder && effectiveStatus === 'Draft';

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState<string>(order.warehouse?.id ?? '');
  const [payment, setPayment] = useState<'company' | 'self'>(order.payment);
  const [notes, setNotes] = useState<string>(order.notes ?? '');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [doneDialogOpen, setDoneDialogOpen] = useState(false);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [showDelete, setShowDelete] = useState(false);
  const [typedId, setTypedId] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Archive (mobile): owner-or-manager, non-Draft. No type-to-confirm —
  // archive is reversible so we keep the gesture short, matching the
  // platform's "one tap, one sheet" rhythm.
  const isArchived = !!order.archivedAt;
  const isOwnerOrManager = !isPurchaser || order.userId === user?.id;
  const canArchive = isOwnerOrManager && effectiveStatus !== 'Draft';
  const [showArchive, setShowArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);

  // Reset meta inputs when the order itself changes (e.g. refetch after save).
  useEffect(() => {
    setWarehouseId(order.warehouse?.id ?? '');
    setPayment(order.payment);
    setNotes(order.notes ?? '');
  }, [order.id, order.warehouse?.id, order.payment, order.notes]);

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

  const notesDirty = (notes || '') !== (order.notes || '');
  const warehouseDirty = (warehouseId || '') !== (order.warehouse?.id ?? '');
  const paymentDirty = payment !== order.payment;
  const dirty = notesDirty || warehouseDirty || paymentDirty;

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

  const save = async () => {
    if (!canEditOrder) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/api/orders/${order.id}`, {
        notes:       notesDirty     ? notes                 : undefined,
        warehouseId: warehouseDirty ? (warehouseId || null) : undefined,
        payment:     paymentDirty   ? payment               : undefined,
      });
      await refetchOrder();
      setActivityRefreshKey(k => k + 1);
      onSaved(t('savedShort'));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Purchasers cap at Reviewing; managers can move all the way to Done.
  const nextStatus: string | null = (() => {
    if (effectiveStatus === 'Draft') return 'In Transit';
    if (effectiveStatus === 'In Transit') return 'Reviewing';
    if (effectiveStatus === 'Reviewing' && !isPurchaser) return 'Done';
    return null;
  })();
  const canAdvance = !!nextStatus && !advancing && !saving;

  const doAdvance = async () => {
    setAdvancing(true);
    setAdvanceError(null);
    try {
      await api.post(`/api/orders/${order.id}/advance`, {});
      await refetchOrder();
      setActivityRefreshKey(k => k + 1);
    } catch (e) {
      setAdvanceError(e instanceof Error ? e.message : 'Advance failed');
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
          {advanceError && (
            <div role="alert" style={{ marginTop: 8, fontSize: 12, color: 'var(--neg)' }}>
              {advanceError}
            </div>
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

        <div className="ph-section-h">
          <span>{t('lineItems', { cat: order.category })} · {order.lines.length}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {order.lines.map((l, i) => (
            <div key={l.id} className="ph-line">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="lb-rank" style={{ width: 22, height: 22, fontSize: 11 }}>{i + 1}</span>
                {realScan(l.scanImageUrl) && (
                  <button
                    type="button"
                    onClick={() => setLightboxUrl(l.scanImageUrl!)}
                    title={t('aiPhotoLabel')}
                    style={{
                      width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                      border: '1px solid var(--border)', overflow: 'hidden',
                      padding: 0, background: 'var(--bg-soft)', cursor: 'pointer',
                    }}
                  >
                    <img
                      src={l.scanImageUrl}
                      alt={t('aiPhotoLabel')}
                      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                    />
                  </button>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {itemLabel(l) || '—'}
                  </div>
                  {lineHasSpecChips(l)
                    ? <LineSpecChips line={l} />
                    : (
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.partNumber ?? '—'}
                      </div>
                    )}
                  {l.serialNumber && (
                    <div style={{ marginTop: 5 }}>
                      <SerialNumbers raw={l.serialNumber} max={4} size={10.5} />
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                <span>Qty <span style={{ color: 'var(--accent-strong)', fontWeight: 700, background: 'var(--accent-soft)', padding: '0 6px', borderRadius: 6, fontVariantNumeric: 'tabular-nums' }}>{l.qty}</span> · {fmtUSD(l.unitCost, locale)}</span>
                <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(l.qty * l.unitCost, locale)}</span>
              </div>
            </div>
          ))}
        </div>

        {!orderLocked && (
          <button
            className="ph-btn ghost"
            style={{
              width: '100%', marginTop: 10, height: 44,
              border: '1.5px dashed var(--border-strong)', borderRadius: 12,
            }}
            onClick={() => onEditItems(order)}
          >
            <Icon name="edit" size={14} /> {t('editItems')}
          </button>
        )}

        <div className="ph-section-h"><span>{t('orderDetails')}</span></div>

        <div className="ph-field" style={{ marginTop: 0 }}>
          <label>{t('warehouse')}</label>
          <div style={{ position: 'relative' }}>
            <select
              value={warehouseId}
              onChange={e => setWarehouseId(e.target.value)}
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
              onClick={() => canEditOrder && setPayment('company')}
              disabled={!canEditOrder}
            >{t('payCompany')}</button>
            <button
              className={payment === 'self' ? 'active' : ''}
              onClick={() => canEditOrder && setPayment('self')}
              disabled={!canEditOrder}
            >{t('paySelf')}</button>
          </div>
        </div>

        <div className="ph-field">
          <label>{t('orderNotes')}</label>
          <textarea
            className="input"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={t('orderNotesPh')}
            rows={3}
            disabled={!canEditOrder}
            style={{ width: '100%', resize: 'vertical', minHeight: 70, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.45, padding: '10px 12px' }}
          />
        </div>

        <div className="ph-card" style={{ marginTop: 14, padding: '12px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('commissionRate')}</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {order.commissionRate != null ? (order.commissionRate * 100).toFixed(2) + '%' : '—'}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('totalCost')}</span>
            <span className="mono" style={{ fontWeight: 600 }}>
              {fmtUSD(order.totalCost ?? totals.cost, locale)}
            </span>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <OrderActivityLog orderId={order.id} refreshKey={activityRefreshKey} />
        </div>

        {saveError && (
          <div role="alert" style={{ marginTop: 12, fontSize: 12, color: 'var(--neg)' }}>
            {saveError}
          </div>
        )}
      </div>

      <div className="ph-action-bar">
        <button className="ph-btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button
          className="ph-icon-btn"
          onClick={() => api.download(`/api/orders/${order.id}/invoice`, `${order.id}.pdf`).catch(handleFetchError)}
          aria-label={t('downloadPo')}
          style={{
            width: 50, height: 50, borderRadius: 14,
            border: '1px solid var(--border-strong)',
            background: 'var(--bg-elev)', color: 'var(--fg-muted)',
            flex: '0 0 auto',
          }}
        >
          <Icon name="download" size={16} />
        </button>
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
          <Icon name="file" size={16} />
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
        {dirty && canEditOrder && (
          <button
            className="ph-btn dark"
            onClick={save}
            disabled={saving}
          >
            <Icon name="check" size={16} /> {saving ? '…' : t('save')}
          </button>
        )}
      </div>

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
