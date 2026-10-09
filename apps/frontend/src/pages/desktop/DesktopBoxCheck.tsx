import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseSerials, serialIssue } from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { OrderCategoryChips } from '../../components/OrderCategoryChips';
import { LineSpecChips } from '../../components/LineSpecChips';
import { useManagerTakeover } from '../../components/ManagerTakeoverDialog';
import { PaymentMismatchBanner, usePaymentMismatchConfirm } from '../../components/PaymentMismatch';
import { SerialCheckDialog, type SerialLineIssue } from '../../components/SerialCheckDialog';
import { api, rawFetch } from '../../lib/api';
import {
  checkBody, countOf, emptyCheck, entryAnswerFor, filterScan, isAbsentChecked, isShortChecked, lineState, matchScan, nextOpenAfter,
  orderLines, partsNamed, readStageMoved, stashEntryAnswer, tally,
  type ChecksResponse, type LineCheck,
} from '../../lib/boxCheck';
import { handleFetchError, showErrorDialog } from '../../lib/errorToast';
import { fmtUSD } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { useLineSaveQueue } from '../../lib/useLineSaveQueue';
import { useScanFilterText } from '../../lib/useScanFilter';
import { lineSpecLabel } from '../../lib/lineGroups';
import { linePhotos } from '../../lib/linePhotos';
import { lineRequirements, missingFieldNames } from '../../lib/lineRequirements';
import { paymentGap, reviewApproveTotal } from '../../lib/paymentGap';
import { poStageName } from '../../lib/orderPresentation';
import { lineShippedOn } from '../../lib/poPermissions';
import { statusTone } from '../../lib/status';
import type { Order, OrderLine } from '../../lib/types';
import { LineDrawer } from './submit/LineDrawer';
import { editLineToPatch, orderLineToEditLine, type EditLine } from './submit/editLine';
import { brandConfirmPending } from './submit/line';

// Review mode: the manager's bench view of one PO. Each line starts at its
// full qty and is ticked when found (lowered first when short); a ticked line
// sinks to the bottom so what is left to find stays on top. A line that
// arrived different from what the PO says is fixed in place with Edit.
// Progress lives on the server, so a reload or a second manager picks up
// where the count stands.

type Props = {
  order: Order;
  onExit: () => void;
  onApproved: () => void;
  // Re-reads the order after a line edit; the page remounts on the fresh copy.
  onReload: () => Promise<void>;
  showToast: (msg: string, kind?: 'success' | 'error' | 'warn') => void;
};

type Undo = { lineId: string; prev: LineCheck; msg: string };
type ScanMsg = { tone: 'muted' | 'pos' | 'neg'; text: string };
// The line open in the drawer, and the server's copy it is compared against.
type Editing = { line: EditLine; original: EditLine };

export function DesktopBoxCheck({ order, onExit, onApproved, onReload, showToast }: Props) {
  const { t, lang, locale } = useT();
  const lines = order.lines;
  const readOnly = order.archivedAt !== null;
  const atReviewing = order.lifecycle === 'reviewing';

  const [selectedId, setSelectedId] = useState<string | null>(lines[0]?.id ?? null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [serialIssues, setSerialIssues] = useState<SerialLineIssue[] | null>(null);
  const [showDone, setShowDone] = useState(true);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<ScanMsg | null>(null);
  const [busy, setBusy] = useState<'approve' | null>(null);
  const takeover = useManagerTakeover();
  const mismatch = usePaymentMismatchConfirm();
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [photoIdx, setPhotoIdx] = useState(0);

  const scanRef = useRef<HTMLInputElement | null>(null);
  // Set when a scanner's first character landed on the page and was moved into
  // the scan box; the box gives focus back once the scan is in.
  const scanFromPage = useRef(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lineById = useMemo(() => new Map(lines.map(l => [l.id, l])), [lines]);
  const lineByIdRef = useRef(lineById);
  lineByIdRef.current = lineById;

  // The list follows what is typed once typing pauses; Enter matches the
  // live text.
  const filterText = useScanFilterText(scan);
  const fit = useMemo(() => {
    const hits = filterScan(lines, filterText);
    return hits ? new Set(hits.map(l => l.id)) : null;
  }, [lines, filterText]);

  // ── Writes, through the queue Pack mode shares. Nothing may write until
  // the saved count is in: an action taken against the full-count default
  // would overwrite a short count on file.
  const url = (lineId: string) => `/api/orders/${order.id}/checks/${lineId}`;
  const bodyOf = (c: LineCheck) => checkBody(c, lineByIdRef.current.get(c.lineId)?.qty ?? c.counted);
  const { checks, loadState, reload, save, flush } = useLineSaveQueue<ChecksResponse>({
    read: () => api.get<ChecksResponse>(`/api/orders/${order.id}/checks`),
    send: c => api.put<ChecksResponse>(url(c.lineId), bodyOf(c)),
    beacon: c => { void rawFetch('PUT', url(c.lineId), bodyOf(c), undefined, { keepalive: true }).catch(() => {}); },
    checksOf: r => r.lines,
  });
  const ready = loadState === 'ok' && !readOnly;

  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const checkOf = useCallback(
    (id: string) => checks.get(id) ?? emptyCheck(id, lineById.get(id)?.qty ?? 0),
    [checks, lineById],
  );

  const flashUndo = (u: Undo) => {
    setUndo(u);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };

  // The stepper only changes the number. Lowering a checked line takes the
  // tick away, so a shortfall is always confirmed by a tick made after it —
  // and reaching the qty never ticks on its own, because the count starts there.
  const setCount = (l: OrderLine, n: number) => {
    if (!ready) return;
    const prev = checkOf(l.id);
    const counted = Math.max(0, Math.min(l.qty, n));
    if (counted === prev.counted) return;
    save({ ...prev, counted, checkedAt: counted < l.qty ? null : prev.checkedAt });
  };

  const check = (l: OrderLine) => {
    const prev = checkOf(l.id);
    const next: LineCheck = { ...prev, checkedAt: new Date().toISOString() };
    save(next);
    flashUndo({ lineId: l.id, prev, msg: t('bcCheckedToast', { pn: l.partNumber ?? lineLabel(l), n: countOf(l, prev), of: l.qty }) });
    setSelectedId(nextOpenAfter(lines, new Map(checks).set(l.id, next), l.id)?.id ?? l.id);
  };

  const toggle = (l: OrderLine) => {
    if (!ready) return;
    const c = checkOf(l.id);
    if (lineState(l, c) === 'done') {
      save({ ...c, checkedAt: null });
      flashUndo({ lineId: l.id, prev: c, msg: t('bcUncheckedToast', { pn: l.partNumber ?? lineLabel(l) }) });
      return;
    }
    check(l);
  };

  // ── Edit: the line fixed to what actually arrived, through the PO page's
  // own drawer and the same PATCH, so the rules a save meets are the same.
  const openEdit = (l: OrderLine) => {
    if (!ready || lineShippedOn(l).length) return;
    setSelectedId(l.id);
    const line = orderLineToEditLine(l, lines.indexOf(l));
    setEditing({ line, original: line });
  };

  // A cost is owed only once the line is touched, as on the PO page: legacy
  // $0 lines must stay openable. Every line here is already on the PO, so it
  // may be set to 0.
  const editRequirements = (l: EditLine) =>
    lineRequirements(l, { requireCost: !!l._dirty, allowZeroQty: true });

  // Throws to keep the drawer open; the drawer shows the message.
  const confirmEdit = async (): Promise<void> => {
    if (!editing) return;
    const { line: l, original: o } = editing;
    if (!l._dirty || !l._id) return;
    const id = l._id;
    if (brandConfirmPending(l)) throw new Error(t('subConfirmBrandThis'));
    if (!editRequirements(l).ready) throw new Error(t('subFillThisLine'));
    // Serial rules fire where the backend's do: when serial, qty or
    // generation moved off what the server holds.
    const serialsMoved = (l.generation ?? null) !== (o.generation ?? null)
      || Number(l.qty) !== Number(o.qty)
      || (l.serialNumber ?? '') !== (o.serialNumber ?? '');
    const issue = serialsMoved ? serialIssue(l) : null;
    const n = l.no ?? lines.findIndex(x => x.id === id) + 1;
    if (issue) {
      setSerialIssues([{ line: `#${n}`, label: l.partNumber || lineSpecLabel(l) || '—', issue }]);
      throw new Error(t('serialCheckTitle'));
    }
    await api.patch(`/api/orders/${order.id}`, { lines: [editLineToPatch(l)] });
    // Units added to the line were never counted, so its tick can't stand.
    // It replaces whatever was waiting for the line and goes out with the
    // rest before the reload: the remount reads the count straight back.
    if (Number(l.qty) !== Number(o.qty)) save(emptyCheck(id, Number(l.qty)));
    await flush().catch(handleFetchError);
    showToast(t('bcLineSaved', { n }), 'success');
    await onReload();
  };

  const applyUndo = () => {
    if (!undo || !ready) return;
    save(undo.prev);
    setSelectedId(undo.lineId);
    setUndo(null);
  };

  const ordered = useMemo(() => orderLines(lines, checks), [lines, checks]);
  const sum = useMemo(() => tally(lines, checks), [lines, checks]);
  const remaining = ordered.open.length;
  // Only the rows on screen follow the filter; every count and gate reads
  // `ordered`, so a filter can never hide a line from Approve.
  const listed = useMemo(() => (fit
    ? { open: ordered.open.filter(l => fit.has(l.id)), done: ordered.done.filter(l => fit.has(l.id)) }
    : ordered), [ordered, fit]);
  const visible = useMemo(
    () => [...listed.open, ...(showDone ? listed.done : [])],
    [listed, showDone],
  );
  const selected = (selectedId && lineById.get(selectedId)) || lines[0] || null;
  // A selection the filter hides takes no keys; the arrows bring it back in.
  const selectedShown = selected && (!fit || fit.has(selected.id)) ? selected : null;

  const checkAllRemaining = () => {
    if (!ready) return;
    const now = Date.now();
    // Short lines are left for their own tick; everything still at its full
    // count is ticked, a line already at qty 0 included — there is nothing of
    // it to count. Staggered stamps keep the batch in PO order inside Checked.
    ordered.open
      .filter(l => l.qty === 0 || lineState(l, checks.get(l.id)) === 'open')
      .forEach((l, i) => save({ ...checkOf(l.id), checkedAt: new Date(now - i).toISOString() }));
    setUndo(null);
  };

  // ── Scanner: a USB/Bluetooth scanner types the label and presses Enter.
  const onScan = (raw: string) => {
    const text = raw.trim();
    const m = text && ready ? matchScan(lines, checks, text) : null;
    // Text that fits several parts stays, and with it the list it narrowed to,
    // for the manager to pick from. The box lets go of it, so the arrows work
    // and the next scan replaces it rather than running on from it.
    const ambiguous = m !== null && 'ambiguous' in m;
    if (!ambiguous) setScan('');
    if (scanFromPage.current || ambiguous) {
      scanFromPage.current = false;
      scanRef.current?.blur();
    }
    if (!text || !ready) return;
    if (!m) {
      setScanMsg({ tone: 'neg', text: t('bcScanNoMatch', { pn: text, id: order.id }) });
      return;
    }
    if ('ambiguous' in m) {
      setScanMsg({ tone: 'neg', text: t('bcScanAmbiguous', { pn: text, pns: partsNamed(m.ambiguous, t) }) });
      return;
    }
    const hit = m.line;
    setSelectedId(hit.id);
    const pn = hit.partNumber ?? lineLabel(hit);
    const state = lineState(hit, checks.get(hit.id));
    // A scan says the part is here, and a tick at 0 would confirm it isn't —
    // Approve would then set the line to 0. A line already at qty 0 has no
    // count to raise; only an edit can put units back on it.
    if (hit.qty === 0) {
      setScanMsg({ tone: 'neg', text: t('bcScanZeroQty', { pn }) });
      return;
    }
    if (countOf(hit, checks.get(hit.id)) === 0) {
      setScanMsg({ tone: 'neg', text: t('bcScanZero', { pn }) });
      return;
    }
    // A scan checks the whole line, so the next unit of it reads as already
    // done.
    if (state === 'done') {
      setScanMsg({ tone: 'muted', text: t('bcScanAlreadyChecked', { pn }) });
      return;
    }
    // A scan means "found it": the line is ticked at the count it shows.
    setScanMsg({ tone: 'pos', text: t('bcScanChecked', { pn }) });
    check(hit);
    requestAnimationFrame(() => document.getElementById('bc-row-' + hit.id)?.scrollIntoView({ block: 'nearest' }));
  };

  const approve = async () => {
    if (!ready) return;
    // Before anything is written, so Cancel leaves the PO as it was.
    if (!(await mismatch.confirm(order.id, gap))) return;
    // Answered on the way into this visit, it isn't asked a second time.
    const answer = entryAnswerFor(order) ?? await takeover.ask(order);
    if (answer === null) return;
    setBusy('approve');
    // Once lines are at 0, a move that doesn't happen leaves this page showing
    // the qty they had; the re-read brings the new one (and the goods total).
    let zeroed = false;
    const reloadIfZeroed = () => (zeroed ? onReload().catch(handleFetchError) : undefined);
    try {
      await flush();
      // Ahead of the move: from Ready to Pay the lines are closed book. Set to
      // 0 rather than removed, so every line keeps its # on the PO.
      if (toZero.length) {
        await api.patch(`/api/orders/${order.id}`, { lines: toZero.map(l => ({ id: l.id, qty: 0 })) });
        zeroed = true;
      }
      // The page may have sat open while someone else moved the PO; the jump
      // is refused under the row lock unless it is still at Reviewing.
      const moved = await takeover.advance(order, { toStage: 'ready_to_pay', fromStage: 'reviewing' }, answer);
      if (!moved) {
        await reloadIfZeroed();
        return;
      }
      stashEntryAnswer(order.id, null);
    } catch (e) {
      const now = readStageMoved(e);
      if (now !== null) showErrorDialog(t('bcStaleStage', { id: order.id, s: poStageName(now, t) }));
      else handleFetchError(e);
      await reloadIfZeroed();
      return;
    } finally {
      setBusy(null);
    }
    onApproved();
  };

  // ── FLIP: a row that changes group slides from where it was. Positions are
  // measured inside the table, so scrolling the page between two changes
  // doesn't read as every row having moved.
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const lastTops = useRef(new Map<string, number>());
  const lastFit = useRef(fit);
  useLayoutEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // A filter coming, going or narrowing moves rows without any of them
    // changing group: measured, never animated.
    const refiltered = lastFit.current !== fit;
    lastFit.current = fit;
    const tops = new Map<string, number>();
    rowRefs.current.forEach((el, id) => {
      const top = el.offsetTop;
      tops.set(id, top);
      const was = lastTops.current.get(id);
      if (!reduce && !refiltered && was !== undefined && Math.abs(was - top) > 2 && el.animate) {
        el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }],
          { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    lastTops.current = tops;
  }, [ordered, showDone, fit]);

  // Escape joins the app's layer stack, so a dialog or the photo on top of
  // the page closes first and the page only leaves when it is the top layer.
  // Text left in the scan box goes before the page does: an ambiguous scan
  // leaves its filter up with the box blurred.
  useEscapeKey(() => {
    if (editing) setEditing(null);
    else if (scan) setScan('');
    else onExit();
  });

  // ── Keyboard. Ignored while typing, so the scan box stays a plain text
  // field, and while the drawer or a dialog is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lightbox || editing || serialIssues || document.querySelector('[aria-modal="true"]')) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select')) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Escape') return;
      const i = visible.findIndex(l => l.id === selected?.id);
      const move = (d: number) => {
        const n = visible[Math.max(0, Math.min(visible.length - 1, i + d))];
        if (!n) return;
        setSelectedId(n.id);
        requestAnimationFrame(() => document.getElementById('bc-row-' + n.id)?.scrollIntoView({ block: 'nearest' }));
      };
      switch (e.key) {
        case 'ArrowDown': case 'j': e.preventDefault(); move(1); break;
        case 'ArrowUp': case 'k': e.preventDefault(); move(-1); break;
        case ' ':
          // A row's own buttons keep focus after a click while the arrows move
          // the selection; Space belongs to the selected row, not to them.
          // Buttons outside the list (Approve) keep their own Space.
          if (target?.closest('button') && !target.closest('.bc-table')) return;
          e.preventDefault();
          if (target?.closest('button')) target.blur();
          if (selectedShown) toggle(selectedShown);
          break;
        case '+': case '=': if (selectedShown) setCount(selectedShown, countOf(selectedShown, checkOf(selectedShown.id)) + 1); break;
        case '-': if (selectedShown) setCount(selectedShown, countOf(selectedShown, checkOf(selectedShown.id)) - 1); break;
        // Lowercase only: scanners type labels in uppercase (F4-…, KVR…).
        case 'e': e.preventDefault(); if (selectedShown) openEdit(selectedShown); break;
        case '/': e.preventDefault(); scanRef.current?.focus(); break;
        default:
          // A scanner types into whatever has focus. Its first character
          // starts the scan in the box; the rest then follows it there, so
          // the label never runs as shortcuts.
          if (ready && e.key.length === 1 && e.key.trim()) {
            e.preventDefault();
            scanFromPage.current = true;
            setScan(e.key);
            scanRef.current?.focus();
          }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => { setPhotoIdx(0); }, [selected?.id]);

  const short = ordered.done.filter(l => isShortChecked(l, checks.get(l.id)));
  const absent = ordered.done.filter(l => isAbsentChecked(l, checks.get(l.id)));
  // What Approve still has to set to 0: a line already there needs nothing,
  // and one held for a shipped sell order is that sale's record — its count
  // here is a box check, never a recount.
  const toZero = absent.filter(l => l.qty > 0 && lineShippedOn(l).length === 0);
  // Against the total the PO will have once Approve has zeroed those lines,
  // so a line counted 0 can open a gap, or close one, before the click.
  const gap = paymentGap(order.linkedPaid, reviewApproveTotal(order, atReviewing ? toZero : []), order.payment);
  // Nothing on this PO arrived: there is nothing to pay for.
  const allAbsent = absent.length === lines.length;
  // The product's # on the PO, which regrouping the rows doesn't touch. An
  // older backend sends none; its lines came in # order.
  const lineNo = (l: OrderLine) => l.no ?? lines.indexOf(l) + 1;

  const row = (l: OrderLine) => {
    const c = checkOf(l.id);
    const state = lineState(l, c);
    const shots = linePhotos(l);
    const isSel = selected?.id === l.id;
    const pn = l.partNumber ?? lineLabel(l);
    const shippedOn = lineShippedOn(l);
    const held = shippedOn.length > 0;
    return (
      <Fragment key={l.id}>
        <tr
          id={'bc-row-' + l.id}
          ref={el => { if (el) rowRefs.current.set(l.id, el); else rowRefs.current.delete(l.id); }}
          className={'bc-row bc-' + state + (isAbsentChecked(l, c) ? ' bc-done-absent' : '') + (isSel ? ' row-selected' : '')}
          onClick={() => setSelectedId(l.id)}
        >
          <td className="bc-cb-cell">
            <button
              type="button"
              className="bc-cb"
              aria-pressed={state === 'done'}
              aria-label={t(state === 'done' ? 'bcUncheckLine' : 'bcCheckLine', { pn })}
              disabled={!ready}
              onClick={e => { e.stopPropagation(); setSelectedId(l.id); toggle(l); }}
            >
              {state === 'done' && <Icon name="check" size={14} stroke={3} />}
            </button>
          </td>
          <td className="mono muted bc-no-cell">#{lineNo(l)}</td>
          <td className="bc-thumb-cell">
            {shots.length ? (
              <img className="bc-thumb" src={shots[0]!.url} alt="" />
            ) : (
              <span className="bc-thumb bc-thumb-empty"><Icon name={l.category === 'RAM' ? 'chip' : 'drive'} size={16} /></span>
            )}
          </td>
          <td>
            <div className="bc-pn mono">{pn}</div>
            <div className="bc-spec">
              <span>{lineLabel(l)}</span>
              <LineSpecChips line={l} withType />
            </div>
            {held && (
              <span className="chip info" title={t('lineShippedReadOnly', { so: shippedOn.join(', ') })}>
                <Icon name="lock" size={10} /> {t('lineShippedChip', { so: shippedOn.join(', ') })}
              </span>
            )}
          </td>
          <td className="muted bc-cond">{l.condition}</td>
          <td className="num">
            <div className="bc-count" onClick={e => e.stopPropagation()}>
              <button type="button" className="btn ghost icon-only sm" aria-label={t('bcCountLess')}
                disabled={!ready || held || countOf(l, c) === 0} onClick={() => { setSelectedId(l.id); setCount(l, countOf(l, c) - 1); }}>
                <Icon name="minus" size={13} />
              </button>
              <span className="mono bc-count-n">
                <b>{countOf(l, c)}</b><span className="muted"> / {l.qty}</span>
              </span>
              <button type="button" className="btn ghost icon-only sm" aria-label={t('bcCountMore')}
                disabled={!ready || held || countOf(l, c) >= l.qty} onClick={() => { setSelectedId(l.id); setCount(l, countOf(l, c) + 1); }}>
                <Icon name="plus" size={13} />
              </button>
            </div>
            {countOf(l, c) === 0 && <div className="bc-absent-tag">{t('bcAbsentTag')}</div>}
          </td>
          <td className="bc-edit-cell">
            <button
              type="button"
              className={'btn ghost icon-only sm bc-editbtn' + (editing?.line._id === l.id ? ' on' : '')}
              title={held ? t('lineShippedReadOnly', { so: shippedOn.join(', ') }) : t('bcEditTip')}
              aria-label={t('bcEditTip')}
              disabled={!ready || held}
              onClick={e => { e.stopPropagation(); openEdit(l); }}
            >
              <Icon name="edit" size={13} />
            </button>
          </td>
        </tr>
      </Fragment>
    );
  };

  const selCheck = selected ? checkOf(selected.id) : null;
  const selShots = selected ? linePhotos(selected) : [];
  const selSerials = selected ? parseSerials(selected.serialNumber) : [];
  const shot = selShots[Math.min(photoIdx, selShots.length - 1)];

  return (
    <div className="bc-page">
      <div className="page-head">
        <div>
          <button type="button" className="bc-back" onClick={onExit}>
            <Icon name="chevronLeft" size={12} /> {t('bcBack')}
          </button>
          <div className="bc-title-row">
            <h1 className="page-title">{t('bcTitle')}</h1>
            <span className="mono bc-id">{order.id}</span>
            <span className={'chip dot ' + statusTone(order.status)}>{order.status}</span>
            <OrderCategoryChips categories={order.categories} max={3} />
          </div>
          <div className="page-sub">
            {[
              t('submittedBy') + ' ' + order.userName,
              order.warehouse?.short ?? null,
              order.package ? [order.package.carrier, order.package.trackingNumber].filter(Boolean).join(' ') : null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="bc-keys" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('bcKeyMove')}</span>
          <span><kbd>{t('bcKeySpace')}</kbd> {t('bcKeyCheck')}</span>
          <span><kbd>+</kbd><kbd>−</kbd> {t('bcKeyCount')}</span>
          <span><kbd>E</kbd> {t('bcKeyEdit')}</span>
          <span><kbd>/</kbd> {t('bcKeyScan')}</span>
        </div>
      </div>

      {readOnly && (
        <div className="oe-banner bc-banner"><Icon name="lock" size={13} /> {t('bcArchived')}</div>
      )}
      {gap && <PaymentMismatchBanner orderId={order.id} gap={gap} className="bc-banner" />}

      <div className="card bc-tally">
        <div className="bc-tally-num">
          <span className="mono"><b>{sum.counted}</b><span className="muted"> / {sum.units}</span></span>
          <span className="card-sub">{t('bcUnitsCounted', { n: sum.done, of: lines.length })}</span>
        </div>
        <div className="bc-tally-meter">
          <div className="bc-meter" role="img" aria-label={t('bcUnitsCounted', { n: sum.done, of: lines.length })}>
            <i className="bc-m-done" style={{ flexGrow: sum.done }} />
            <i className="bc-m-part" style={{ flexGrow: sum.partial }} />
            <i className="bc-m-absent" style={{ flexGrow: sum.absent }} />
            <i className="bc-m-open" style={{ flexGrow: sum.open }} />
          </div>
          <div className="bc-legend">
            <span className="chip pos dot">{t('bcLegendDone', { n: sum.done })}</span>
            <span className="chip warn dot">{t('bcLegendPartial', { n: sum.partial })}</span>
            {sum.absent > 0 && <span className="chip neg dot">{t('bcLegendAbsent', { n: sum.absent })}</span>}
            <span className="chip muted dot">{t('bcLegendOpen', { n: sum.open })}</span>
          </div>
        </div>
        {/* It ticks the whole PO, which a filter would hide most of. */}
        <button
          type="button"
          className="btn"
          disabled={!ready || remaining === 0 || fit !== null}
          title={fit ? t('bcCheckAllFiltered') : undefined}
          onClick={checkAllRemaining}
        >
          <Icon name="check2" size={13} /> {t('bcCheckAll')}
        </button>
      </div>

      <div className="bc-grid">
        <div className="card bc-list-card">
          <div className="card-head bc-scan-head">
            <div className="bc-scan-field">
              <label className="bc-scan" htmlFor="bc-scan">
                <Icon name="scan" size={15} />
                <input
                  id="bc-scan"
                  ref={scanRef}
                  className="input mono"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={scan}
                  disabled={!ready}
                  placeholder={t('bcScanPh')}
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
              {scan && (
                <button type="button" className="bc-scan-clear" title={t('scanClear')} aria-label={t('scanClear')} onClick={() => setScan('')}>
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>
            <div className={'bc-scan-msg ' + (scanMsg?.tone ?? 'muted')} aria-live="polite">
              {scanMsg ? scanMsg.text : t('bcScanHint')}
            </div>
          </div>
          {loadState === 'loading' ? (
            <div className="card-body muted">{t('loadingApp')}</div>
          ) : loadState === 'error' ? (
            <div className="card-body bc-load-error">
              <span>{t('bcLoadFailed')}</span>
              <button type="button" className="btn sm" onClick={() => void reload()}>{t('bcRetry')}</button>
            </div>
          ) : (
            <table className="table bc-table">
              <thead>
                <tr>
                  <th className="bc-cb-cell" aria-label={t('bcColChecked')} />
                  <th className="bc-no-cell" aria-label={t('bcColLineNo')} />
                  <th className="bc-thumb-cell" aria-label={t('linePhotos')} />
                  <th>{t('bcColItem')}</th>
                  <th>{t('bcColCondition')}</th>
                  <th className="num">{t('bcColCounted')}</th>
                  <th className="bc-edit-cell" aria-label={t('bcEditTip')} />
                </tr>
              </thead>
              <tbody>
                {listed.open.map(row)}
                {fit?.size === 0 && (
                  <tr className="bc-group-empty"><td colSpan={7}>{t('bcFilterNone', { pn: filterText, id: order.id })}</td></tr>
                )}
                {!fit && remaining === 0 && (
                  <tr className="bc-group-empty"><td colSpan={7}>{t('bcAllResolved')}</td></tr>
                )}
                {listed.done.length > 0 && (
                  <tr className="bc-group">
                    <td colSpan={7}>
                      {t('bcGroupChecked')} <span className="mono muted">{listed.done.length}</span>
                      <button type="button" className="bc-link" onClick={() => setShowDone(s => !s)}>
                        {showDone ? t('bcHide') : t('bcShow')}
                      </button>
                    </td>
                  </tr>
                )}
                {showDone && listed.done.map(row)}
              </tbody>
            </table>
          )}
        </div>

        <div className="bc-side">
          {selected && selCheck && (
            <div className="card bc-compare">
              <div className="card-head"><span className="card-title">{t('bcCompareTitle')} <span className="mono muted">#{lineNo(selected)}</span></span>
                {selShots.length > 1 && <span className="card-sub mono">{Math.min(photoIdx, selShots.length - 1) + 1} / {selShots.length}</span>}
              </div>
              <div className="bc-photo">
                {shot ? (
                  <button type="button" className="bc-photo-btn" onClick={() => setLightbox(shot.url)} title={t('linePhotos')}>
                    <img src={shot.url} alt={t('linePhotos')} />
                  </button>
                ) : (
                  <div className="bc-photo-empty"><Icon name="image" size={20} /><span>{t('bcNoPhoto')}</span></div>
                )}
              </div>
              {selShots.length > 1 && (
                <div className="bc-photo-strip">
                  {selShots.map((p, i) => (
                    <button key={p.url} type="button" className={'bc-photo-pip' + (i === photoIdx ? ' on' : '')} onClick={() => setPhotoIdx(i)}>
                      <img src={p.url} alt="" />
                    </button>
                  ))}
                </div>
              )}
              <div className="card-body bc-compare-body">
                <div className="bc-pn mono">{selected.partNumber ?? lineLabel(selected)}</div>
                <div className="card-sub">{lineLabel(selected)}</div>
                <dl className="bc-kv">
                  <dt>{t('bcColCondition')}</dt><dd>{selected.condition}</dd>
                  <dt>{t('bcExpected')}</dt><dd className="mono">{selected.qty}</dd>
                  <dt>{t('bcColCounted')}</dt><dd className="mono">{countOf(selected, selCheck)}</dd>
                  <dt>{t('unitCost')}</dt><dd className="mono">{fmtUSD(selected.unitCost, locale)}</dd>
                  {selected.chipNumber && (<><dt>{t('bcChip')}</dt><dd className="mono">{selected.chipNumber}</dd></>)}
                </dl>
                <div className="bc-serials">
                  <div className="card-sub">{selSerials.length ? t('bcSerialsOnFile', { n: selSerials.length }) : t('bcNoSerials')}</div>
                  {selSerials.length > 0 && (
                    <div className="bc-serial-list">{selSerials.map(s => <span key={s} className="mono">{s}</span>)}</div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="card bc-finish">
            <div className="card-head"><span className="card-title">{t('bcFinishTitle')}</span></div>
            <div className="card-body">
              {remaining > 0 ? (
                <p className="card-sub">{t(remaining === 1 ? 'bcRemainingOne' : 'bcRemainingMany', { n: remaining })}</p>
              ) : allAbsent ? (
                <p className="card-sub">{t('bcAllAbsent')}</p>
              ) : absent.length > 0 || short.length > 0 ? (
                <>
                  {absent.length > 0 && (
                    <>
                      <p className="card-sub">{t(atReviewing && toZero.length ? 'bcZeroIntro' : 'bcAbsentIntro', { n: absent.length })}</p>
                      <ul className="bc-problem-list">
                        {absent.map(l => (
                          <li key={l.id}>
                            <span className="mono">#{lineNo(l)} {l.partNumber ?? lineLabel(l)}</span>
                            {' · '}{t('bcShortNote', { n: 0, of: l.qty })}
                          </li>
                        ))}
                      </ul>
                      {atReviewing && toZero.length > 0 && order.goodsFollowsLines === false && (
                        <p className="card-sub bc-lot-note">{t('bcLotPriceKept')}</p>
                      )}
                    </>
                  )}
                  {short.length > 0 && (
                    <>
                      <p className="card-sub">{t('bcShortIntro', { n: short.length })}</p>
                      <ul className="bc-problem-list">
                        {short.map(l => (
                          <li key={l.id}>
                            <span className="mono">#{lineNo(l)} {l.partNumber ?? lineLabel(l)}</span>
                            {' · '}{t('bcShortNote', { n: countOf(l, checks.get(l.id)), of: l.qty })}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <p className="card-sub">{t(atReviewing ? 'bcAllMatch' : 'bcAllMatchNotReviewing', { n: lines.length, s: order.status })}</p>
              )}
              <div className="bc-finish-actions">
                {atReviewing && (
                  <button type="button" className="btn accent" disabled={!ready || busy !== null || takeover.asking || mismatch.asking || remaining > 0 || allAbsent} onClick={() => void approve()}>
                    <Icon name="check" size={13} /> {busy === 'approve' ? '…' : toZero.length && !allAbsent ? t('bcApproveZeroing', { n: toZero.length }) : t('bcApprove')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {undo && (
        <div className="toast-wrap">
          <div className="toast info bc-undo">
            <Icon name="check2" size={16} />
            <span>{undo.msg}</span>
            <button type="button" onClick={applyUndo}>{t('bcUndo')}</button>
          </div>
        </div>
      )}
      {lightbox && <ImageLightbox url={lightbox} alt={t('linePhotos')} onClose={() => setLightbox(null)} />}
      {editing && (
        <LineDrawer
          key={editing.line._id}
          line={editing.line}
          idx={lines.findIndex(x => x.id === editing.line._id)}
          editing
          onChange={patch => setEditing(e => e && { ...e, line: { ...e.line, ...patch, _dirty: true } })}
          onClose={() => setEditing(null)}
          onRemove={() => {}}
          canRemove={false}
          onConfirmLine={confirmEdit}
          onConfirmError={showErrorDialog}
          readOnly={!ready}
          missingFields={missingFieldNames(editRequirements(editing.line).missingKeys, t, lang)}
        />
      )}
      {serialIssues && <SerialCheckDialog issues={serialIssues} onClose={() => setSerialIssues(null)} />}
      {takeover.dialog}
      {mismatch.dialog}
    </div>
  );
}

function lineLabel(l: OrderLine): string {
  return lineSpecLabel(l) || l.description || l.category;
}
