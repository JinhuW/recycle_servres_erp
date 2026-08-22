import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { TableSkeleton } from '../../components/Skeleton';
import { api, listShipments } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDateShort, fmtMoney } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePersisted } from '../../lib/listMemory';
import { navigate, type ShippingRoute } from '../../lib/route';
import {
  STATUS_CHIP, carriersOf, filterRows, flattenRows, fmtEta, rowsToCsv, statusCounts,
  type PoLabels, type ShipRow,
} from '../../lib/shippingList';
import { useEffectiveUser } from '../../lib/tweaks';
import type { Order, OrderSummary, ShipmentStatus } from '../../lib/types';
import { ShippingLabelWizard } from './ShippingLabelWizard';
import { ShippingPanel } from './ShippingPanel';

// Dedicated shipping-labels area:
//   #/shipping                    — cross-PO shipments table
//   #/shipping/new                — label-first wizard (draft PO created with it)
//   #/shipping/:orderId           — one PO's labels, full panel
//   #/shipping/:orderId/label(/:sid) — wizard for a new / pending label on a PO
//
// UI-only pass: the cross-PO list is composed client-side from the newest
// orders (no backend list endpoint yet), and the draft → In Transit advance
// fires opportunistically when this page observes carrier movement. Both get
// proper backend counterparts in the backend phase.

type ToastKind = 'success' | 'error';
type Props = {
  route: ShippingRoute;
  showToast: (msg: string, kind?: ToastKind) => void;
};

const ORDERS_SCANNED = 30;

// Status → dot colour for the rail; chip tones stay in STATUS_CHIP.
const TONE_VAR: Record<string, string> = {
  pos: 'var(--pos)', neg: 'var(--neg)', warn: 'var(--warn)',
  info: 'var(--info)', accent: 'var(--accent)', muted: 'var(--fg-subtle)',
};

const RAIL_ORDER: ShipmentStatus[] = ['draft', 'quoted', 'purchased', 'in_transit', 'delivered', 'exception', 'voided'];

export function DesktopShipping({ route, showToast }: Props) {
  const { t } = useT();
  return (
    <>
      <div className="ship-wip-banner" role="alert">
        <Icon name="alert" size={14} />
        <span>{t('shipNotReadyBanner')}</span>
      </div>
      {route.kind === 'dashboard' && <GlobalShipping showToast={showToast} />}
      {(route.kind === 'wizardNew' || route.kind === 'wizardPo') && (
        <ShippingLabelWizard
          key={route.kind === 'wizardPo' ? `${route.orderId}/${route.sid ?? 'new'}` : 'new'}
          orderId={route.kind === 'wizardPo' ? route.orderId : null}
          sid={route.kind === 'wizardPo' ? route.sid : null}
          showToast={showToast}
        />
      )}
      {route.kind === 'focus' && <FocusedShipping orderId={route.orderId} />}
    </>
  );
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
    <div className="ship-focus">
      <div className="ship-focus-head">
        <button className="btn ghost sm" onClick={() => navigate(`/purchase-orders/${orderId}`)}>
          ← {orderId}
        </button>
        <span className="ship-focus-title">{t('shipPageTitle')}</span>
      </div>
      {failed && <div className="ship-focus-missing">{t('shipPageOrderMissing')}</div>}
      {order && (
        <ShippingPanel
          orderId={orderId}
          canEdit={canEdit}
          orderLifecycle={order.lifecycle}
          onMutated={() => { /* page has no fee display */ }}
        />
      )}
    </div>
  );
}

// ── /shipping — the shipments table ──────────────────────────────────────────

function GlobalShipping({ showToast }: { showToast: (msg: string, kind?: ToastKind) => void }) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const user = useEffectiveUser();
  const isManager = user?.role === 'manager';
  const [sections, setSections] = useState<PoLabels[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // One advance attempt per PO per page-load; a failed attempt (403/409) is
  // not retried — the backend is the authority.
  const advanceTried = useRef(new Set<string>());

  const [scope, setScope] = usePersisted<'all' | 'mine'>('desktop.shipping.scope', 'all');
  const [status, setStatus] = usePersisted<ShipmentStatus | 'all'>('desktop.shipping.status', 'all');
  const [carrier, setCarrier] = usePersisted<string>('desktop.shipping.carrier', 'all');
  const [search, setSearch] = usePersisted<string>('desktop.shipping.search', '');

  const reload = useCallback(async () => {
    try {
      const mine = isManager && scope === 'mine' ? '&mine=true' : '';
      const { orders } = await api.get<{ orders: OrderSummary[] }>(`/api/orders?limit=${ORDERS_SCANNED}${mine}`);
      const withShipments = await Promise.all(
        orders.map(async (order) => ({
          order,
          shipments: (await listShipments(order.id).catch(() => ({ items: [] as never[] }))).items,
        })),
      );
      setSections(withShipments.filter(s => s.shipments.length > 0));
    } catch (e) {
      handleFetchError(e);
    } finally {
      setLoaded(true);
    }
  }, [isManager, scope]);
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

  const rows = useMemo(() => flattenRows(sections), [sections]);
  const carriers = useMemo(() => carriersOf(rows), [rows]);
  // Rail counts reflect the carrier + search narrowing, not the status pick —
  // same layering as the orders page (counts answer "of what I'm looking at").
  const searchScoped = useMemo(
    () => filterRows(rows, { status: 'all', carrier, search }),
    [rows, carrier, search],
  );
  const counts = useMemo(() => statusCounts(searchScoped), [searchScoped]);
  const visible = useMemo(
    () => filterRows(rows, { status, carrier, search }),
    [rows, status, carrier, search],
  );

  const copyTracking = (tn: string) => {
    navigator.clipboard?.writeText(tn)
      .then(() => { setCopied(tn); setTimeout(() => setCopied(null), 1600); })
      .catch(() => { /* the visible number is selectable */ });
  };

  const exportCsv = () => {
    const blob = new Blob([rowsToCsv(visible)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shipments.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('shipPageTitle')}</h1>
          <div className="page-sub">{t('shipPageSub')}</div>
        </div>
        <div className="page-actions">
          <button className="btn accent" onClick={() => navigate('/shipping/new')}>
            <Icon name="plus" size={14} /> {t('shipBuyLabel')}
          </button>
        </div>
      </div>

      <div className="card ship-card">
        <div className="card-head has-rail" style={{ gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="card-title">{t('shipPageTitle')}</div>
            {isManager && (
              <div className="seg">
                <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>{t('all')}</button>
                <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>{t('shipScopeMine')}</button>
              </div>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{visible.length}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select
              className="select"
              value={carrier}
              onChange={e => setCarrier(e.target.value)}
              style={{ height: 32, fontSize: 12.5 }}
              aria-label={t('shipColRate')}
            >
              <option value="all">{t('shipCarrierAll')}</option>
              {carriers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <div className="toolbar-search">
              <Icon name="search" size={13} />
              <input
                className="input"
                placeholder={t('shipSearchPh')}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <button className="btn" onClick={exportCsv} disabled={visible.length === 0} style={{ height: 32, fontSize: 12.5 }}>
              <Icon name="download" size={12} /> {t('shipExport')}
            </button>
          </div>
        </div>

        <div className="status-rail" role="group" aria-label={t('shipColTracking')}>
          <button
            type="button"
            className="status-chip"
            aria-pressed={status === 'all'}
            onClick={() => setStatus('all')}
          >
            {t('all')}
            <span className="mono sc-n">{counts.all}</span>
          </button>
          {RAIL_ORDER.map(s => {
            const chip = STATUS_CHIP[s];
            const active = status === s;
            return (
              <button
                key={s}
                type="button"
                className={'status-chip' + (counts[s] === 0 ? ' empty' : '')}
                aria-pressed={active}
                onClick={() => setStatus(active ? 'all' : s)}
              >
                <span className="sc-dot" style={{ background: TONE_VAR[chip.cls] ?? 'var(--fg-subtle)' }} />
                {t(chip.key)}
                <span className="mono sc-n">{counts[s]}</span>
              </button>
            );
          })}
        </div>

        <div className="table-scroll">
          {!loaded ? (
            <TableSkeleton rows={8} cols={6} />
          ) : rows.length === 0 ? (
            <div style={{ padding: '48px 22px', textAlign: 'center' }}>
              <Icon name="label" size={22} />
              <div style={{ fontSize: 14, fontWeight: 650, marginTop: 8 }}>{t('shipEmptyPageTitle')}</div>
              <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4, maxWidth: 420, marginInline: 'auto' }}>
                {t('shipEmptyPageBody')}
              </div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('shipColOrder')}</th>
                  <th>{t('shipColFrom')}</th>
                  <th>{t('shipColTo')}</th>
                  <th>{t('shipColRate')}</th>
                  <th>{t('shipColTracking')}</th>
                  <th style={{ width: 190 }} />
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--fg-subtle)' }}>
                    {t('shipNoMatch')}
                  </td></tr>
                )}
                {visible.map(row => (
                  <ShipTableRow
                    key={row.shipment.id}
                    row={row}
                    locale={locale}
                    isManager={isManager}
                    copied={copied}
                    onCopy={copyTracking}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {loaded && rows.length > 0 && (
          <div className="ship-cap-note">{t('shipCapNote', { n: ORDERS_SCANNED })}</div>
        )}
      </div>
    </>
  );
}

function ShipTableRow({ row, locale, isManager, copied, onCopy }: {
  row: ShipRow;
  locale: string;
  isManager: boolean;
  copied: string | null;
  onCopy: (tn: string) => void;
}) {
  const { t } = useT();
  const { order, shipment: s } = row;
  const chip = STATUS_CHIP[s.status];
  const eta = fmtEta(s.trackingEta, locale);
  const waitingSeller = (s.status === 'draft' || s.status === 'quoted') && !s.complete && !!s.sellerToken;
  const showDeliveredCta = s.status === 'delivered' && order.lifecycle !== 'done';
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <tr className="row-hover" style={{ cursor: 'pointer' }} onClick={() => navigate(`/shipping/${order.id}`)}>
      <td>
        <button className="ship-po-pill" onClick={(e) => { stop(e); navigate(`/purchase-orders/${order.id}`); }}>
          {order.id}
        </button>
        <div className="ship-cell-sub">
          {fmtDateShort(s.createdAt, locale)}{isManager ? ` · ${order.userName}` : ''}
        </div>
      </td>
      <td>
        {s.from.name
          ? <span style={{ fontWeight: 600 }}>{s.from.name}</span>
          : waitingSeller
            ? <span className="chip warn dot" style={{ fontSize: 11 }}>{t('shipWaitingSeller')}</span>
            : <span className="muted">—</span>}
        {(s.from.city || s.from.state) && (
          <div className="ship-cell-sub">{[s.from.city, s.from.state].filter(Boolean).join(', ')}</div>
        )}
      </td>
      <td>
        {order.warehouse
          ? (
            <>
              <span style={{ fontWeight: 600 }}>{order.warehouse.name ?? order.warehouse.short}</span>
              <div className="ship-cell-sub">{order.warehouse.region}</div>
            </>
          )
          : <span className="muted">—</span>}
      </td>
      <td>
        {s.carrier ? (
          <>
            <span className="ship-carrier-chip">{s.carrier}</span>{' '}
            <span style={{ fontSize: 12.5 }}>{s.service}</span>
            <div className="ship-cell-sub">
              {s.labelCost != null && (
                <span className={'mono'} style={{
                  fontWeight: 600,
                  textDecoration: s.status === 'voided' ? 'line-through' : 'none',
                }}>{fmtMoney(s.labelCost, s.rateCurrency)}</span>
              )}
              {s.labelCost != null && eta && s.status !== 'delivered' && s.status !== 'voided' && ' · '}
              {eta && s.status !== 'delivered' && s.status !== 'voided' && t('shipEstDelivery', { eta })}
              {s.provider === 'stub' && s.status !== 'draft' && s.status !== 'quoted' && (
                <> <span className="chip muted" style={{ fontSize: 10 }}>{t('shipDemoTag')}</span></>
              )}
            </div>
          </>
        ) : <span className="muted">—</span>}
      </td>
      <td className={'ship-track ' + chip.cls}>
        <span className={'chip dot ' + chip.cls} style={{ fontSize: 11 }}>{t(chip.key)}</span>
        {s.trackingNumber && (
          <div className="ship-cell-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="ship-copy-btn mono"
              title={t('shipCopyTracking')}
              onClick={(e) => { stop(e); onCopy(s.trackingNumber!); }}
            >
              {s.trackingNumber}
              <span className={'ship-copy-hint' + (copied === s.trackingNumber ? ' done' : '')}>
                {copied === s.trackingNumber ? t('shipCopied') : t('shipCopy')}
              </span>
            </button>
            {s.trackingUrl && (
              <a href={s.trackingUrl} target="_blank" rel="noreferrer" onClick={stop} title={t('shipTrackOnCarrier', { carrier: s.carrier ?? '' })}>
                ↗
              </a>
            )}
          </div>
        )}
      </td>
      <td className="num" onClick={stop} style={{ cursor: 'default' }}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {showDeliveredCta && (
            <button className="btn accent sm" onClick={() => navigate(`/purchase-orders/${order.id}`)}>
              {t('shipCompletePo')}
            </button>
          )}
          <button className="btn ghost sm" onClick={() => navigate(`/shipping/${order.id}`)}>
            {t('shipViewDetails')}
          </button>
        </div>
      </td>
    </tr>
  );
}
