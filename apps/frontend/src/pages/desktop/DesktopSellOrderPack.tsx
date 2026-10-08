import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { LineSpecChips, lineHasSpecChips } from '../../components/LineSpecChips';
import { StatusChangeDialog, type StatusAttachment } from '../../components/StatusChangeDialog';
import { api, ApiError, rawFetch } from '../../lib/api';
import {
  countOf, emptyCheck, filterScan, isAbsentChecked, isShortChecked, lineState, partsNamed, tally, type LineCheck,
} from '../../lib/boxCheck';
import { handleFetchError, showErrorDialog, showWarnToast } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import { sellOrderStatuses } from '../../lib/lookups';
import { navigate, navigateBack } from '../../lib/route';
import {
  isPackable, packBody, packScan, packView, packWarehouseOf, packWarehouseOptions, shipBlockers, sourceTag,
  toCheck, UNASSIGNED, type PackLine, type PackResponse,
} from '../../lib/sellOrderPack';
import type { Category } from '../../lib/types';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { useLineSaveQueue } from '../../lib/useLineSaveQueue';
import { useScanFilterText } from '../../lib/useScanFilter';

// Pack mode: a sell order as a packing checklist, built for an iPad on a cart.
// Lines run in the order's own list order, each led by its # on the order —
// the number the packer writes on the item's label and the receiver checks
// the box by — and each names the lot it comes from (From PO-1111 #1). A
// ticked line stays in its place, so the list always reads #1 to #n. Counts
// start full and are lowered only when the shelf is short, as in the PO's
// Review mode; a line held at 0 keeps its # but has nothing to pack. Each line
// shows its lot's photo, so the packer matches the item by eye
// (user-requested 2026-10-07).

type OrderLine = {
  id: string;
  category: Category;
  label: string;
  sub: string | null;
  partNumber: string | null;
  qty: number;
  condition: string | null;
  warehouseId: string | null;
  warehouse: string | null;
  packWarehouse?: string | null;
  sourceOrderId?: string | null;
  sourceLineNo?: number | null;
  type?: string | null;
  classification?: string | null;
  rank?: string | null;
  speed?: string | null;
  interface?: string | null;
  formFactor?: string | null;
  health?: number | null;
  // The lot's label scan; optional because the Worker can ship before the API.
  imageUrl?: string | null;
};

type PackOrder = {
  id: string;
  status: string;
  archivedAt: string | null;
  customer: { name: string };
  lines: OrderLine[];
  statusMeta: Partial<Record<string, { note: string | null; attachments: StatusAttachment[] }>>;
};

type Line = OrderLine & PackLine;
type Undo = { prev: LineCheck; msg: string };
type ScanMsg = { tone: 'muted' | 'pos' | 'warn' | 'neg'; text: string };

type Props = {
  id: string;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

const toneFor = (s: string) => sellOrderStatuses.find(o => o.id === s)?.tone ?? 'muted';
const pnOf = (l: Line) => l.partNumber ?? l.label;

export default function DesktopSellOrderPack({ id, onToast }: Props) {
  const { t } = useT();
  const [order, setOrder] = useState<PackOrder | null>(null);
  // Only the first read can leave the page with no order; a failed re-read
  // keeps the one already shown.
  const [orderFailed, setOrderFailed] = useState(false);
  const [serials, setSerials] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [wh, setWh] = useState('');
  const [undo, setUndo] = useState<Undo | null>(null);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<ScanMsg | null>(null);
  // Lines a part-number scan could have meant, waiting for a tap.
  const [choose, setChoose] = useState<ReadonlySet<string>>(new Set());
  const [shipping, setShipping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);

  const scanRef = useRef<HTMLInputElement | null>(null);
  // Set when a scanner's first character landed on the page and was moved into
  // the scan box; the box gives focus back once the scan is in.
  const scanFromPage = useRef(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadOrder = useCallback(async () => {
    try {
      setOrder((await api.get<{ order: PackOrder }>(`/api/sell-orders/${id}`)).order);
      setOrderFailed(false);
    } catch (e) {
      handleFetchError(e);
      setOrderFailed(true);
    }
  }, [id]);
  useEffect(() => { void loadOrder(); }, [loadOrder]);

  const qtyById = useRef(new Map<string, number>());
  qtyById.current = useMemo(() => new Map((order?.lines ?? []).map(l => [l.id, l.qty])), [order]);
  const url = (lineId: string) => `/api/sell-orders/${id}/pack/${lineId}`;
  const bodyOf = (c: LineCheck) => packBody(c, qtyById.current.get(c.lineId) ?? c.counted);

  const { checks, loadState, reload, save, flush } = useLineSaveQueue<PackResponse>({
    read: () => api.get<PackResponse>(`/api/sell-orders/${id}/pack`),
    send: c => api.put<PackResponse>(url(c.lineId), bodyOf(c)),
    beacon: c => { void rawFetch('PUT', url(c.lineId), bodyOf(c), undefined, { keepalive: true }).catch(() => {}); },
    checksOf: r => r.lines.map(toCheck),
    onServer: r => setSerials(new Map(r.lines.map(x => [x.lineId, x.serialNumber]))),
    onWriteError: e => {
      // Saving the order's lines replaces their rows, so a line this page
      // still holds may be gone; the fresh order carries its successor.
      if (e instanceof ApiError && e.status === 404) {
        showWarnToast(t('pkLineChanged'));
        void loadOrder();
      } else {
        handleFetchError(e);
      }
    },
  });

  // An iPad leaves the page for the camera or another app, and a second iPad
  // may have packed meanwhile; coming back re-reads both.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void loadOrder();
      void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadOrder, reload]);

  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const lines: Line[] = useMemo(
    () => (order?.lines ?? []).map(l => ({ ...l, serialNumber: serials.get(l.id) ?? null })),
    [order, serials],
  );
  const lineById = useMemo(() => new Map(lines.map(l => [l.id, l])), [lines]);
  const readOnly = !!order && (order.archivedAt !== null || order.status === 'Closed');
  const ready = loadState === 'ok' && !!order && !readOnly;
  const isDraft = order?.status === 'Draft';

  const warehouses = useMemo(() => packWarehouseOptions(lines), [lines]);
  // A picked warehouse the order no longer has (a line was moved) falls back to all.
  const picked = warehouses.includes(wh) ? wh : '';
  const rows = useMemo(() => packView(lines, picked), [lines, picked]);
  // Typing narrows the list once it pauses. The filter searches the whole
  // order, packable lines only, as Enter does, so it never hides the line
  // Enter would pack. It changes only what is listed — progress and Mark
  // shipped read `rows` and `lines`.
  const filterText = useScanFilterText(scan);
  const fit = useMemo(() => {
    const hits = filterScan(lines.filter(isPackable), filterText);
    return hits ? new Set(hits.map(l => l.id)) : null;
  }, [lines, filterText]);
  const listed = useMemo(
    () => (fit ? packView(lines, '').filter(r => fit.has(r.line.id)) : rows),
    [fit, lines, rows],
  );
  const shownPackable = useMemo(() => rows.map(r => r.line).filter(isPackable), [rows]);
  const sum = useMemo(() => tally(shownPackable, checks), [shownPackable, checks]);
  const blockers = useMemo(() => shipBlockers(lines, checks), [lines, checks]);
  const lineNo = useMemo(() => new Map(lines.map((l, i) => [l.id, l.no ?? i + 1])), [lines]);
  const canShip = ready && isDraft && lines.some(isPackable)
    && blockers.open === 0 && blockers.short === 0 && blockers.zero === 0;

  const whName = (w: string | null) => (w === null || w === UNASSIGNED ? t('sodNoWarehouse') : w);
  const fromText = (l: Line) => {
    const tag = sourceTag(l);
    if (!tag) return t('pkTypedIn');
    return tag.no != null ? t('pkFromPoLine', { po: tag.po, n: tag.no }) : t('pkFromPo', { po: tag.po });
  };
  const checkOf = (lineId: string) => checks.get(lineId) ?? emptyCheck(lineId, lineById.get(lineId)?.qty ?? 0);

  const exit = () => navigateBack('/sell-orders/' + id);
  // Escape joins the app's layer stack, so the Shipped dialog closes first.
  // Text left in the scan box goes before the page does: an ambiguous scan
  // leaves its filter up with the box blurred.
  useEscapeKey(() => { if (scan) setScan(''); else exit(); });

  const flashUndo = (u: Undo) => {
    setUndo(u);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };

  // The stepper only changes the number. Lowering a packed line takes the
  // tick away, so a short pick is always confirmed by a tick made after it.
  const setCount = (l: Line, n: number) => {
    if (!ready) return;
    const prev = checkOf(l.id);
    const counted = Math.max(0, Math.min(l.qty, n));
    if (counted === prev.counted) return;
    save({ ...prev, counted, checkedAt: counted < l.qty ? null : prev.checkedAt });
  };

  const pack = (l: Line) => {
    const prev = checkOf(l.id);
    save({ ...prev, checkedAt: new Date().toISOString() });
    setChoose(new Set());
    flashUndo({ prev, msg: t('pkPackedToast', { pn: pnOf(l), n: countOf(l, prev), of: l.qty }) });
  };

  const toggle = (l: Line) => {
    if (!ready) return;
    const c = checkOf(l.id);
    if (lineState(l, c) === 'done') {
      save({ ...c, checkedAt: null });
      flashUndo({ prev: c, msg: t('pkUnpackedToast', { pn: pnOf(l) }) });
      return;
    }
    pack(l);
  };

  const undoLast = () => {
    if (!undo || !ready) return;
    save(undo.prev);
    setUndo(null);
  };

  const scrollTo = (lineId: string) =>
    requestAnimationFrame(() => document.getElementById('pk-row-' + lineId)?.scrollIntoView({ block: 'nearest' }));

  // ── Scanner: a Bluetooth or USB scanner types the label and presses Enter.
  const onScan = (raw: string) => {
    const text = raw.trim();
    const m = text && ready ? packScan(lines, checks, text) : null;
    // Text that fits several parts stays, and with it the list it narrowed to,
    // to pick from. The box lets go of it, so the next scan replaces it rather
    // than running on from it.
    const ambiguous = m !== null && 'ambiguous' in m;
    if (!ambiguous) setScan('');
    if (scanFromPage.current || ambiguous) {
      scanFromPage.current = false;
      scanRef.current?.blur();
    }
    if (!text || !ready) return;
    setChoose(new Set());
    if (!m) {
      setScanMsg({ tone: 'neg', text: t('pkScanNoMatch', { pn: text, id }) });
      return;
    }
    if ('ambiguous' in m) {
      setScanMsg({ tone: 'neg', text: t('pkScanAmbiguous', { pn: text, pns: partsNamed(m.ambiguous, t) }) });
      return;
    }
    if ('choose' in m) {
      setChoose(new Set(m.choose.map(l => l.id)));
      setScanMsg({ tone: 'warn', text: t('pkScanChoose', { pn: text, n: m.choose.length, lots: m.choose.map(l => `#${lineNo.get(l.id)} ${fromText(l)}`).join(', ') }) });
      if (picked && m.choose.some(l => packWarehouseOf(l) !== picked)) setWh('');
      scrollTo(m.choose[0]!.id);
      return;
    }
    const hit = m.line;
    const c = checks.get(hit.id);
    if (countOf(hit, c) === 0) {
      setScanMsg({ tone: 'neg', text: t('pkScanZero', { pn: pnOf(hit) }) });
      scrollTo(hit.id);
      return;
    }
    if (lineState(hit, c) === 'done') {
      setScanMsg({ tone: 'muted', text: t('pkScanAlready', { pn: pnOf(hit) }) });
      return;
    }
    setScanMsg({ tone: 'pos', text: t('pkScanPacked', { pn: pnOf(hit) }) });
    pack(hit);
    scrollTo(hit.id);
  };

  // A scanner types into whatever has focus. Its first character starts the
  // scan in the box; the rest then follows it there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The photo viewer isn't an aria-modal dialog, so it is named here.
      if (shipping || zoom || document.querySelector('[aria-modal="true"]')) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        scanRef.current?.focus();
        return;
      }
      if (ready && e.key.length === 1 && e.key.trim()) {
        e.preventDefault();
        scanFromPage.current = true;
        setScan(e.key);
        scanRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // ── Mark shipped: the counterpart of Review mode's Approve. Every write
  // lands first, then the Shipped dialog takes the packing photos.
  const startShip = async () => {
    if (!canShip || busy) return;
    try {
      await flush();
    } catch (e) {
      handleFetchError(e);
      return;
    }
    setShipping(true);
  };

  const confirmShip = async (note: string) => {
    setShipping(false);
    setBusy(true);
    try {
      await api.post(`/api/sell-orders/${id}/status`, { to: 'Shipped', note });
    } catch (e) {
      // Leaving Draft re-checks that the lots are still free; the server says why.
      showErrorDialog(e instanceof Error ? e.message : t('saveFailed'));
      setBusy(false);
      void loadOrder();
      return;
    }
    onToast?.(t('pkShippedToast', { id }));
    exit();
  };

  const row = (l: Line, no: number) => {
    const c = checkOf(l.id);
    const state = lineState(l, c);
    const n = countOf(l, c);
    const pn = pnOf(l);
    const packable = isPackable(l);
    // Condition stays in the meta row, so the SSD/HDD chips don't repeat it.
    const chipLine = { ...l, condition: null };
    return (
      <li
        key={l.id}
        id={'pk-row-' + l.id}
        className={'pk-row ' + (packable ? 'pk-' + state : 'pk-zero')
          + (isShortChecked(l, c) ? ' pk-done-short' : '')
          + (isAbsentChecked(l, c) ? ' pk-done-zero' : '')
          + (choose.has(l.id) ? ' pk-choose' : '')}
      >
        <div className="pk-tag" title={t('pkLineTitle', { n: no, id })}>
          <span className="pk-tag-po">{id}</span>
          <span className="pk-tag-no">#{no}</span>
        </div>
        {l.imageUrl ? (
          <button
            type="button" className="pk-photo" aria-label={t('pkPhoto', { pn })}
            onClick={() => setZoom(l.imageUrl!)}
          >
            <img src={l.imageUrl} alt="" loading="lazy" decoding="async" />
          </button>
        ) : (
          // Same footprint, so the items stay in one column.
          <div className="pk-photo pk-photo-none" aria-hidden="true"><Icon name="image" size={20} /></div>
        )}
        <div className="pk-item">
          <div className="pk-label">{l.label}</div>
          {lineHasSpecChips(chipLine, true)
            ? <LineSpecChips line={chipLine} withType />
            : l.sub && <div className="pk-sub">{l.sub}</div>}
          <div className="pk-meta">
            <span className="mono">{l.partNumber ?? '—'}</span>
            {l.condition && <span>{l.condition}</span>}
            <span className="mono pk-from">{fromText(l)}</span>
            {!picked && warehouses.length > 1 && <span>{whName(packWarehouseOf(l))}</span>}
          </div>
        </div>
        {packable ? (
          <div className="pk-ctrl">
            <div className="pk-count-wrap">
              <div className="pk-step">
                <button
                  type="button" className="pk-step-btn" aria-label={t('pkLess')}
                  disabled={!ready || n === 0} onClick={() => setCount(l, n - 1)}
                >
                  <Icon name="minus" size={18} />
                </button>
                <span className="pk-count mono"><b>{n}</b><span> / {l.qty}</span></span>
                <button
                  type="button" className="pk-step-btn" aria-label={t('pkMore')}
                  disabled={!ready || n >= l.qty} onClick={() => setCount(l, n + 1)}
                >
                  <Icon name="plus" size={18} />
                </button>
              </div>
              {n === 0
                ? <span className="pk-flag neg">{t('pkZeroTag')}</span>
                : n < l.qty && <span className="pk-flag warn">{t('pkShortTag')}</span>}
            </div>
            <button
              type="button"
              className="pk-tick"
              aria-pressed={state === 'done'}
              aria-label={t(state === 'done' ? 'pkUnpackLine' : 'pkPackLine', { pn })}
              disabled={!ready}
              onClick={() => toggle(l)}
            >
              <Icon name="check" size={26} stroke={3} />
            </button>
          </div>
        ) : (
          <div className="pk-zero-note">{t('pkZeroLine')}</div>
        )}
      </li>
    );
  };

  // With no order yet there is nothing to report, packed least of all.
  const barText = !order
    ? ''
    : readOnly
    ? t(order.archivedAt ? 'pkArchived' : 'pkClosed')
    : blockers.open > 0
      ? t('pkBarLeft', { n: blockers.open })
      : blockers.short > 0 || blockers.zero > 0
        ? t('pkBarFix', { short: blockers.short, zero: blockers.zero })
        : !isDraft && order
          ? t('pkBarStatus', { status: order.status })
          : t('pkBarDone');

  const units = lines.reduce((a, l) => a + l.qty, 0);
  const shippedMeta = order?.statusMeta.Shipped;

  return (
    <div className="pk-page">
      <div className="pk-head">
        <div className="pk-head-main">
          <button type="button" className="bc-back" onClick={exit}>
            <Icon name="chevronLeft" size={12} /> {t('pkBack')}
          </button>
          <div className="bc-title-row">
            <h1 className="page-title">{t('pkTitle')}</h1>
            <span className="mono bc-id">{id}</span>
            {order && <span className={'chip dot ' + toneFor(order.status)}>{order.status}</span>}
          </div>
          {order && (
            <div className="page-sub">
              {order.customer.name} · {t('pkSub', { lines: lines.length, units })}
            </div>
          )}
        </div>
        <div className="pk-scan-wrap">
          <div className="bc-scan-field">
            <label className="bc-scan pk-scan" htmlFor="pk-scan">
              <Icon name="scan" size={17} />
              <input
                id="pk-scan"
                ref={scanRef}
                className="input mono"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                value={scan}
                disabled={!ready}
                placeholder={t('pkScanPh')}
                onChange={e => setScan(e.target.value)}
                onBlur={() => { scanFromPage.current = false; }}
                onKeyDown={e => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') { e.preventDefault(); onScan(scan); }
                  // Clears the box, then leaves it; never the page.
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    if (scan) setScan('');
                    else e.currentTarget.blur();
                  }
                }}
              />
            </label>
            {/* An iPad has no Escape key. */}
            {scan && (
              <button type="button" className="bc-scan-clear pk-scan-clear" title={t('scanClear')} aria-label={t('scanClear')} onClick={() => setScan('')}>
                <Icon name="x" size={15} />
              </button>
            )}
          </div>
          <div className={'bc-scan-msg ' + (scanMsg?.tone ?? 'muted')} aria-live="polite">
            {scanMsg ? scanMsg.text : t('pkScanHint')}
          </div>
        </div>
      </div>

      {readOnly && (
        <div className="oe-banner bc-banner"><Icon name="lock" size={13} /> {barText}</div>
      )}

      <div className="card pk-progress">
        <div className="pk-progress-num">
          <span className="mono"><b>{sum.done}</b><span className="muted"> / {shownPackable.length}</span></span>
          <span className="card-sub">{t('pkUnits', { n: sum.counted, of: sum.units })}</span>
        </div>
        <div className="pk-progress-meter">
          <div className="bc-meter" role="img" aria-label={t('pkProgress', { n: sum.done, of: shownPackable.length })}>
            <i className="bc-m-done" style={{ flexGrow: sum.done }} />
            <i className="bc-m-part" style={{ flexGrow: sum.partial }} />
            <i className="bc-m-absent" style={{ flexGrow: sum.absent }} />
            <i className="bc-m-open" style={{ flexGrow: sum.open }} />
          </div>
          <div className="bc-legend">
            <span className="chip pos dot">{t('pkLegendPacked', { n: sum.done })}</span>
            {sum.partial > 0 && <span className="chip warn dot">{t('pkLegendShort', { n: sum.partial })}</span>}
            {sum.absent > 0 && <span className="chip neg dot">{t('pkLegendZero', { n: sum.absent })}</span>}
            <span className="chip muted dot">{t('pkLegendOpen', { n: sum.open })}</span>
          </div>
        </div>
        {warehouses.length > 1 && (
          <div className="pk-wh">
            <span className="pk-wh-label">{t('pkWarehouse')}</span>
            <div className="seg" role="group" aria-label={t('pkWarehouse')}>
              <button type="button" className={picked === '' ? 'active' : ''} aria-pressed={picked === ''} onClick={() => setWh('')}>
                {t('pkAllWarehouses')}
              </button>
              {warehouses.map(w => (
                <button key={w} type="button" className={picked === w ? 'active' : ''} aria-pressed={picked === w} onClick={() => setWh(w)}>
                  {whName(w)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card pk-list-card">
        {!order && orderFailed ? (
          <div className="card-body bc-load-error">
            <span>{t('pkOrderLoadFailed')}</span>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setOrderFailed(false);
                void loadOrder();
                if (loadState === 'error') void reload();
              }}
            >
              {t('pkRetry')}
            </button>
          </div>
        ) : !order || loadState === 'loading' ? (
          <div className="card-body muted">{t('loadingApp')}</div>
        ) : loadState === 'error' ? (
          <div className="card-body bc-load-error">
            <span>{t('pkLoadFailed')}</span>
            <button type="button" className="btn sm" onClick={() => void reload()}>{t('pkRetry')}</button>
          </div>
        ) : (
          <ul className="pk-list">
            {listed.map(r => row(r.line, r.no))}
            {fit?.size === 0 && <li className="pk-empty">{t('pkFilterNone', { pn: filterText, id })}</li>}
            {!fit && rows.length === 0 && <li className="pk-empty">{t('pkNoneHere')}</li>}
          </ul>
        )}
      </div>

      <div className="pk-bar">
        <div className="pk-bar-msg" aria-live="polite">
          {undo ? (
            <>
              <span>{undo.msg}</span>
              <button type="button" className="btn sm" onClick={undoLast}>{t('undo')}</button>
            </>
          ) : <span>{barText}</span>}
        </div>
        <div className="pk-bar-actions">
          {readOnly || !isDraft ? (
            <button type="button" className="btn lg" onClick={exit}>{t('pkBack')}</button>
          ) : (
            <>
              {(blockers.short > 0 || blockers.zero > 0) && (
                <button type="button" className="btn lg" onClick={() => navigate(`/sell-orders/${id}/edit`)}>
                  <Icon name="edit" size={15} /> {t('editOrder')}
                </button>
              )}
              <button
                type="button"
                className="btn accent lg"
                disabled={!canShip || busy}
                title={canShip ? undefined : t('pkMarkShippedTip')}
                onClick={() => void startShip()}
              >
                <Icon name="truck" size={16} /> {t('pkMarkShipped')}
              </button>
            </>
          )}
        </div>
      </div>

      {shipping && order && (
        <StatusChangeDialog
          orderId={order.id}
          to="Shipped"
          currentStatus={order.status}
          initialNote={shippedMeta?.note ?? ''}
          initialAttachments={shippedMeta?.attachments ?? []}
          onCancel={() => setShipping(false)}
          onConfirm={({ note }) => void confirmShip(note)}
        />
      )}
      {zoom && <ImageLightbox url={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}
