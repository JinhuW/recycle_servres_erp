import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { TableSkeleton } from '../../components/Skeleton';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDateShort, fmtMoney } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePersisted } from '../../lib/listMemory';
import { navigate, type ShippingRoute } from '../../lib/route';
import {
  createPoFromPackage, listPackages, removePackage,
  type TrackedPackage,
} from '../../lib/packages';
import {
  STATUS_CHIP, filterInbound, fmtEta, inboundCarriers, inboundCounts,
  inboundToCsv, mergeInbound, type ShipOrder, type ShipRow,
} from '../../lib/shippingList';
import { useEffectiveUser } from '../../lib/tweaks';
import type { Order, Shipment, ShipmentStatus } from '../../lib/types';
import { ShippingAddLabel } from './ShippingAddLabel';
import { ShippingLabelWizard } from './ShippingLabelWizard';
import { ShippingPanel } from './ShippingPanel';

// Dedicated shipping-labels area:
//   #/shipping                    — cross-PO shipments table
//   #/shipping/new                — label-first wizard (draft PO created with it)
//   #/shipping/:orderId           — one PO's labels, full panel
//   #/shipping/:orderId/label(/:sid) — wizard for a new / pending label on a PO
//
// The table reads GET /api/shipments + GET /api/packages; the draft → In
// Transit advance is the tracking poll's job server-side.

type ToastKind = 'success' | 'error';
type Props = {
  route: ShippingRoute;
  showToast: (msg: string, kind?: ToastKind) => void;
};

// Status → dot colour for the rail; chip tones stay in STATUS_CHIP.
const TONE_VAR: Record<string, string> = {
  pos: 'var(--pos)', neg: 'var(--neg)', warn: 'var(--warn)',
  info: 'var(--info)', accent: 'var(--accent)', muted: 'var(--fg-subtle)',
};

const RAIL_ORDER: ShipmentStatus[] = ['draft', 'quoted', 'purchased', 'in_transit', 'delivered', 'exception', 'voided'];

export function DesktopShipping({ route, showToast }: Props) {
  return (
    <>
      {route.kind === 'dashboard' && <GlobalShipping showToast={showToast} />}
      {route.kind === 'addLabel' && <ShippingAddLabel showToast={showToast} />}
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
    setFailed(false);
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
  const [shipRows, setShipRows] = useState<ShipRow[]>([]);
  const [pkgs, setPkgs] = useState<TrackedPackage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const [scope, setScope] = usePersisted<'all' | 'mine'>('desktop.shipping.scope', 'all');
  const [status, setStatus] = usePersisted<ShipmentStatus | 'all'>('desktop.shipping.status', 'all');
  const [carrier, setCarrier] = usePersisted<string>('desktop.shipping.carrier', 'all');
  const [search, setSearch] = usePersisted<string>('desktop.shipping.search', '');

  // Monotonic load generation so a scope flip mid-flight can't let the older
  // response land last.
  const loadGen = useRef(0);
  const reload = useCallback(async (silent = false) => {
    const gen = ++loadGen.current;
    try {
      const mineOnly = isManager && scope === 'mine';
      const mine = mineOnly ? '&mine=true' : '';
      // Follow the keyset pages: this table is the ledger and feeds the CSV
      // export, so it must see every row, not silently just the newest 200.
      // The page cap only bounds a runaway cursor.
      const fetchShipments = async () => {
        const items: (Shipment & { order: ShipOrder })[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const qs = `limit=200${mine}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const r: { items: (Shipment & { order: ShipOrder })[]; nextCursor: string | null } =
            await api.get(`/api/shipments?${qs}`);
          items.push(...r.items);
          cursor = r.nextCursor;
          if (!cursor) break;
        }
        return items;
      };
      const [shipItems, packages] = await Promise.all([
        fetchShipments(),
        listPackages({ mine: mineOnly }),
      ]);
      if (gen !== loadGen.current) return;
      setShipRows(shipItems.map(({ order, ...shipment }) => ({ order, shipment })));
      setPkgs(packages.items);
    } catch (e) {
      if (gen === loadGen.current && !silent) handleFetchError(e);
    } finally {
      if (gen === loadGen.current) setLoaded(true);
    }
  }, [isManager, scope]);
  useEffect(() => { void reload(); }, [reload]);

  // Tracking moves server-side on a slow pass; re-read on a visible-tab tick
  // so status moves show up without a manual refresh — a backgrounded tab
  // polls nothing and catches up the moment it's back.
  useEffect(() => {
    const h = setInterval(() => { if (!document.hidden) void reload(true); }, 30_000);
    const onVisible = () => { if (!document.hidden) void reload(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(h);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  const rows = useMemo(() => mergeInbound(shipRows, pkgs), [shipRows, pkgs]);
  const carriers = useMemo(() => inboundCarriers(rows), [rows]);
  // Rail counts reflect the carrier + search narrowing, not the status pick —
  // same layering as the orders page (counts answer "of what I'm looking at").
  const searchScoped = useMemo(
    () => filterInbound(rows, { status: 'all', carrier, search }),
    [rows, carrier, search],
  );
  const counts = useMemo(() => inboundCounts(searchScoped), [searchScoped]);
  const visible = useMemo(
    () => filterInbound(rows, { status, carrier, search }),
    [rows, status, carrier, search],
  );

  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimer.current != null) clearTimeout(copyTimer.current); }, []);
  const copyTracking = (tn: string) => {
    navigator.clipboard?.writeText(tn)
      .then(() => {
        setCopied(tn);
        if (copyTimer.current != null) clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
      })
      .catch(() => { /* the visible number is selectable */ });
  };

  const exportCsv = () => {
    // BOM so Excel decodes CJK seller names; the charset in the MIME type is
    // ignored for downloaded .csv files.
    const blob = new Blob(['\ufeff' + inboundToCsv(visible)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shipments.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Synchronous revoke can cancel the download in Firefox/Safari.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('shipPageTitle')}</h1>
          <div className="page-sub">{t('shipPageSub')}</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => navigate('/shipping/add')}>
            <Icon name="label" size={14} /> {t('shipAddLabel')}
          </button>
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
                {visible.map(row => row.kind === 'package' ? (
                  <PackageTableRow
                    key={row.pkg.id}
                    pkg={row.pkg}
                    locale={locale}
                    isManager={isManager}
                    copied={copied}
                    onCopy={copyTracking}
                    onMutated={reload}
                    showToast={showToast}
                  />
                ) : (
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

      </div>
    </>
  );
}

// A standalone tracked package: an external label with no PO behind it yet.
// The PO is born when the box arrives — that's the whole point of the row.
function PackageTableRow({ pkg, locale, isManager, copied, onCopy, onMutated, showToast }: {
  pkg: TrackedPackage;
  locale: string;
  isManager: boolean;
  copied: string | null;
  onCopy: (tn: string) => void;
  onMutated: () => void;
  showToast: (msg: string, kind?: ToastKind) => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const chip = STATUS_CHIP[pkg.status];
  const eta = fmtEta(pkg.trackingEta, locale);
  const trackUrl = pkg.trackingUrl;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  const createPo = async () => {
    setBusy(true);
    try {
      const { orderId } = await createPoFromPackage(pkg);
      showToast(t('shipPoCreated', { id: orderId }));
      navigate(`/purchase-orders/${orderId}`);
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removePackage(pkg.id);
      onMutated();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td>
        {pkg.orderId ? (
          <button className="ship-po-pill" onClick={() => navigate(`/purchase-orders/${pkg.orderId}`)}>
            {pkg.orderId}
          </button>
        ) : (
          <span className="chip muted" style={{ fontSize: 11 }}>{t('shipColNoPo')}</span>
        )}
        <div className="ship-cell-sub">{fmtDateShort(pkg.createdAt, locale)}</div>
      </td>
      <td>
        {pkg.sellerName
          ? <span style={{ fontWeight: 600 }}>{pkg.sellerName}</span>
          : <span className="muted">—</span>}
        {pkg.note && <div className="ship-cell-sub">{pkg.note}</div>}
      </td>
      <td><span className="muted">—</span></td>
      <td>
        <span className="ship-carrier-chip">{pkg.carrier}</span>{' '}
        <span style={{ fontSize: 12.5 }}>{t('shipAddedLabelTag')}</span>
        {eta && pkg.status !== 'delivered' && (
          <div className="ship-cell-sub">{t('shipEstDelivery', { eta })}</div>
        )}
      </td>
      <td className={'ship-track ' + chip.cls}>
        <span className={'chip dot ' + chip.cls} style={{ fontSize: 11 }}>{t(chip.key)}</span>
        <div className="ship-cell-sub" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="ship-copy-btn mono"
            title={t('shipCopyTracking')}
            onClick={(e) => { stop(e); onCopy(pkg.trackingNumber); }}
          >
            {pkg.trackingNumber}
            <span className={'ship-copy-hint' + (copied === pkg.trackingNumber ? ' done' : '')}>
              {copied === pkg.trackingNumber ? t('shipCopied') : t('shipCopy')}
            </span>
          </button>
          {trackUrl && (
            <a
              href={trackUrl}
              target="_blank"
              rel="noreferrer"
              onClick={stop}
              title={t('shipTrackOnCarrier', { carrier: pkg.carrier })}
            >
              ↗
            </a>
          )}
        </div>
      </td>
      <td className="num" style={{ cursor: 'default' }}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {/* Tracking isn't live yet, so status can stall before "delivered" —
              managers may mint the PO early; the server enforces the same rule. */}
          {!pkg.orderId && (pkg.status === 'delivered' || isManager) && (
            <button className="btn accent sm" disabled={busy} onClick={() => void createPo()}>
              {t('shipCreatePo')}
            </button>
          )}
          {!pkg.orderId && (
            <button className="btn ghost sm" disabled={busy} onClick={() => void remove()}>
              {t('shipPkgRemove')}
            </button>
          )}
        </div>
      </td>
    </tr>
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
