import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { TableSkeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDateShort } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePersisted } from '../../lib/listMemory';
import { navigate, type ShippingRoute } from '../../lib/route';
import { RouteLink } from '../../components/RouteLink';
import {
  createPoFromPackage, listPackages, refreshPackage, removePackage,
  type PackageStatus, type TrackedPackage,
} from '../../lib/packages';
import { packageSourceLabelKey } from '../../lib/packageSource';
import {
  STATUS_CHIP, filterInbound, fmtEta, inboundCarriers, inboundCounts,
  inboundToCsv, mergeInbound,
} from '../../lib/shippingList';
import { canCreatePo } from '../../lib/shippingInbound';
import { useEffectiveUser } from '../../lib/tweaks';
import { ShippingAddLabel } from './ShippingAddLabel';

// Inbound packages area:
//   #/shipping        — cross-PO table of tracked packages
//   #/shipping/add    — paste an externally bought tracking number
//
// The table reads GET /api/packages; tracking moves server-side.

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

const RAIL_ORDER: PackageStatus[] = ['purchased', 'in_transit', 'delivered', 'exception'];

export function DesktopShipping({ route, showToast }: Props) {
  return (
    <>
      {route.kind === 'dashboard' && <GlobalShipping showToast={showToast} />}
      {route.kind === 'addLabel' && <ShippingAddLabel showToast={showToast} />}
    </>
  );
}

// ── /shipping — the packages table ───────────────────────────────────────────

function GlobalShipping({ showToast }: { showToast: (msg: string, kind?: ToastKind) => void }) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const user = useEffectiveUser();
  const isManager = user?.role === 'manager';
  const [pkgs, setPkgs] = useState<TrackedPackage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const [scope, setScope] = usePersisted<'all' | 'mine'>('desktop.shipping.scope', 'all');
  const [status, setStatus] = usePersisted<PackageStatus | 'all'>('desktop.shipping.status', 'all');
  const [carrier, setCarrier] = usePersisted<string>('desktop.shipping.carrier', 'all');
  const [search, setSearch] = usePersisted<string>('desktop.shipping.search', '');

  // Monotonic load generation so a scope flip mid-flight can't let the older
  // response land last.
  const loadGen = useRef(0);
  const reload = useCallback(async (silent = false) => {
    const gen = ++loadGen.current;
    try {
      const mineOnly = isManager && scope === 'mine';
      const packages = await listPackages({ mine: mineOnly });
      if (gen !== loadGen.current) return;
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

  const rows = useMemo(() => mergeInbound(pkgs), [pkgs]);
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
    a.download = 'packages.csv';
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
          <button className="btn accent" onClick={() => navigate('/shipping/add')}>
            <Icon name="label" size={14} /> {t('shipAddLabel')}
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
              aria-label={t('shipColCarrier')}
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
            <TableSkeleton rows={8} cols={5} />
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
                  <th>{t('shipColCarrier')}</th>
                  <th>{t('shipColTracking')}</th>
                  <th style={{ width: 190 }} />
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: 'var(--fg-subtle)' }}>
                    {t('shipNoMatch')}
                  </td></tr>
                )}
                {visible.map(row => (
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
  const stopClick = (e: { stopPropagation: () => void }) => e.stopPropagation();

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

  const refresh = async () => {
    setBusy(true);
    try {
      await refreshPackage(pkg.id);
      onMutated();
    } catch (e) {
      // 501 means tracking has no provider configured. That is a state of the
      // deployment, not a failure of this click, so it does not deserve the
      // blocking "Something went wrong" dialog a warehouse user was getting.
      if (e instanceof ApiError && e.status === 501) showToast(t('shipTrackingOff'), 'error');
      else handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td>
        {pkg.orderId ? (
          <RouteLink to={`/purchase-orders/${pkg.orderId}`} className="ship-po-pill">
            {pkg.orderId}
          </RouteLink>
        ) : (
          <span className="chip muted" style={{ fontSize: 11 }}>{t('shipColNoPo')}</span>
        )}
        <div className="ship-cell-sub">
          {fmtDateShort(pkg.createdAt, locale)}
          {isManager && pkg.creatorName ? ` · ${pkg.creatorName}` : ''}
        </div>
      </td>
      <td>
        {pkg.sellerName
          ? <span style={{ fontWeight: 600 }}>{pkg.sellerName}</span>
          : <span className="muted">—</span>}
        {pkg.note && <div className="ship-cell-sub">{pkg.note}</div>}
        {pkg.source && (
          <div className="ship-cell-sub" title={t('shipSource')}>{t(packageSourceLabelKey(pkg.source))}</div>
        )}
        {pkg.paypalTxnId && (
          <div className="ship-cell-sub mono" title={t('shipPayTxnLabel')}>PayPal {pkg.paypalTxnId}</div>
        )}
      </td>
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
            onClick={(e) => { stopClick(e); onCopy(pkg.trackingNumber); }}
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
              onClick={stopClick}
              title={t('shipTrackOnCarrier', { carrier: pkg.carrier })}
            >
              ↗
            </a>
          )}
        </div>
      </td>
      <td className="num" style={{ cursor: 'default' }}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {canCreatePo(pkg, isManager) && (
            <button className="btn accent sm" disabled={busy} onClick={() => void createPo()}>
              {t('shipCreatePo')}
            </button>
          )}
          {pkg.status !== 'delivered' && (
            <button
              className="btn ghost sm"
              disabled={busy}
              title={t('shipRefreshHint')}
              onClick={() => void refresh()}
            >
              {t('shipRefresh')}
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
