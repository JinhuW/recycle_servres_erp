import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api, deleteOrder, listShipments } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { handleFetchError } from '../../lib/errorToast';
import { fmtMoney } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/route';
import type { Order, OrderSummary, Shipment, Warehouse } from '../../lib/types';
import { LabelFlowModal, ShippingPanel } from './ShippingPanel';

// Dedicated shipping-labels page (#/shipping, #/shipping/:orderId).
//
// Label-first: "New prepaid label" auto-creates an empty draft PO (the label
// needs a destination warehouse anyway) and runs the existing label flow
// against it — the PO gets its lines later, when the goods arrive.
//
// UI-only pass: the cross-PO list is composed client-side from the newest
// orders (no backend list endpoint yet), and the draft → In Transit advance
// fires opportunistically when this page observes carrier movement. Both get
// proper backend counterparts in the backend phase.

type ToastKind = 'success' | 'error';
type Props = {
  orderId: string | null;
  showToast: (msg: string, kind?: ToastKind) => void;
};

const ORDERS_SCANNED = 30;

const STATUS_CHIP: Record<Shipment['status'], { cls: string; key: string }> = {
  draft: { cls: 'muted', key: 'shipStatusDraft' },
  quoted: { cls: 'muted', key: 'shipStatusQuoted' },
  purchased: { cls: 'accent', key: 'shipStatusPurchased' },
  in_transit: { cls: 'info', key: 'shipStatusInTransit' },
  delivered: { cls: 'pos', key: 'shipStatusDelivered' },
  voided: { cls: 'neg', key: 'shipStatusVoided' },
  exception: { cls: 'warn', key: 'shipStatusException' },
};

export function DesktopShipping({ orderId, showToast }: Props) {
  return orderId
    ? <FocusedShipping orderId={orderId} />
    : <GlobalShipping showToast={showToast} />;
}

// ── /shipping/:orderId — one PO's labels, full panel with all actions ────────

function FocusedShipping({ orderId }: { orderId: string }) {
  const { t } = useT();
  const { user } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setOrder(null);
    api.get<{ order: Order }>(`/api/orders/${orderId}`)
      .then(r => { if (alive) setOrder(r.order); })
      .catch((e) => { if (alive) { setFailed(true); handleFetchError(e); } });
    return () => { alive = false; };
  }, [orderId]);

  const canEdit = !!order && !order.archivedAt && order.lifecycle !== 'done'
    && (user?.role === 'manager' || order.userId === user?.id);

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <button className="btn ghost sm" onClick={() => navigate(`/purchase-orders/${orderId}`)}>
          ← {orderId}
        </button>
        <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
          {t('shipPageTitle')}
        </span>
      </div>
      {failed && (
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', padding: '16px 0' }}>
          {t('shipPageOrderMissing')}
        </div>
      )}
      {order && (
        <ShippingPanel orderId={orderId} canEdit={canEdit} onMutated={() => { /* page has no fee display */ }} />
      )}
    </div>
  );
}

// ── /shipping — every recent label + label-first creation ────────────────────

type PoLabels = { order: OrderSummary; shipments: Shipment[] };

function GlobalShipping({ showToast }: { showToast: (msg: string, kind?: ToastKind) => void }) {
  const { t } = useT();
  const [sections, setSections] = useState<PoLabels[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  // One advance attempt per PO per page-load; a failed attempt (403/409) is
  // not retried — the backend is the authority.
  const advanceTried = useRef(new Set<string>());

  const reload = useCallback(async () => {
    try {
      const { orders } = await api.get<{ orders: OrderSummary[] }>(`/api/orders?limit=${ORDERS_SCANNED}`);
      const withShipments = await Promise.all(
        orders.map(async (order) => ({
          order,
          shipments: (await listShipments(order.id).catch(() => ({ items: [] as Shipment[] }))).items,
        })),
      );
      setSections(withShipments.filter(s => s.shipments.length > 0));
    } catch (e) {
      handleFetchError(e);
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // The confirmed rule, UI-side for now: carrier movement moves the draft PO
  // to In Transit. Runs after each load against what the page can see.
  useEffect(() => {
    for (const s of sections) {
      if (s.order.lifecycle !== 'draft') continue;
      if (!s.shipments.some(sh => sh.status === 'in_transit')) continue;
      if (advanceTried.current.has(s.order.id)) continue;
      advanceTried.current.add(s.order.id);
      api.post(`/api/orders/${s.order.id}/advance`, {})
        .then(() => {
          showToast(t('shipAutoAdvanced', { id: s.order.id }));
          void reload();
        })
        .catch(() => { /* lifecycle already moved, or not ours to move */ });
    }
  }, [sections, reload, showToast, t]);

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>{t('shipPageTitle')}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 2 }}>{t('shipPageSub')}</div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn accent" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> {t('shipNewLabel')}
        </button>
      </div>

      {!loaded && (
        <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[0, 1, 2].map(i => (
            <span key={i} className="skeleton" style={{ width: `${70 - i * 12}%`, height: 13, borderRadius: 4 }} aria-hidden />
          ))}
        </div>
      )}

      {loaded && sections.length === 0 && (
        <div className="card" style={{ padding: '28px 22px', textAlign: 'center' }}>
          <Icon name="truck" size={22} />
          <div style={{ fontSize: 14, fontWeight: 650, marginTop: 8 }}>{t('shipEmptyPageTitle')}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4, maxWidth: 420, marginInline: 'auto' }}>
            {t('shipEmptyPageBody')}
          </div>
        </div>
      )}

      {sections.map(({ order, shipments }) => (
        <div key={order.id} className="card" style={{ padding: 0, marginBottom: 14 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '11px 16px', borderBottom: '1px solid var(--border)',
          }}>
            <button
              className="mono"
              onClick={() => navigate(`/purchase-orders/${order.id}`)}
              style={{
                font: 'inherit', fontWeight: 650, fontSize: 13, cursor: 'pointer',
                background: 'var(--bg-soft)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '2px 8px', color: 'var(--fg)',
              }}
            >{order.id}</button>
            <span className="chip muted" style={{ fontSize: 10.5 }}>
              {order.lifecycle === 'draft' ? t('shipStatusDraft')
                : order.lifecycle === 'in_transit' ? t('shipStatusInTransit')
                : order.lifecycle}
            </span>
            <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{order.userName}</span>
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={() => navigate(`/shipping/${order.id}`)}>
              {t('shipOpenPo')} →
            </button>
          </div>
          {shipments.map((s) => {
            const chip = STATUS_CHIP[s.status];
            return (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                padding: '10px 16px', borderBottom: '1px solid var(--border)',
                fontSize: 13,
              }}>
                <span style={{ fontWeight: 600 }}>
                  {s.carrier ? `${s.carrier} ${s.service ?? ''}`.trim()
                    : s.from.name ? t('shipBoxFrom', { name: s.from.name })
                    : t('shipAwaitingSellerTitle')}
                </span>
                <span className={'chip dot ' + chip.cls} style={{ fontSize: 10.5 }}>{t(chip.key)}</span>
                {s.trackingNumber && (
                  <span className="mono" style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{s.trackingNumber}</span>
                )}
                <span style={{ flex: 1 }} />
                {s.labelCost != null && (
                  <span className="mono" style={{
                    fontWeight: 600,
                    textDecoration: s.status === 'voided' ? 'line-through' : 'none',
                    color: s.status === 'voided' ? 'var(--fg-subtle)' : 'inherit',
                  }}>{fmtMoney(s.labelCost, s.rateCurrency)}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {loaded && sections.length > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
          {t('shipCapNote', { n: ORDERS_SCANNED })}
        </div>
      )}

      {creating && (
        <LabelFirstFlow
          onClose={() => setCreating(false)}
          onDone={(poId) => {
            setCreating(false);
            showToast(t('shipLabelFirstCreated', { id: poId }));
            void reload();
          }}
        />
      )}
    </div>
  );
}

// ── Label-first: pick a warehouse → auto-create draft PO → label flow ────────

function LabelFirstFlow({ onClose, onDone }: {
  onClose: () => void;
  onDone: (poId: string) => void;
}) {
  const { t } = useT();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [busy, setBusy] = useState(false);
  const [poId, setPoId] = useState<string | null>(null);
  // Whether the label flow produced anything (a shipment or a seller link).
  // Closing without either deletes the auto-created empty draft again.
  const produced = useRef(false);

  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => {
        setWarehouses(r.items);
        if (r.items.length === 1) setWarehouseId(r.items[0].id);
      })
      .catch(handleFetchError);
  }, []);

  const chosen = warehouses.find(w => w.id === warehouseId);
  const noShipAddr = !!chosen && !chosen.shipStreet1;

  const start = async () => {
    setBusy(true);
    try {
      // The note marks the draft's origin so it reads sensibly in the PO list
      // until its lines arrive with the goods.
      const r = await api.post<{ id: string }>('/api/orders/draft', {
        warehouseId,
        notes: 'Created from shipping label',
      });
      setPoId(r.id);
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  const abandon = () => {
    // No shipment, no seller link → an empty draft nobody asked for.
    if (poId && !produced.current) void deleteOrder(poId).catch(() => { /* keep it, harmless */ });
    onClose();
  };

  if (poId) {
    return (
      <LabelFlowModal
        orderId={poId}
        existing={null}
        onClose={abandon}
        onDone={() => { produced.current = true; onDone(poId); }}
        onSellerLinked={() => { produced.current = true; }}
      />
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{t('shipPickWhTitle')}</div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: 10 }}>{t('shipPickWhHint')}</div>
          <div className="field">
            <label className="label">{t('warehouse')} <span className="req">*</span></label>
            <select className="select" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              <option value="">{warehouses.length ? '—' : t('loadingApp')}</option>
              {warehouses.map(w => (
                <option key={w.id} value={w.id}>{w.name ?? w.short} · {w.region}</option>
              ))}
            </select>
          </div>
          {noShipAddr && (
            <div style={{
              marginTop: 10, display: 'flex', gap: 8,
              background: 'var(--warn-soft)', color: 'var(--warn-strong)',
              border: '1px solid color-mix(in oklch, var(--warn-strong) 25%, transparent)',
              borderRadius: 8, padding: '9px 12px', fontSize: 12.5, lineHeight: 1.45,
            }}>
              {t('shipPickWhNoAddr')}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn accent" onClick={start} disabled={busy || !warehouseId}>
            {busy ? '…' : t('shipPickWhStart')}
          </button>
        </div>
      </div>
    </div>
  );
}
