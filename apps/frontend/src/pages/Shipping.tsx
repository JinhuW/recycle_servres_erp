import { useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentDropzone } from '../components/AttachmentDropzone';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { PhoneListSkeleton } from '../components/Skeleton';
import { SnScanner } from '../components/SnScanner';
import { ApiError, api, listShipments } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CARRIERS, extractTrackingFromBarcode } from '../lib/carrierDetect';
import { FMT_HINT_KEY, useAddPackageForm } from '../lib/useAddPackageForm';
import { handleFetchError } from '../lib/errorToast';
import { fmtDateShort, fmtMoney } from '../lib/format';
import { useT } from '../lib/i18n';
import {
  createPoFromPackage, listPackages, lookupPackage, refreshPackage,
  type LookedUpPackage, type TrackedPackage,
} from '../lib/packages';
import { PACKAGE_SOURCES, packageSourceLabelKey } from '../lib/packageSource';
import { navigate, navigateBack, type ShippingRoute } from '../lib/route';
import { shareOrCopy } from '../lib/shareOrCopy';
import { STATUS_CHIP, fmtEta, mergeInbound, type InboundRow, type ShipOrder } from '../lib/shippingList';
import { canCreatePo, groupInbound, inboundAction, journeyPos, type InboundAction } from '../lib/shippingInbound';
import { usePhScrolled } from '../lib/usePhScrolled';
import type { Order, Shipment } from '../lib/types';

// Mobile shipping: the desktop table is a ledger; the phone is a glance.
// One screen groups the same rows by what the user should do about them
// (act / wait / done), the add screen pastes a tracking number, and the
// focus screen shows one PO's labels. Buying labels stays a desktop task —
// cards that reach that step hand off honestly instead of half-porting the
// wizard.

type ToastKind = 'success' | 'error';

// Scan → not-found → Add handoff, same sessionStorage bridge as pwa:sharedFile.
const SCANNED_TN_KEY = 'ship:scannedTracking';
type Props = {
  route: ShippingRoute;
  showToast: (msg: string, kind?: ToastKind) => void;
  /** Delivered package → PO: drop straight into the capture flow to scan lines. */
  onCreatedPo: (orderId: string) => void;
};

export function MobileShipping({ route, showToast, onCreatedPo }: Props) {
  if (route.kind === 'addLabel') return <AddPackageScreen showToast={showToast} />;
  if (route.kind === 'focus') return <PoShippingScreen orderId={route.orderId} showToast={showToast} />;
  if (route.kind === 'wizardNew' || route.kind === 'wizardPo') return <WizardHandoffScreen />;
  return <InboundListScreen showToast={showToast} onCreatedPo={onCreatedPo} />;
}

// ── /shipping — the inbound glance ───────────────────────────────────────────

type ScanState =
  | { phase: 'camera' }
  | { phase: 'found'; pkg: LookedUpPackage }
  | { phase: 'notFound'; code: string };

function InboundListScreen({ showToast, onCreatedPo }: Omit<Props, 'route'>) {
  const { t } = useT();
  const { user } = useAuth();
  const [rows, setRows] = useState<InboundRow[] | null>(null);
  const [showVoided, setShowVoided] = useState(false);
  const [scan, setScan] = useState<ScanState | null>(null);
  const [poBusy, setPoBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);

  // Latest scan wins: on dock Wi-Fi a slow lookup can outlive a rescan, and a
  // stale response swapping the sheet under the user invites a PO on the
  // wrong box.
  const lookupSeq = useRef(0);
  const onScanned = (scanned: string[]) => {
    if (!scanned.length) { setScan(null); return; }
    setScan(null);
    const seq = ++lookupSeq.current;
    lookupPackage(scanned[0])
      .then(({ package: pkg }) => {
        if (seq !== lookupSeq.current) return;
        setScan(pkg ? { phase: 'found', pkg } : { phase: 'notFound', code: scanned[0] });
      })
      .catch(handleFetchError);
  };

  const createPo = async (pkg: TrackedPackage) => {
    if (poBusy) return;
    setPoBusy(true);
    try {
      const { orderId } = await createPoFromPackage(pkg);
      showToast(t('shipPoCreated', { id: orderId }));
      // Settle the sheet before handing off: onCreatedPo's follow-up fetch can
      // fail and strand the screen mounted, and poBusy is screen-level state —
      // left true it would brick Create PO for every later scan.
      setScan(null);
      setPoBusy(false);
      onCreatedPo(orderId);
    } catch (e) {
      handleFetchError(e);
      setPoBusy(false);
    }
  };

  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let loadedOnce = false;
    const load = () =>
      Promise.all([
        // Personal surface: always my own rows, managers included.
        api.get<{ items: (Shipment & { order: ShipOrder })[] }>('/api/shipments?limit=200&mine=true'),
        listPackages({ mine: true }),
      ])
        .then(([shipments, packages]) => {
          if (!alive) return;
          loadedOnce = true;
          setRows(mergeInbound(
            shipments.items.map(({ order, ...shipment }) => ({ order, shipment })),
            packages.items,
          ));
        })
        // A failed refresh tick keeps showing the last good list.
        .catch((e) => { if (alive && !loadedOnce) handleFetchError(e); });
    reload.current = () => { void load(); };
    void load();
    // Tracking moves server-side on a 45-min pass; a slow tick keeps the
    // glance honest while it's actually being glanced at — a backgrounded
    // tab polls nothing and refreshes the moment it's back.
    const h = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(h);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const groups = useMemo(() => groupInbound(rows ?? []), [rows]);
  const empty = rows !== null && rows.length === 0;

  return (
    <>
      <PhHeader
        title={t('nav_shipping')}
        sub={rows ? t('shipMobCount', { n: rows.length }) : undefined}
        scrolled={scrolled}
        trailing={
          <>
            <button className="ph-icon-btn" onClick={() => setScan({ phase: 'camera' })} aria-label={t('shipScanBtn')}>
              <Icon name="scan" size={16} />
            </button>
            <button className="ph-icon-btn" onClick={() => navigate('/shipping/add')} aria-label={t('shipAddLabel')}>
              <Icon name="plus" size={16} />
            </button>
          </>
        }
      />
      {scan?.phase === 'camera' && (
        <SnScanner existing={[]} onDone={onScanned} title={t('shipScanTitle')} hint={t('shipScanHint')} />
      )}
      {scan?.phase === 'found' && (
        <PackageSheet
          pkg={scan.pkg}
          busy={poBusy}
          canCreate={canCreatePo(scan.pkg, user?.role === 'manager')}
          onCreatePo={createPo}
          onClose={() => setScan(null)}
        />
      )}
      {scan?.phase === 'notFound' && (
        <ScanNotFoundSheet code={scan.code} onClose={() => setScan(null)} />
      )}
      <div className="ph-scroll" ref={scrollRef}>
        {rows === null && <PhoneListSkeleton rows={5} />}

        {empty && (
          <div className="ph-ship-empty">
            <Icon name="truck" size={26} />
            <div className="ph-ship-empty-title">{t('shipMobEmptyTitle')}</div>
            <div className="ph-ship-empty-body">{t('shipMobEmptyBody')}</div>
            <button className="ph-btn accent" style={{ flex: 'none', width: '100%', marginTop: 16 }} onClick={() => navigate('/shipping/add')}>
              <Icon name="plus" size={15} /> {t('shipMobAddBtn')}
            </button>
          </div>
        )}

        {groups.needs.length > 0 && (
          <>
            <div className="ph-section-h"><span>{t('shipGroupNeeds')}</span><span className="mono">{groups.needs.length}</span></div>
            {groups.needs.map(r => <InboundCard key={rowKey(r)} row={r} showToast={showToast} onCreatedPo={onCreatedPo} onRefreshed={() => reload.current()} />)}
          </>
        )}
        {groups.moving.length > 0 && (
          <>
            <div className="ph-section-h"><span>{t('shipGroupMoving')}</span><span className="mono">{groups.moving.length}</span></div>
            {groups.moving.map(r => <InboundCard key={rowKey(r)} row={r} showToast={showToast} onCreatedPo={onCreatedPo} onRefreshed={() => reload.current()} />)}
          </>
        )}
        {groups.arrived.length > 0 && (
          <>
            <div className="ph-section-h"><span>{t('shipGroupArrived')}</span><span className="mono">{groups.arrived.length}</span></div>
            {groups.arrived.map(r => <InboundCard key={rowKey(r)} row={r} showToast={showToast} onCreatedPo={onCreatedPo} onRefreshed={() => reload.current()} />)}
          </>
        )}
        {groups.voided.length > 0 && (
          <button className="ph-ship-voided-toggle" onClick={() => setShowVoided(v => !v)}>
            {showVoided ? t('shipMobHideVoided') : t('shipMobShowVoided', { n: groups.voided.length })}
          </button>
        )}
        {showVoided && groups.voided.map(r => <InboundCard key={rowKey(r)} row={r} showToast={showToast} onCreatedPo={onCreatedPo} onRefreshed={() => reload.current()} />)}
      </div>
    </>
  );
}

function rowKey(r: InboundRow): string {
  return r.kind === 'package' ? `p:${r.pkg.id}` : `s:${r.shipment.id}`;
}

// ── Scan result sheets ───────────────────────────────────────────────────────

function PackageSheet({ pkg, busy, canCreate, onCreatePo, onClose }: {
  pkg: LookedUpPackage;
  busy: boolean;
  /** Same delivered-or-manager rule the cards and the backend apply. */
  canCreate: boolean;
  onCreatePo: (pkg: TrackedPackage) => void;
  onClose: () => void;
}) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const chip = STATUS_CHIP[pkg.status];
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onClose} />
      <div className="ph-sheet">
        <div className="ph-sheet-grabber" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px 12px' }}>
          {pkg.carrier && <span className="ship-carrier-chip">{pkg.carrier}</span>}
          <span className={'chip dot ' + chip.cls}>{t(chip.key)}</span>
          <span style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--accent-strong)', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', padding: 4, cursor: 'pointer' }}
          >
            {t('cancel')}
          </button>
        </div>

        <div className="mono" style={{ fontSize: 15, fontWeight: 600, padding: '0 4px', overflowWrap: 'anywhere' }}>
          {pkg.trackingNumber}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', padding: '4px 4px 0' }}>
          {[
            pkg.creatorName ? t('shipScanTrackedBy', { name: pkg.creatorName }) : null,
            fmtDateShort(pkg.createdAt, locale),
            pkg.sellerName,
            pkg.source ? t(packageSourceLabelKey(pkg.source)) : null,
          ].filter(Boolean).join(' · ')}
        </div>

        {/* The purchaser's note is what the receiver came for — box contents,
            dock instructions — so it gets the card, not a footnote. */}
        {pkg.note && (
          <div className="ph-card" style={{ marginTop: 12, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
              {t('shipScanNoteLabel')}
            </div>
            <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{pkg.note}</div>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          {pkg.orderId ? (
            <button
              className="ph-btn"
              style={{ width: '100%' }}
              onClick={() => { onClose(); navigate(`/purchase-orders/${pkg.orderId}`); }}
            >
              {pkg.orderId} →
            </button>
          ) : canCreate ? (
            <button className="ph-btn accent" style={{ width: '100%' }} disabled={busy} onClick={() => onCreatePo(pkg)}>
              {busy ? '…' : t('shipCreatePo')}
            </button>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--fg-muted)', textAlign: 'center', padding: '4px 4px 0' }}>
              {t('shipScanPoAfterDelivery')}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ScanNotFoundSheet({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useT();
  // One extraction feeds both the preview and the stored prefill — computed
  // twice they could drift.
  const extracted = extractTrackingFromBarcode(code);
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onClose} />
      <div className="ph-sheet">
        <div className="ph-sheet-grabber" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 10px' }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('shipScanNotFoundTitle')}</div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--accent-strong)', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', padding: 4, cursor: 'pointer' }}
          >
            {t('cancel')}
          </button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--fg-muted)', padding: '0 4px' }}>{t('shipScanNotFoundBody')}</div>
        <div className="mono" style={{ fontSize: 13, padding: '10px 4px 0', overflowWrap: 'anywhere', color: 'var(--fg-subtle)' }}>
          {extracted}
        </div>
        <div style={{ marginTop: 16 }}>
          <button
            className="ph-btn accent"
            style={{ width: '100%' }}
            onClick={() => {
              try { sessionStorage.setItem(SCANNED_TN_KEY, extracted); } catch { /* storage may be unavailable */ }
              navigate('/shipping/add');
            }}
          >
            <Icon name="plus" size={15} /> {t('shipScanAddBtn')}
          </button>
        </div>
      </div>
    </>
  );
}

// ── One card ─────────────────────────────────────────────────────────────────

function InboundCard({ row, showToast, onCreatedPo, onRefreshed }: {
  row: InboundRow;
  showToast: (msg: string, kind?: ToastKind) => void;
  onCreatedPo: (orderId: string) => void;
  onRefreshed: () => void;
}) {
  const { t, lang } = useT();
  const { user } = useAuth();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [busy, setBusy] = useState(false);
  const action = inboundAction(row, user?.role === 'manager');

  const status = row.kind === 'package' ? row.pkg.status : row.shipment.status;
  const chip = STATUS_CHIP[status];
  const eta = fmtEta(row.kind === 'package' ? row.pkg.trackingEta : row.shipment.trackingEta, locale);
  const tracking = row.kind === 'package' ? row.pkg.trackingNumber : row.shipment.trackingNumber;
  const carrier = row.kind === 'package' ? row.pkg.carrier : row.shipment.carrier;
  const trackUrl = row.kind === 'package'
    ? row.pkg.trackingUrl
    : row.shipment.trackingUrl;
  const poId = row.kind === 'package' ? row.pkg.orderId : row.order.id;
  const who = row.kind === 'package'
    ? (row.pkg.sellerName || null)
    : (row.shipment.from.name || null);
  const when = fmtDateShort(row.kind === 'package' ? row.pkg.createdAt : row.shipment.createdAt, locale);

  // The headline answers the glance: an arrival day while it moves, the
  // situation once it needs a decision.
  const headline =
    status === 'in_transit' || status === 'purchased'
      ? (eta ? t('shipMobArrives', { eta }) : t(chip.key))
      : action?.kind === 'reshare-link' ? t('shipWaitingSeller')
      : action?.kind === 'buy-desktop' ? t('shipMobAddrIn')
      : t(chip.key);

  const tone = status === 'exception' ? 'warn' : status === 'voided' ? 'muted' : status === 'delivered' ? 'done' : 'ok';

  const createPo = async () => {
    if (row.kind !== 'package' || busy) return;
    setBusy(true);
    try {
      const { orderId } = await createPoFromPackage(row.pkg);
      showToast(t('shipPoCreated', { id: orderId }));
      // onCreatedPo's follow-up fetch can fail and leave this card mounted;
      // the button must come back rather than stay stuck on "…".
      setBusy(false);
      onCreatedPo(orderId);
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };

  const shareLink = (tok: string) => shareOrCopy({
    url: `${window.location.origin}/s/${tok}`,
    title: t('sellerFillTitle'),
    copiedMsg: t('shipLinkCopied'),
    failedMsg: t('shipMobShareFailed'),
    onToast: showToast,
  });

  const copyTracking = (tn: string) => {
    navigator.clipboard?.writeText(tn)
      .then(() => showToast(t('shipCopied')))
      .catch(() => { /* the visible number is selectable */ });
  };

  // Only packages can be asked directly: a shipment's label is the provider's
  // own and moves on the poll.
  const refresh = row.kind === 'package' ? async () => {
    setBusy(true);
    try {
      await refreshPackage(row.pkg.id);
      onRefreshed();
    } catch (e) {
      // 501 means tracking has no provider configured — a state of the
      // deployment, not a failure of this tap, so it must not raise the
      // blocking "Something went wrong" dialog.
      if (e instanceof ApiError && e.status === 501) showToast(t('shipTrackingOff'), 'error');
      else handleFetchError(e);
    } finally {
      setBusy(false);
    }
  } : undefined;

  const openFocus = row.kind === 'shipment' ? () => navigate(`/shipping/${row.order.id}`) : undefined;

  return (
    <div className={'ph-ship-card' + (openFocus ? ' tappable' : '')} onClick={openFocus}>
      <div className="ph-ship-head">
        <span className={'ph-ship-headline' + (tone === 'warn' ? ' warn' : '')}>{headline}</span>
        {/* The chip restates the status; skip it when the headline already is it. */}
        {headline !== t(chip.key) && <span className={'chip dot ' + chip.cls}>{t(chip.key)}</span>}
      </div>
      <JourneyStrip pos={journeyPos(row)} tone={tone} />
      <div className="ph-ship-sub">
        {who && <span className="ph-ship-who">{who}</span>}
        {row.kind === 'package' && row.pkg.source && (
          <span className="chip muted">{t(packageSourceLabelKey(row.pkg.source))}</span>
        )}
        {poId
          ? <button className="ship-po-pill" onClick={(e) => { e.stopPropagation(); navigate(`/purchase-orders/${poId}`); }}>{poId}</button>
          : <span className="chip muted">{t('shipColNoPo')}</span>}
        <span className="ph-ship-when">{when}</span>
      </div>
      {row.kind === 'shipment' && row.shipment.status === 'exception' && row.shipment.trackingStatus && (
        <div className="ph-ship-exc">{t('shipExceptionNote', { status: row.shipment.trackingStatus })}</div>
      )}
      {tracking && (
        <div className="ph-ship-track" onClick={(e) => e.stopPropagation()}>
          {carrier && <span className="ship-carrier-chip">{carrier}</span>}
          <button className="ph-ship-tn mono" onClick={() => copyTracking(tracking)} title={t('shipCopyTracking')}>
            {tracking}
            <span className="ph-ship-copy">{t('shipCopy')}</span>
          </button>
          {trackUrl && (
            <a href={trackUrl} target="_blank" rel="noreferrer" className="ph-ship-out" aria-label={t('shipTrackOnCarrier', { carrier: carrier ?? '' })}>↗</a>
          )}
          {refresh && row.kind === 'package' && row.pkg.status !== 'delivered' && (
            <button className="btn ghost sm" disabled={busy} onClick={() => void refresh()}>
              {t('shipRefresh')}
            </button>
          )}
        </div>
      )}
      <CardCta action={action} busy={busy} onCreatePo={createPo} onShare={shareLink} />
    </div>
  );
}

function CardCta({ action, busy, onCreatePo, onShare }: {
  action: InboundAction;
  busy: boolean;
  onCreatePo: () => void;
  onShare: (token: string) => void;
}) {
  const { t } = useT();
  if (!action) return null;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  switch (action.kind) {
    case 'create-po':
      return (
        <button className="ph-ship-cta accent" disabled={busy} onClick={(e) => { stop(e); onCreatePo(); }}>
          {busy ? '…' : t('shipCreatePo')}
        </button>
      );
    case 'complete-po':
      return (
        <button className="ph-ship-cta accent" onClick={(e) => { stop(e); navigate(`/purchase-orders/${action.orderId}`); }}>
          {t('shipCompletePo')}
        </button>
      );
    case 'reshare-link':
      return (
        <button className="ph-ship-cta" onClick={(e) => { stop(e); onShare(action.token); }}>
          <Icon name="mail" size={14} /> {t('shipMobShareLink')}
        </button>
      );
    case 'buy-desktop':
      return <div className="ph-ship-hint">{t('shipMobBuyDesktop')}</div>;
    case 'finish-desktop':
      return <div className="ph-ship-hint">{t('shipMobFinishDesktop')}</div>;
  }
}

// The desktop timeline compressed to a strip: created → label → moving → here.
function JourneyStrip({ pos, tone }: { pos: number; tone: 'ok' | 'warn' | 'muted' | 'done' }) {
  return (
    <div className={'ph-ship-strip ' + tone} aria-hidden="true">
      {[0, 1, 2, 3].map(i => (
        <span key={i} className={'seg' + (i < pos ? ' fill' : i === pos ? ' fill live' : '')} />
      ))}
    </div>
  );
}

// ── /shipping/add — paste a tracking number ──────────────────────────────────

function AddPackageScreen({ showToast }: { showToast: (msg: string, kind?: ToastKind) => void }) {
  const { t } = useT();
  // Shared with the desktop page — see lib/useAddPackageForm.
  const f = useAddPackageForm(({ carrier, tn }) => {
    showToast(t('shipAddAdded', { carrier, tn }));
    navigate('/shipping');
  });

  // Consume the scan → not-found handoff exactly once.
  useEffect(() => {
    try {
      const scanned = sessionStorage.getItem(SCANNED_TN_KEY);
      if (scanned) {
        sessionStorage.removeItem(SCANNED_TN_KEY);
        f.setRaw(scanned);
      }
    } catch { /* storage may be unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PhHeader
        title={t('shipAddTitle')}
        leading={
          <button className="ph-icon-btn" onClick={() => navigate('/shipping')} aria-label={t('back')}>
            <Icon name="chevronLeft" size={17} />
          </button>
        }
      />
      <div className="ph-scroll">
        <div className="ph-ship-add-sub">{t('shipAddSub')}</div>

        <div className="ph-field">
          <label>{t('shipAddTrackingLabel')}</label>
          <input
            className="input mono"
            value={f.raw}
            onChange={(e) => f.setRaw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void f.submit(); }}
            placeholder={t('shipAddTrackingPh')}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="ph-ship-carriers" role="radiogroup" aria-label={t('shipAddCarrierTitle')}>
          {CARRIERS.map((c) => {
            const lit = f.detected.includes(c);
            const selected = f.carrier === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={selected}
                className={'ph-ship-carrier' + (lit ? ' lit' : '') + (selected ? ' selected' : '')}
                onClick={() => f.setPick(c)}
              >
                <span className="ph-ship-carrier-name">{c}</span>
                <span className="ph-ship-carrier-fmt mono">{t(FMT_HINT_KEY[c])}</span>
              </button>
            );
          })}
        </div>
        <div className="ph-ship-add-hint" aria-live="polite">
          {f.hintKey ? t(f.hintKey) : ' '}
        </div>

        <div className="ph-field">
          <label>{t('shipSellerName')}</label>
          <input className="input" value={f.sellerName} onChange={(e) => f.setSellerName(e.target.value)} autoComplete="off" />
        </div>

        <div className="ph-field">
          <label>{t('shipSource')}</label>
          <div className="ph-ship-carriers" role="radiogroup" aria-label={t('shipSource')}>
            {PACKAGE_SOURCES.map((src) => (
              <button
                key={src}
                type="button"
                role="radio"
                aria-checked={f.source === src}
                className={'ph-ship-carrier' + (f.source === src ? ' selected' : '')}
                onClick={() => f.setSource(src)}
              >
                <span className="ph-ship-carrier-name">{t(packageSourceLabelKey(src))}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ph-field">
          <label>{t('shipPayTitle')}</label>
          <div className="ph-ship-add-hint">{t('shipPaySub')}</div>
          {f.screenshot ? (
            <div className="ship-pay-shot">
              <img src={f.screenshot.preview} alt={t('shipPayTitle')} />
              <button className="btn ghost sm" onClick={f.removeScreenshot}>
                {t('shipPayRemoveShot')}
              </button>
            </div>
          ) : (
            <AttachmentDropzone
              onFiles={(files) => void f.handlePaymentFile(files)}
              uploading={f.scanBusy}
              accept="image/*"
              multiple={false}
              compact
              boxHint={t('shipPayBoxHint')}
            />
          )}
          {f.scanNoticeKey && (
            <div className="ph-ship-add-hint" role="status">{t(f.scanNoticeKey)}</div>
          )}
          {f.scanError && (
            <div className="ph-ship-add-hint" role="alert">
              {'text' in f.scanError ? f.scanError.text : t(f.scanError.key)}
            </div>
          )}
        </div>

        <div className="ph-field">
          <label>{t('shipPayTxnLabel')} <span className="req">*</span></label>
          <input
            className="input mono"
            value={f.paypalTxnId}
            onChange={(e) => f.setPaypalTxnId(e.target.value)}
            placeholder={t('shipPayTxnPh')}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="ph-ship-add-hint" aria-live="polite">
            {f.txnLooksOdd ? t('shipPayTxnFormatHint') : ' '}
          </div>
        </div>
      </div>
      <div className="ph-action-bar">
        <button className="ph-btn accent" disabled={!f.canSubmit} onClick={() => void f.submit()}>
          {f.busy ? '…' : t('shipAddSubmit')}
        </button>
      </div>
    </>
  );
}

// ── /shipping/:orderId — one PO's labels ─────────────────────────────────────

function PoShippingScreen({ orderId, showToast }: { orderId: string; showToast: (msg: string, kind?: ToastKind) => void }) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [order, setOrder] = useState<Order | null>(null);
  const [items, setItems] = useState<Shipment[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.get<{ order: Order }>(`/api/orders/${orderId}`), listShipments(orderId)])
      .then(([o, list]) => { if (alive) { setOrder(o.order); setItems(list.items); } })
      .catch((e) => { if (alive) { setFailed(true); handleFetchError(e); } });
    return () => { alive = false; };
  }, [orderId]);

  const shareLink = (tok: string) => shareOrCopy({
    url: `${window.location.origin}/s/${tok}`,
    title: t('sellerFillTitle'),
    copiedMsg: t('shipLinkCopied'),
    failedMsg: t('shipMobShareFailed'),
    onToast: showToast,
  });

  const copyTracking = (tn: string) => {
    navigator.clipboard?.writeText(tn)
      .then(() => showToast(t('shipCopied')))
      .catch(() => { /* selectable */ });
  };

  return (
    <>
      <PhHeader
        title={orderId}
        sub={t('shipPanelTitle')}
        leading={
          <button className="ph-icon-btn" onClick={() => navigateBack('/shipping')} aria-label={t('back')}>
            <Icon name="chevronLeft" size={17} />
          </button>
        }
        trailing={
          <button className="ph-icon-btn" onClick={() => navigate(`/purchase-orders/${orderId}`)} aria-label={t('shipMobViewPo')}>
            <Icon name="box" size={15} />
          </button>
        }
      />
      <div className="ph-scroll">
        {failed && <div className="ph-ship-empty"><div className="ph-ship-empty-title">{t('shipPageOrderMissing')}</div></div>}
        {!failed && items === null && <PhoneListSkeleton rows={3} />}
        {items?.length === 0 && (
          <div className="ph-ship-empty">
            <Icon name="label" size={24} />
            <div className="ph-ship-empty-body">{t('shipEmptyHint')}</div>
          </div>
        )}
        {order && items?.map((s) => {
          const row: InboundRow = {
            kind: 'shipment',
            order: { id: order.id, userName: '', lifecycle: order.lifecycle, paypalTxnId: order.paypalTxnId, warehouse: order.warehouse ?? null },
            shipment: s,
          };
          const chip = STATUS_CHIP[s.status];
          const eta = fmtEta(s.trackingEta, locale);
          const tone = s.status === 'exception' ? 'warn' : s.status === 'voided' ? 'muted' : s.status === 'delivered' ? 'done' : 'ok';
          const waiting = (s.status === 'draft' || s.status === 'quoted') && !s.complete && !!s.sellerToken;
          const headline = s.from.name ? t('shipBoxFrom', { name: s.from.name })
            : waiting ? t('shipWaitingSeller')
            : t(chip.key);
          return (
            <div key={s.id} className="ph-ship-card">
              <div className="ph-ship-head">
                <span className="ph-ship-headline">{headline}</span>
                {headline !== t(chip.key) && <span className={'chip dot ' + chip.cls}>{t(chip.key)}</span>}
              </div>
              <JourneyStrip pos={journeyPos(row)} tone={tone} />
              <div className="ph-ship-sub">
                {(s.from.city || s.from.state) && (
                  <span className="ph-ship-who">{[s.from.city, s.from.state].filter(Boolean).join(', ')}</span>
                )}
                {order.warehouse && <span className="ph-ship-who">→ {order.warehouse.short}</span>}
                <span className="ph-ship-when">{fmtDateShort(s.createdAt, locale)}</span>
              </div>
              {s.status === 'exception' && s.trackingStatus && (
                <div className="ph-ship-exc">{t('shipExceptionNote', { status: s.trackingStatus })}</div>
              )}
              {(s.carrier || s.labelCost != null || eta) && (
                <div className="ph-ship-meta">
                  {s.carrier && <span className="ship-carrier-chip">{s.carrier}</span>}
                  {s.service && <span>{s.service}</span>}
                  {s.labelCost != null && <span className="mono">{fmtMoney(s.labelCost, s.rateCurrency)}</span>}
                  {eta && s.status !== 'delivered' && s.status !== 'voided' && <span>{t('shipEstDelivery', { eta })}</span>}
                  {s.provider === 'stub' && s.status !== 'draft' && s.status !== 'quoted' && (
                    <span className="chip muted" style={{ fontSize: 10 }}>{t('shipDemoTag')}</span>
                  )}
                </div>
              )}
              {s.trackingNumber && (
                <div className="ph-ship-track">
                  <button className="ph-ship-tn mono" onClick={() => copyTracking(s.trackingNumber!)} title={t('shipCopyTracking')}>
                    {s.trackingNumber}
                    <span className="ph-ship-copy">{t('shipCopy')}</span>
                  </button>
                  {s.trackingUrl && (
                    <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="ph-ship-out" aria-label={t('shipTrackOnCarrier', { carrier: s.carrier ?? '' })}>↗</a>
                  )}
                </div>
              )}
              {s.labelUrl && (
                <a className="ph-ship-cta" href={s.labelUrl} target="_blank" rel="noreferrer">
                  <Icon name="download" size={14} /> {t('shipDownloadLabel')}
                </a>
              )}
              {s.sellerToken && !s.complete && (s.status === 'draft' || s.status === 'quoted') && (
                <button className="ph-ship-cta" onClick={() => shareLink(s.sellerToken!)}>
                  <Icon name="mail" size={14} /> {t('shipMobShareLink')}
                </button>
              )}
              {s.status === 'delivered' && order.lifecycle !== 'done' && (
                <button className="ph-ship-cta accent" onClick={() => navigate(`/purchase-orders/${order.id}`)}>
                  {t('shipCompletePo')}
                </button>
              )}
              {s.complete && (s.status === 'draft' || s.status === 'quoted') && (
                <div className="ph-ship-hint">{t('shipMobBuyDesktop')}</div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── /shipping/new & /shipping/:po/label — desktop wizard deep links ──────────

function WizardHandoffScreen() {
  const { t } = useT();
  return (
    <>
      <PhHeader
        title={t('shipWizTitle')}
        leading={
          <button className="ph-icon-btn" onClick={() => navigate('/shipping')} aria-label={t('back')}>
            <Icon name="chevronLeft" size={17} />
          </button>
        }
      />
      <div className="ph-scroll">
        <div className="ph-ship-empty">
          <Icon name="label" size={26} />
          <div className="ph-ship-empty-title">{t('shipMobWizDesktopTitle')}</div>
          <div className="ph-ship-empty-body">{t('shipMobWizDesktopBody')}</div>
        </div>
      </div>
    </>
  );
}
