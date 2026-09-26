import { useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentDropzone } from '../components/AttachmentDropzone';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { PhoneListSkeleton } from '../components/Skeleton';
import { SnScanner } from '../components/SnScanner';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CARRIERS, extractTrackingFromBarcode } from '../lib/carrierDetect';
import { FMT_HINT_KEY, useAddPackageForm } from '../lib/useAddPackageForm';
import { handleFetchError } from '../lib/errorToast';
import { fmtDateShort } from '../lib/format';
import { useT } from '../lib/i18n';
import {
  createPoFromPackage, listPackages, lookupPackage, refreshPackage,
  type LookedUpPackage, type TrackedPackage,
} from '../lib/packages';
import { PACKAGE_SOURCES, packageSourceLabelKey } from '../lib/packageSource';
import { navigate, navigateBack, type ShippingRoute } from '../lib/route';
import { RouteLink } from '../components/RouteLink';
import { STATUS_CHIP, fmtEta, mergeInbound, type InboundRow } from '../lib/shippingList';
import { canCreatePo, groupInbound, inboundAction, journeyPos, type InboundAction } from '../lib/shippingInbound';
import { usePhScrolled } from '../lib/usePhScrolled';
import { PhSheet } from '../components/PhSheet';

// Mobile shipping: the desktop table is a ledger; the phone is a glance.
// One screen groups the same rows by what the user should do about them
// (act / wait / done), and the add screen pastes a tracking number.

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
      // Personal surface: always my own rows, managers included.
      listPackages({ mine: true })
        .then((packages) => {
          if (!alive) return;
          loadedOnce = true;
          setRows(mergeInbound(packages.items));
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
      </div>
    </>
  );
}

function rowKey(r: InboundRow): string {
  return `p:${r.pkg.id}`;
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
    <PhSheet onBackdrop={onClose}>
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
          <RouteLink to={`/purchase-orders/${pkg.orderId}`} onNavigate={onClose} className="ph-btn" style={{ width: '100%' }}>
            {pkg.orderId} →
          </RouteLink>
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
    </PhSheet>
  );
}

function ScanNotFoundSheet({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useT();
  // One extraction feeds both the preview and the stored prefill — computed
  // twice they could drift.
  const extracted = extractTrackingFromBarcode(code);
  return (
    <PhSheet onBackdrop={onClose}>
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
    </PhSheet>
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

  const { pkg } = row;
  const status = pkg.status;
  const chip = STATUS_CHIP[status];
  const eta = fmtEta(pkg.trackingEta, locale);
  const tracking = pkg.trackingNumber;
  const carrier = pkg.carrier;
  const trackUrl = pkg.trackingUrl;
  const poId = pkg.orderId;
  const who = pkg.sellerName || null;
  const when = fmtDateShort(pkg.createdAt, locale);

  // The headline answers the glance: an arrival day while it moves, the
  // situation once it needs a decision.
  const headline =
    status === 'in_transit' || status === 'purchased'
      ? (eta ? t('shipMobArrives', { eta }) : t(chip.key))
      : t(chip.key);

  const tone = status === 'exception' ? 'warn' : status === 'delivered' ? 'done' : 'ok';

  const createPo = async () => {
    if (busy) return;
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

  const copyTracking = (tn: string) => {
    navigator.clipboard?.writeText(tn)
      .then(() => showToast(t('shipCopied')))
      .catch(() => { /* the visible number is selectable */ });
  };

  const refresh = async () => {
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
  };

  return (
    <div className="ph-ship-card">
      <div className="ph-ship-head">
        <span className={'ph-ship-headline' + (tone === 'warn' ? ' warn' : '')}>{headline}</span>
        {/* The chip restates the status; skip it when the headline already is it. */}
        {headline !== t(chip.key) && <span className={'chip dot ' + chip.cls}>{t(chip.key)}</span>}
      </div>
      <JourneyStrip pos={journeyPos(row)} tone={tone} />
      <div className="ph-ship-sub">
        {who && <span className="ph-ship-who">{who}</span>}
        {pkg.source && (
          <span className="chip muted">{t(packageSourceLabelKey(pkg.source))}</span>
        )}
        {poId
          ? <RouteLink to={`/purchase-orders/${poId}`} className="ship-po-pill">{poId}</RouteLink>
          : <span className="chip muted">{t('shipColNoPo')}</span>}
        <span className="ph-ship-when">{when}</span>
      </div>
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
          {status !== 'delivered' && (
            <button className="btn ghost sm" disabled={busy} onClick={() => void refresh()}>
              {t('shipRefresh')}
            </button>
          )}
        </div>
      )}
      <CardCta action={action} busy={busy} onCreatePo={createPo} />
    </div>
  );
}

function CardCta({ action, busy, onCreatePo }: {
  action: InboundAction;
  busy: boolean;
  onCreatePo: () => void;
}) {
  const { t } = useT();
  if (!action) return null;
  return (
    <button className="ph-ship-cta accent" disabled={busy} onClick={onCreatePo}>
      {busy ? '…' : t('shipCreatePo')}
    </button>
  );
}

// The desktop timeline compressed to a strip: created → label → moving → here.
function JourneyStrip({ pos, tone }: { pos: number; tone: 'ok' | 'warn' | 'done' }) {
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
