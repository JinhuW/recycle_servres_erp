import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isPricedSellPrice, parseSerials, serialIssue } from '@recycle-erp/shared';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';
import { CurrencyPicker, type Currency } from '../../components/CurrencyPicker';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { OrderCategoryChips } from '../../components/OrderCategoryChips';
import { LineSpecChips } from '../../components/LineSpecChips';
import { useManagerTakeover } from '../../components/ManagerTakeoverDialog';
import { PaymentMismatchBanner, usePaymentMismatchConfirm } from '../../components/PaymentMismatch';
import { SerialCheckDialog, type SerialLineIssue } from '../../components/SerialCheckDialog';
import { api, ApiError, rawFetch } from '../../lib/api';
import { applyPatch, canApply, openIssuesByLine, settledBy, useAiReview, type AiFinding } from '../../lib/aiReview';
import {
  checkBody, countOf, emptyCheck, entryAnswerFor, filterScan, isAbsentChecked, isShortChecked, lineState, matchScan, nextOpenAfter,
  orderLines, partsNamed, readStageMoved, reviewedCounts, stashEntryAnswer, tally,
  type ChecksResponse, type LineCheck,
} from '../../lib/boxCheck';
import { handleFetchError, showErrorDialog } from '../../lib/errorToast';
import { fmtDate, fmtMoney, fmtUSD } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { useLineSaveQueue } from '../../lib/useLineSaveQueue';
import { useScanFilterText } from '../../lib/useScanFilter';
import { lineSpecLabel } from '../../lib/lineGroups';
import { linePhotos } from '../../lib/linePhotos';
import { lineRequirements, missingFieldNames } from '../../lib/lineRequirements';
import { paymentGap, reviewApproveTotal } from '../../lib/paymentGap';
import { costReimbursedToOwner, poStageName } from '../../lib/orderPresentation';
import { lineShippedOn } from '../../lib/poPermissions';
import { rateEq } from '../../lib/poTotals';
import { precheckMessageKey, precheckPriceFile } from '../../lib/priceFilePrecheck';
import {
  lineMargin, parsePriceInput, planSheet, reviewMoney, suggestedSell,
  type SellSuggestion, type SheetCell, type SheetPreview, type SheetRowPlan, type SheetSkip,
} from '../../lib/reviewPricing';
import { staleness } from '../../lib/marketStaleness';
import { statusTone } from '../../lib/status';
import { useMarketLookup } from '../../lib/useMarketLookup';
import type { Order, OrderLine } from '../../lib/types';
import { AiReviewCard } from './AiReviewCard';
import { LabelPrinterBar, useLabelPrint, type LabelText } from './LabelPrint';
import { LineDrawer } from './submit/LineDrawer';
import { editLineToPatch, orderLineToEditLine, type EditLine } from './submit/editLine';
import { brandConfirmPending, patchEditsLine } from './submit/line';

// Review mode: the manager's bench view of one PO. Each line starts at its
// full qty and is ticked when found (lowered first when short); a ticked line
// sinks to the bottom so what is left to find stays on top. A line that
// arrived different from what the PO says is fixed in place with Edit.
// Progress lives on the server, so a reload or a second manager picks up
// where the count stands. The same bench prices the PO: each line's sell
// price, the projection the commission is paid on, is typed beside its
// count, with the Market board's value offered where nobody has priced it,
// or read off a sell order sheet dropped on the list. Approving the review
// prints the box's label: the PO, its counts and its purchaser.

const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Props = {
  order: Order;
  onExit: () => void;
  onApproved: () => void;
  // Re-reads the order after a line edit; the page remounts on the fresh copy.
  onReload: () => Promise<void>;
  showToast: (msg: string, kind?: 'success' | 'error' | 'warn') => void;
};

type Undo =
  | { kind: 'check'; lineId: string; prev: LineCheck; msg: string }
  // The prices a sheet replaced, put back one write each.
  | { kind: 'prices'; prev: { lineId: string; price: number | null; applied: number }[]; msg: string };
// A sell order sheet read but not applied: its matches stand on the rows
// until Apply or Cancel.
type Sheet = { file: File; currency: Currency; data: SheetPreview };
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
  // Prices saved from this page stand over the order's copy until the next
  // reload, and the rate the same way.
  const [prices, setPrices] = useState<Map<string, number | null>>(new Map());
  const [rate, setRate] = useState<number | null>(order.commissionRate);
  const [filling, setFilling] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  // Rows whose typed price stands against the sheet's.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  // Where a price applied from a sheet came from, until the next reload.
  const [sources, setSources] = useState<Map<string, { file: string; cell: SheetCell }>>(new Map());
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child the file passes over.
  const dragDepth = useRef(0);
  const sheetInput = useRef<HTMLInputElement | null>(null);
  const priceRefs = useRef(new Map<string, HTMLInputElement>());
  const partNumbers = useMemo(() => lines.map(l => l.partNumber), [lines]);
  const market = useMarketLookup(partNumbers);

  const scanRef = useRef<HTMLInputElement | null>(null);
  // Set when a scanner's first character landed on the page and was moved into
  // the scan box; the box gives focus back once the scan is in.
  const scanFromPage = useRef(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lineById = useMemo(() => new Map(lines.map(l => [l.id, l])), [lines]);
  const ai = useAiReview(order.id);
  const aiIssues = useMemo(() => openIssuesByLine(ai.data?.findings ?? []), [ai.data]);
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
  // A qty the Edit drawer just saved, read before the reload brings it: the
  // count reset it sends is clamped to the line's qty.
  const editedQty = useRef(new Map<string, number>());
  const bodyOf = (c: LineCheck) => checkBody(
    c, editedQty.current.get(c.lineId) ?? lineByIdRef.current.get(c.lineId)?.qty ?? c.counted);
  const { checks, loadState, reload, save, flush } = useLineSaveQueue<ChecksResponse>({
    read: () => api.get<ChecksResponse>(`/api/orders/${order.id}/checks`),
    send: c => api.put<ChecksResponse>(url(c.lineId), bodyOf(c)),
    beacon: c => { void rawFetch('PUT', url(c.lineId), bodyOf(c), undefined, { keepalive: true }).catch(() => {}); },
    checksOf: r => r.lines,
  });
  const ready = loadState === 'ok' && !readOnly;

  const label = useLabelPrint('review.labelAuto', name => showToast(t('pkLabelPrinted', { id: name })));
  // The box's label, counted as the review stands: a line at 0 isn't in it.
  const labelText = (): LabelText => {
    const n = reviewedCounts(lines, checks);
    return {
      name: order.id,
      top: [t('bcLabelKind'), order.warehouse?.short].filter(Boolean).join(' · '),
      date: fmtDate(new Date(), locale),
      title: order.id,
      caption: t('pkLabelPurchaser', { n: 1 }),
      body: order.userName,
      mono: false,
      counts: [
        { n: n.products, word: t('pkLabelProducts', { n: n.products }) },
        { n: n.units, word: t('pkLabelUnits', { n: n.units }) },
      ],
    };
  };

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
    // A held line's count is locked for the keys as well as the stepper.
    if (!ready || lineShippedOn(l).length) return;
    const prev = checkOf(l.id);
    const counted = Math.max(0, Math.min(l.qty, n));
    if (counted === prev.counted) return;
    save({ ...prev, counted, checkedAt: counted < l.qty ? null : prev.checkedAt });
  };

  const check = (l: OrderLine) => {
    const prev = checkOf(l.id);
    const next: LineCheck = { ...prev, checkedAt: new Date().toISOString() };
    save(next);
    flashUndo({ kind: 'check', lineId: l.id, prev, msg: t('bcCheckedToast', { pn: l.partNumber ?? lineLabel(l), n: countOf(l, prev), of: l.qty }) });
    setSelectedId(nextOpenAfter(lines, new Map(checks).set(l.id, next), l.id)?.id ?? l.id);
  };

  const toggle = (l: OrderLine) => {
    if (!ready) return;
    const c = checkOf(l.id);
    if (lineState(l, c) === 'done') {
      save({ ...c, checkedAt: null });
      flashUndo({ kind: 'check', lineId: l.id, prev: c, msg: t('bcUncheckedToast', { pn: l.partNumber ?? lineLabel(l) }) });
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
    if (Number(l.qty) !== Number(o.qty)) {
      editedQty.current.set(id, Number(l.qty));
      save(emptyCheck(id, Number(l.qty)));
    }
    await flush();
    showToast(t('bcLineSaved', { n }), 'success');
    await onReload();
  };

  const applyUndo = () => {
    if (!undo || !ready) return;
    // Not over another batch of price writes; the toast stays for a retry.
    if (undo.kind === 'prices' && (sheetBusy || filling)) return;
    setUndo(null);
    if (undo.kind === 'prices') {
      void (async () => {
        setSheetBusy(true);
        try {
          for (const p of undo.prev) {
            const l = lineById.get(p.lineId);
            // A price typed since the sheet's went in is the newer word.
            const now = l ? priceOf(l) : null;
            if (!l || now == null || Math.round(now * 100) !== Math.round(p.applied * 100)) continue;
            if (await savePrice(l, p.price)) {
              setSources(m => {
                const next = new Map(m);
                next.delete(p.lineId);
                return next;
              });
            }
          }
        } finally {
          setSheetBusy(false);
        }
      })();
      return;
    }
    save(undo.prev);
    setSelectedId(undo.lineId);
  };

  // ── Pricing: the sell price the commission is paid on, typed beside the
  // count. Each price goes straight to the line — the road the PO page takes
  // at Ready to Pay — so a reload reads it back. The row shows it at once and
  // puts the old one back if the server refuses.
  const priceOf = (l: OrderLine): number | null => (prices.has(l.id) ? prices.get(l.id)! : l.sellPrice);
  const suggestionFor = (l: OrderLine): SellSuggestion | null => suggestedSell(market(l.partNumber));
  const savePrice = async (l: OrderLine, value: number | null): Promise<boolean> => {
    if (!ready) return false;
    const next = value != null && value > 0 ? value : null;
    const before = priceOf(l);
    if ((before ?? null) === next) return true;
    setPrices(m => new Map(m).set(l.id, next));
    try {
      const r = await api.patch<{ ok: true; warnings?: string[] }>(`/api/inventory/${l.id}`, { sellPrice: next });
      if (r.warnings?.includes('sub_cost_sell')) showToast(t('bcPriceBelowCost', { n: lineNo(l) }), 'warn');
      return true;
    } catch (e) {
      setPrices(m => new Map(m).set(l.id, before));
      handleFetchError(e);
      return false;
    }
  };
  // Every unpriced line the market has a value for, one write each, so one
  // refusal leaves the rest priced.
  const fillFromMarket = async () => {
    if (!ready || filling) return;
    const targets = lines
      .filter(l => !isPricedSellPrice(priceOf(l)))
      .map(l => ({ l, s: suggestionFor(l) }))
      .filter((x): x is { l: OrderLine; s: SellSuggestion } => x.s !== null);
    if (!targets.length) { showToast(t('bcFillMarketNone'), 'warn'); return; }
    setFilling(true);
    let n = 0;
    try {
      for (const { l, s } of targets) if (await savePrice(l, s.value)) n += 1;
    } finally {
      setFilling(false);
    }
    showToast(t('bcFilledFromMarket', { n }), 'success');
  };

  // ── A sell order sheet: the server matches it to the lines by part number
  // and writes nothing; Apply writes each price the way a typed one goes.
  // A currency switch sends the same file again, since which rows convert
  // turns on each row's own currency mark, and only the server reads those.
  const readSheet = async (file: File, currency: Currency, fresh: boolean) => {
    if (!ready || sheetBusy) return;
    setSheetBusy(true);
    try {
      const check = fresh ? await precheckPriceFile(file) : null;
      if (check && !check.ok) {
        showErrorDialog(t(precheckMessageKey(check)));
        return;
      }
      const form = new FormData();
      form.append('file', file);
      form.append('currency', currency);
      const data = await api.upload<SheetPreview>(`/api/orders/${order.id}/price-sheet/preview`, form);
      setSheet({ file, currency, data });
      if (fresh) setKept(new Set());
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: string } | undefined)?.code : undefined;
      if (code === 'columns-not-found') showErrorDialog(t('soPriceImportColumnsNotFound'));
      else handleFetchError(e);
    } finally {
      setSheetBusy(false);
    }
  };
  const onSheetFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void readSheet(file, sheet?.currency ?? 'USD', true);
  };
  const closeSheet = () => {
    setSheet(null);
    setKept(new Set());
  };
  const plan = sheet ? planSheet(lines.map(l => ({ id: l.id, sellPrice: priceOf(l) })), sheet.data, kept) : null;
  const toggleKeep = (lineId: string) => setKept(s => {
    const next = new Set(s);
    if (!next.delete(lineId)) next.add(lineId);
    return next;
  });
  // A price typed over the sheet's on a row is the manager's: it is saved and
  // held against the sheet, as Keep holds one. A blank leaves the line unpriced.
  const typeOverSheet = (l: OrderLine, v: number | null, sheetPrice: number) => {
    if (v !== null && Math.round(v * 100) === Math.round(sheetPrice * 100)) return;
    setKept(s => new Set(s).add(l.id));
    void savePrice(l, v).then(ok => {
      if (!ok) setKept(s => { const next = new Set(s); next.delete(l.id); return next; });
    });
  };
  // One write each, as Fill from market does, so one refusal leaves the rest
  // priced and Undo knows exactly which prices to put back.
  const applySheet = async () => {
    if (!ready || !sheet || !plan || sheetBusy || plan.writes.length === 0) return;
    setSheetBusy(true);
    const prev: { lineId: string; price: number | null; applied: number }[] = [];
    let repriced = 0;
    try {
      for (const w of plan.writes) {
        const l = lineById.get(w.lineId);
        if (!l) continue;
        const was = priceOf(l);
        if (await savePrice(l, w.price)) {
          prev.push({ lineId: l.id, price: was, applied: w.price });
          if (isPricedSellPrice(was)) repriced += 1;
        }
      }
    } finally {
      setSheetBusy(false);
    }
    setSources(m => {
      const next = new Map(m);
      for (const p of prev) {
        const row = plan.rows.get(p.lineId);
        if (row && 'cell' in row) next.set(p.lineId, { file: sheet.file.name, cell: row.cell });
      }
      return next;
    });
    closeSheet();
    if (prev.length) {
      flashUndo({
        kind: 'prices', prev,
        msg: repriced
          ? t('bcSheetAppliedRepriced', { n: prev.length, m: repriced })
          : t('bcSheetApplied', { n: prev.length }),
      });
    }
  };
  // What a sheet row says, in the currency it says it in.
  const sheetFigure = (c: SheetCell) => (c.listedPrice != null ? fmtMoney(c.listedPrice, 'CNY', locale) : fmtUSD(c.price, locale));
  const skipReason = (m: SheetSkip): string => {
    switch (m.status) {
      case 'no-part': return t('bcSheetNoPart');
      case 'no-price': return t('bcSheetNoPrice', { row: m.cell.rowNumber });
      case 'invalid-price': return t('bcSheetInvalid', { row: m.cell.rowNumber, raw: m.cell.rawPrice });
      case 'other-currency': return t('bcSheetOtherCurrency', { row: m.cell.rowNumber, currency: m.cell.currency });
      case 'conflict': return t('bcSheetConflict', { n: m.cells.length, prices: m.cells.map(sheetFigure).join(' / ') });
    }
  };
  const hasFiles = (e: { dataTransfer: DataTransfer }) => Array.from(e.dataTransfer.types).includes('Files');
  // The rate is the PO's: a manager's until the book closes at Ready to Pay,
  // where the server refuses it.
  const rateLocked = order.lifecycle === 'ready_to_pay' || order.lifecycle === 'done';
  const saveRate = async (v: number | null) => {
    if (!ready || rateLocked || rateEq(v ?? 0, rate ?? 0)) return;
    const before = rate;
    setRate(v);
    try {
      await api.patch(`/api/orders/${order.id}`, { commissionRate: v });
    } catch (e) {
      setRate(before);
      handleFetchError(e);
    }
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
  // A label that starts outside the box is moved into it, and the box gives
  // focus back once the scan is in.
  const startScan = (text: string) => {
    scanFromPage.current = true;
    setScan(text);
    scanRef.current?.focus();
  };

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
      // A count the server never stored would be zeroed or approved as if it
      // had been.
      if (!(await flush())) {
        showErrorDialog(t('bcCountsUnsaved'));
        return;
      }
      // Ahead of the move: from Ready to Pay the lines are closed book. Set to
      // 0 rather than removed, so every line keeps its # on the PO. Refused
      // unless the PO is still at Reviewing, like the move after it.
      if (toZero.length) {
        await api.patch(`/api/orders/${order.id}`, {
          expectStage: 'reviewing', lines: toZero.map(l => ({ id: l.id, qty: 0 })),
        });
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
    // Finishing the review prints the box's label, before the page leaves.
    if (label.auto) await label.print([labelText()]);
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
  // leaves its filter up with the box blurred, and a sheet waiting to be
  // applied goes before the page too.
  useEscapeKey(() => {
    if (editing) setEditing(null);
    else if (scan) setScan('');
    else if (sheet) { if (!sheetBusy) closeSheet(); }
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
        case 'p': e.preventDefault(); if (selectedShown && ready) priceRefs.current.get(selectedShown.id)?.focus(); break;
        case '/': e.preventDefault(); scanRef.current?.focus(); break;
        default:
          // A scanner types into whatever has focus. Its first character
          // starts the scan in the box; the rest then follows it there, so
          // the label never runs as shortcuts.
          if (ready && e.key.length === 1 && e.key.trim()) {
            e.preventDefault();
            startScan(e.key);
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
  // The Finish card lists what Approve zeroes apart from the absent lines it leaves.
  const zeroing = atReviewing && toZero.length > 0;
  const absentKept = zeroing ? absent.filter(l => !toZero.includes(l)) : absent;
  // Against the total the PO will have once Approve has zeroed those lines,
  // so a line counted 0 can open a gap, or close one, before the click.
  const gap = paymentGap(order.linkedPaid, reviewApproveTotal(order, atReviewing ? toZero : []), order.payment);
  // Nothing on this PO arrived: there is nothing to pay for.
  const allAbsent = absent.length === lines.length;
  // The product's # on the PO, which regrouping the rows doesn't touch. An
  // older backend sends none; its lines came in # order.
  const lineNo = (l: OrderLine) => l.no ?? lines.indexOf(l) + 1;
  const absentList = (ls: OrderLine[]) => (
    <ul className="bc-problem-list">
      {ls.map(l => (
        <li key={l.id}>
          <span className="mono">#{lineNo(l)} {l.partNumber ?? lineLabel(l)}</span>
          {' · '}{t('bcShortNote', { n: 0, of: l.qty })}
        </li>
      ))}
    </ul>
  );

  // The commission as Approve will leave it: a line set to 0 brings no
  // revenue and, when the goods total follows the lines, no cost — the rule
  // the payment gap above reads by.
  const selfReimbursed = costReimbursedToOwner(order.payment, order.paidBy?.id, order.userId);
  const moneyAt = (sellPrice: (l: OrderLine) => number | null) => reviewMoney({
    lines: lines.map(l => ({ id: l.id, qty: l.qty, unitCost: l.unitCost, sellPrice: sellPrice(l) })),
    totalCost: order.totalCost, goodsFollowsLines: order.goodsFollowsLines, otherFees: order.otherFees,
    commissionRate: rate, selfReimbursed,
    zeroed: new Set(atReviewing ? toZero.map(l => l.id) : []),
  });
  const money = moneyAt(priceOf);
  // The same figures with the sheet applied, shown beside them before the click.
  const sheetPrices = new Map(plan?.writes.map(w => [w.lineId, w.price]) ?? []);
  const projected = sheetPrices.size ? moneyAt(l => sheetPrices.get(l.id) ?? priceOf(l)) : null;
  const shown = projected ?? money;
  const unpriced = lines.filter(l => !isPricedSellPrice(priceOf(l)));
  const fillable = unpriced.filter(l => suggestionFor(l) !== null).length;
  const earnsClass = 'mono' + (money.earns < 0 ? ' neg' : '');
  const shownEarnsClass = 'mono' + (shown.earns < 0 ? ' neg' : '');

  // The line PATCH any edit on this page sends, then the answer recorded; the
  // reload remounts the page on the edited line. The findings are read again
  // first: one loaded before somebody else edited the line no longer
  // describes it, and applying it would write over that edit.
  const applyFinding = async (f: AiFinding) => {
    const l = lineById.get(f.lineId!);
    if (!l) return;
    const now = (await ai.reload()).findings;
    const fresh = now.find(x => x.id === f.id);
    if (!fresh || !canApply(fresh)) {
      showToast(t('aiRevChangedToast'), 'warn');
      return;
    }
    const patch = applyPatch(fresh, { ...l, category: l.category });
    await api.patch(`/api/orders/${order.id}`, { lines: [patch], expectStage: order.lifecycle });
    await ai.resolve(fresh.id, 'applied');
    // A Form fix that brought its Device along answers that finding too.
    for (const o of settledBy(patch, fresh, now)) await ai.resolve(o.id, 'applied');
    // Ticks still waiting go out before the remount reads them back, as for
    // a drawer edit.
    await flush();
    showToast(t('aiRevAppliedToast', { n: lineNo(l) }), 'success');
    await onReload();
  };

  const row = (l: OrderLine) => {
    const c = checkOf(l.id);
    const state = lineState(l, c);
    const shots = linePhotos(l);
    const isSel = selected?.id === l.id;
    const pn = l.partNumber ?? lineLabel(l);
    const shippedOn = lineShippedOn(l);
    const held = shippedOn.length > 0;
    const price = priceOf(l);
    const sug = suggestionFor(l);
    const margin = lineMargin(price, l.unitCost);
    const sp = plan?.rows.get(l.id);
    const incoming = sp?.kind === 'in' || sp?.kind === 'diff' ? sp : null;
    return (
      <Fragment key={l.id}>
        <tr
          id={'bc-row-' + l.id}
          ref={el => { if (el) rowRefs.current.set(l.id, el); else rowRefs.current.delete(l.id); }}
          className={'bc-row bc-' + state + (isAbsentChecked(l, c) ? ' bc-done-absent' : '') + (isSel ? ' row-selected' : '')
            + (sp?.kind === 'off' || sp?.kind === 'skip' ? ' bc-sheet-off' : '')}
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
            {aiIssues.has(l.id) && (
              <span className="chip warn" title={t('aiRevLineChipTip', { n: aiIssues.get(l.id)! })}>
                <Icon name="sparkles" size={10} /> {t('aiRevLineChip', { n: aiIssues.get(l.id)! })}
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
                <b>
                  <CountField
                    value={countOf(l, c)}
                    max={l.qty}
                    disabled={!ready || held || l.qty === 0}
                    label={t('bcCountInput', { pn })}
                    onFocus={() => setSelectedId(l.id)}
                    onCommit={n => setCount(l, n)}
                    onScanKey={startScan}
                  />
                </b><span className="muted"> / {l.qty}</span>
              </span>
              <button type="button" className="btn ghost icon-only sm" aria-label={t('bcCountMore')}
                disabled={!ready || held || countOf(l, c) >= l.qty} onClick={() => { setSelectedId(l.id); setCount(l, countOf(l, c) + 1); }}>
                <Icon name="plus" size={13} />
              </button>
            </div>
            {countOf(l, c) === 0 && <div className="bc-absent-tag">{t('bcAbsentTag')}</div>}
          </td>
          <td className="num bc-price-cell" onClick={e => e.stopPropagation()}>
            <span className="bc-price">
              {sp?.kind === 'diff' && <span className="bc-price-was mono">{fmtUSD(sp.was, locale)}</span>}
              <span className="bc-price-sign">$</span>
              {incoming ? (
                // The sheet's figure, not written yet: Apply writes it, and a
                // price typed over it is the manager's own.
                <PriceField
                  inputRef={el => { if (el) priceRefs.current.set(l.id, el); else priceRefs.current.delete(l.id); }}
                  value={incoming.price}
                  suggestion={null}
                  incoming
                  disabled={!ready || sheetBusy}
                  label={t('bcPriceInput', { pn })}
                  onFocus={() => setSelectedId(l.id)}
                  onCommit={v => typeOverSheet(l, v, incoming.price)}
                  onScanKey={startScan}
                />
              ) : (
                <PriceField
                  inputRef={el => { if (el) priceRefs.current.set(l.id, el); else priceRefs.current.delete(l.id); }}
                  value={price}
                  suggestion={sug?.value ?? null}
                  disabled={!ready}
                  label={t('bcPriceInput', { pn })}
                  onFocus={() => setSelectedId(l.id)}
                  onCommit={v => { void savePrice(l, v); }}
                  onScanKey={startScan}
                />
              )}
            </span>
            {sp && sp.kind !== 'off' ? (
              <SheetNote
                plan={sp}
                figure={sheetFigure}
                reason={skipReason}
                disabled={!ready || sheetBusy}
                onKeep={() => toggleKeep(l.id)}
              />
            ) : sp?.kind === 'off' ? (
              <>
                <div className="bc-price-sub">{t('bcSheetNotIn')}</div>
                {!isPricedSellPrice(price) && sug && (
                  <button type="button" className="bc-price-use" disabled={!ready} onClick={() => { void savePrice(l, sug.value); }}>
                    {t('bcPriceUse', { price: fmtUSD(sug.value, locale) })}
                  </button>
                )}
              </>
            ) : margin !== null ? (
              <div className={'bc-price-sub' + (margin < 0 ? ' neg' : '')}>
                {margin < 0 ? t('bcBelowCost') : t('bcMargin', { pct: Math.round(margin * 100) })}
              </div>
            ) : sug ? (
              <button type="button" className="bc-price-use" disabled={!ready} onClick={() => { void savePrice(l, sug.value); }}>
                {t('bcPriceUse', { price: fmtUSD(sug.value, locale) })}
              </button>
            ) : null}
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
  const selPrice = selected ? priceOf(selected) : null;
  const selMarket = selected ? market(selected.partNumber) : null;
  const selSug = suggestedSell(selMarket);
  const selAge = selMarket ? staleness(selMarket.lastPriceAt) : null;
  const selPlan = selected ? plan?.rows.get(selected.id) : undefined;
  const selSource = selected ? sources.get(selected.id) : undefined;
  const shot = selShots[Math.min(photoIdx, selShots.length - 1)];
  const boxCount = reviewedCounts(lines, checks);

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
        <div className="pk-head-side">
          <LabelPrinterBar
            printer={label.printer}
            settings={label.settings}
            autoTitle={t('bcLabelAuto')}
            autoHint={t('bcLabelAutoHint')}
            summary={[order.id, t('pkSub', { products: boxCount.products, units: boxCount.units }), order.userName].join(' · ')}
            canPrint={loadState === 'ok' && boxCount.products > 0}
            onPrint={() => void label.print([labelText()])}
            onPrintDialog={() => void label.viaDialog([labelText()])}
          />
          <div className="bc-keys" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> {t('bcKeyMove')}</span>
            <span><kbd>{t('bcKeySpace')}</kbd> {t('bcKeyCheck')}</span>
            <span><kbd>+</kbd><kbd>−</kbd> {t('bcKeyCount')}</span>
            <span><kbd>E</kbd> {t('bcKeyEdit')}</span>
            <span><kbd>P</kbd> {t('bcKeyPrice')}</span>
            <span><kbd>/</kbd> {t('bcKeyScan')}</span>
          </div>
        </div>
      </div>

      {readOnly && (
        <div className="oe-banner bc-banner"><Icon name="lock" size={13} /> {t('bcArchived')}</div>
      )}
      {gap && <PaymentMismatchBanner orderId={order.id} gap={gap} className="bc-banner" />}

      <div className="card bc-tally">
        <div className="bc-tally-half">
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
        <div className="bc-tally-half bc-tally-money">
          <div className="bc-tally-num">
            <span className="mono"><b>{money.priced}</b><span className="muted"> / {money.total}</span></span>
            <span className="card-sub">{t('bcPricedCount', { n: money.priced, of: money.total })}</span>
            {plan && plan.incoming > 0 && <span className="card-sub bc-incoming">{t('bcSheetMore', { n: plan.incoming })}</span>}
          </div>
          <div className="bc-tally-meter">
            <div className="bc-meter" role="img" aria-label={t('bcPricedCount', { n: money.priced, of: money.total })}>
              <i className="bc-m-priced" style={{ flexGrow: money.priced }} />
              <i className="bc-m-incoming" style={{ flexGrow: plan?.incoming ?? 0 }} />
              <i className="bc-m-open" style={{ flexGrow: money.total - money.priced - (plan?.incoming ?? 0) }} />
            </div>
            <div className="bc-earns">
              <span className="bc-earns-k">{t('eoPurchaserEarns')}</span>
              <b className={earnsClass}>{fmtUSD(money.earns, locale)}</b>
              {projected && (
                <>
                  <span className="bc-earns-arrow" aria-hidden="true">→</span>
                  <b className={'bc-earns-next ' + shownEarnsClass} title={t('bcSheetProjected', { n: plan!.writes.length })}>
                    {fmtUSD(projected.earns, locale)}
                  </b>
                </>
              )}
              <span className="muted">{+(money.rate * 100).toFixed(2)}%</span>
            </div>
          </div>
          <div className="bc-tally-actions">
            <button
              type="button"
              className="btn"
              disabled={!ready || filling || fillable === 0 || sheet !== null || sheetBusy}
              title={t('bcFillMarketTip')}
              onClick={() => { void fillFromMarket(); }}
            >
              <Icon name="tag" size={13} /> {filling ? '…' : t('bcFillMarket')}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!ready || filling || sheet !== null || sheetBusy}
              title={t('bcSheetFromTip')}
              onClick={() => sheetInput.current?.click()}
            >
              <Icon name="upload" size={13} /> {sheetBusy && !sheet ? '…' : t('bcSheetFrom')}
            </button>
            <input
              ref={sheetInput}
              type="file"
              accept={XLSX_ACCEPT}
              hidden
              onChange={e => { onSheetFiles(e.target.files); e.target.value = ''; }}
            />
          </div>
        </div>
      </div>

      <div className="bc-grid">
        {/* The whole list is the drop target for a sell order sheet. The
            dropzone handles a drop on itself; one beside it lands here. */}
        <div
          className="card bc-list-card"
          onDragEnter={e => {
            // A sheet waiting to be applied is replaced only through Cancel.
            if (!ready || sheetBusy || sheet || !hasFiles(e)) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={e => {
            if (!hasFiles(e)) return;
            // A file the list won't take must not fall through to the
            // browser, which would open it in place of the page.
            e.preventDefault();
            if (!dragging) e.dataTransfer.dropEffect = 'none';
          }}
          onDragLeave={() => {
            if (!dragging) return;
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); }
          }}
          onDrop={e => {
            if (!dragging) {
              if (hasFiles(e)) e.preventDefault();
              return;
            }
            dragDepth.current = 0;
            setDragging(false);
            if (e.isDefaultPrevented()) return;
            e.preventDefault();
            onSheetFiles(e.dataTransfer.files);
          }}
        >
          {dragging && (
            <div className="bc-drop-veil">
              <AttachmentDropzone
                onFiles={onSheetFiles}
                multiple={false}
                accept={XLSX_ACCEPT}
                boxHint={t('bcSheetDropHint')}
              />
            </div>
          )}
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
            {/* A sheet waiting to be applied takes the hint's place; a scan's
                own message still shows above it. */}
            {(!sheet || scanMsg) && (
              <div className={'bc-scan-msg ' + (scanMsg?.tone ?? 'muted')} aria-live="polite">
                {scanMsg ? scanMsg.text : t('bcScanHint')}
              </div>
            )}
            {sheet && plan && (
              <div className="bc-sheet-strip" role="region" aria-label={t('bcSheetRegion')}>
                <span className="bc-sheet-file" title={sheet.file.name}>
                  <Icon name="file" size={13} /><span className="mono">{sheet.file.name}</span>
                </span>
                <span role="group" aria-label={t('bcSheetCurrency')}>
                  <CurrencyPicker
                    value={sheet.currency}
                    onChange={cur => { if (cur !== sheet.currency) void readSheet(sheet.file, cur, false); }}
                    t={t}
                    disabled={!ready || sheetBusy}
                  />
                </span>
                {sheet.data.fx && sheet.data.lines.some(m => m.status === 'matched' && m.cell.listedPrice != null) && (
                  <span className="bc-sheet-fx mono">
                    {t('soFxRateNote', { rate: sheet.data.fx.oneUsdInQuote.toFixed(4), currency: 'CNY', source: sheet.data.fx.source })}
                  </span>
                )}
                <span className="bc-sheet-counts">
                  <b>{t('bcSheetToApply', { n: plan.writes.length })}</b>
                  {plan.repriced > 0 && <><span className="sep">·</span>{t('bcSheetRepriced', { n: plan.repriced })}</>}
                  {plan.unchanged > 0 && <><span className="sep">·</span>{t('bcSheetUnchanged', { n: plan.unchanged })}</>}
                  {plan.kept > 0 && <><span className="sep">·</span>{t('bcSheetKeptCount', { n: plan.kept })}</>}
                  {plan.notInSheet + plan.unmatched + plan.notOnPo > 0 && (
                    <>
                      <span className="sep">·</span>
                      <span
                        className="bc-sheet-skipped"
                        title={t('bcSheetSkippedTip', { a: plan.notInSheet, b: plan.unmatched, c: plan.notOnPo })}
                      >
                        {t('bcSheetSkipped', { n: plan.notInSheet + plan.unmatched + plan.notOnPo })}
                      </span>
                    </>
                  )}
                </span>
                <span className="bc-sheet-actions">
                  <button type="button" className="btn sm" disabled={sheetBusy} onClick={closeSheet}>{t('cancel')}</button>
                  <button
                    type="button"
                    className="btn sm accent"
                    disabled={!ready || sheetBusy || plan.writes.length === 0}
                    onClick={() => { void applySheet(); }}
                  >
                    <Icon name="check" size={12} /> {sheetBusy ? '…' : t('bcSheetApply', { n: plan.writes.length })}
                  </button>
                </span>
              </div>
            )}
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
                  <th className="num bc-price-cell">{t('sellUnit')}</th>
                  <th className="bc-edit-cell" aria-label={t('bcEditTip')} />
                </tr>
              </thead>
              <tbody>
                {listed.open.map(row)}
                {fit?.size === 0 && (
                  <tr className="bc-group-empty"><td colSpan={8}>{t('bcFilterNone', { pn: filterText, id: order.id })}</td></tr>
                )}
                {!fit && remaining === 0 && (
                  <tr className="bc-group-empty"><td colSpan={8}>{t('bcAllResolved')}</td></tr>
                )}
                {listed.done.length > 0 && (
                  <tr className="bc-group">
                    <td colSpan={8}>
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
                  <dt>{t('sellUnit')}</dt>
                  <dd className="mono">
                    {selPlan?.kind === 'in' || selPlan?.kind === 'diff' ? (
                      <>
                        {selPlan.kind === 'diff' && <span className="bc-price-was">{fmtUSD(selPlan.was, locale)}</span>}
                        <span className="bc-incoming">{fmtUSD(selPlan.price, locale)}</span>
                      </>
                    ) : isPricedSellPrice(selPrice) ? fmtUSD(selPrice!, locale) : '—'}
                  </dd>
                  {selPlan && 'cell' in selPlan && (
                    <>
                      <dt>{t('bcSheetCol')}</dt>
                      <dd className="mono muted" title={selPlan.cell.sheet}>
                        {sheetFigure(selPlan.cell)} · {t('bcSheetRow', { row: selPlan.cell.rowNumber })}
                      </dd>
                    </>
                  )}
                  {!selPlan && selSource && (
                    <>
                      <dt>{t('bcSheetPricedFrom')}</dt>
                      <dd className="mono muted bc-source">{selSource.file} · {sheetFigure(selSource.cell)}</dd>
                    </>
                  )}
                  {selected.finalSellPrice != null && (
                    <>
                      <dt>{t('finalSellPrice')}</dt>
                      <dd className="mono">
                        {fmtUSD(selected.finalSellPrice, locale)}
                        {selected.finalSoldQty != null && <span className="muted"> · {t('bcFinalSold', { n: selected.finalSoldQty })}</span>}
                      </dd>
                    </>
                  )}
                  {selected.chipNumber && (<><dt>{t('bcChip')}</dt><dd className="mono">{selected.chipNumber}</dd></>)}
                </dl>
                <div className="bc-compare-market">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span className="card-sub">{t('bcMarketRef')}</span>
                    {selSug ? <span className="mono">{fmtUSD(selSug.value, locale)}</span> : <span className="muted">{t('bcMarketNone')}</span>}
                  </div>
                  {selSug && selAge && (
                    <div className="muted">
                      {t(selSug.basis === 'last' ? 'bcMarketBasisLast' : selSug.basis === 'avg' ? 'bcMarketBasisAvg' : 'bcMarketBasisInternal')}
                      {' · '}{selAge.days == null ? t('mktNeverPriced') : t('mktRecordedDaysAgo', { n: selAge.days })}
                    </div>
                  )}
                  {selMarket && selSug?.basis !== 'internal' && selMarket.internalSales.samples > 0 && selMarket.internalSales.avgPrice != null && (
                    <div className="muted">{t('mktInternal', { price: fmtUSD(selMarket.internalSales.avgPrice, locale), n: selMarket.internalSales.samples })}</div>
                  )}
                </div>
                <div className="bc-serials">
                  <div className="card-sub">{selSerials.length ? t('bcSerialsOnFile', { n: selSerials.length }) : t('bcNoSerials')}</div>
                  {selSerials.length > 0 && (
                    <div className="bc-serial-list">{selSerials.map(s => <span key={s} className="mono">{s}</span>)}</div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="card bc-money">
            <div className="card-head">
              <span className="card-title">{t('bcMoneyTitle')}</span>
              <span className="card-sub">{t('bcMoneyPriced', { n: money.priced, of: money.total })}</span>
            </div>
            <div className="card-body">
              {projected && <p className="bc-money-hint bc-money-projected">{t('bcSheetProjected', { n: plan!.writes.length })}</p>}
              <div className="bc-money-earn">
                <span>{t('eoPurchaserEarns')}</span>
                <b className={shownEarnsClass}>{fmtUSD(shown.earns, locale)}</b>
              </div>
              <p className="bc-money-hint">{t('bcMoneyEarnsHint', { name: order.userName })}</p>
              <div className="bc-money-rate">
                <label htmlFor="bc-rate">{t('commissionRate')}</label>
                <span className="bc-rate">
                  <RateField id="bc-rate" value={rate} disabled={!ready || rateLocked} onCommit={v => { void saveRate(v); }} />
                </span>
              </div>
              {rateLocked && !readOnly && <p className="bc-money-hint">{t('bcMoneyRateLocked')}</p>}
              <dl className="bc-kv">
                <dt>{t('revenue')}</dt><dd className="mono">{fmtUSD(shown.revenue, locale)}</dd>
                <dt>{t('eoCost')}</dt><dd className="mono">{fmtUSD(shown.cost, locale)}</dd>
                {shown.fees > 0 && (
                  <>
                    <dt className="bc-kv-sub">{t('otherFees')}{order.otherFeesNote?.trim() ? ` · ${order.otherFeesNote.trim()}` : ''}</dt>
                    <dd className="mono bc-kv-sub">{fmtUSD(shown.fees, locale)}</dd>
                  </>
                )}
                <dt>{t('eoProfitAllLines', { n: lines.length })}</dt>
                <dd className={'mono' + (shown.profit < 0 ? ' neg' : '')}>{fmtUSD(shown.profit, locale)}</dd>
                <dt>{t('eoRate')}</dt><dd className="mono">{(shown.rate * 100).toFixed(2)}%</dd>
                <dt>{t('eoCommissionOnProfit')}</dt><dd className="mono">{fmtUSD(shown.commission, locale)}</dd>
                {selfReimbursed && (<><dt>{t('eoSelfPay')}</dt><dd className="mono">{fmtUSD(shown.cost, locale)}</dd></>)}
                <dt className="bc-kv-total">{t('eoTotal')}</dt>
                <dd className={'bc-kv-total ' + shownEarnsClass}>{fmtUSD(shown.earns, locale)}</dd>
              </dl>
              {shown.lotPrice && <p className="bc-money-hint">{t('bcMoneyLotPrice')}</p>}
              {shown.total > shown.priced && <p className="bc-money-hint">{t('eoUnpricedLinesHint', { n: shown.total - shown.priced })}</p>}
            </div>
          </div>

          <AiReviewCard
            data={ai.data}
            selectedId={selected?.id ?? null}
            lineNo={id => { const l = lineById.get(id); return l ? lineNo(l) : null; }}
            onSelect={setSelectedId}
            onRun={async () => { await ai.run(); showToast(t('aiRevQueuedToast'), 'success'); }}
            onApply={applyFinding}
            onResolve={ai.resolve}
            isHeld={id => { const l = lineById.get(id); return !!l && lineShippedOn(l).length > 0; }}
            ready={ready}
          />

          <div className="card bc-finish">
            <div className="card-head"><span className="card-title">{t('bcFinishTitle')}</span></div>
            <div className="card-body">
              {remaining > 0 ? (
                <p className="card-sub">{t(remaining === 1 ? 'bcRemainingOne' : 'bcRemainingMany', { n: remaining })}</p>
              ) : allAbsent ? (
                <p className="card-sub">{t('bcAllAbsent')}</p>
              ) : absent.length > 0 || short.length > 0 ? (
                <>
                  {zeroing && (
                    <>
                      <p className="card-sub">{t('bcZeroIntro', { n: toZero.length })}</p>
                      {absentList(toZero)}
                      {order.goodsFollowsLines === false && (
                        <p className="card-sub bc-lot-note">{t('bcLotPriceKept')}</p>
                      )}
                    </>
                  )}
                  {absentKept.length > 0 && (
                    <>
                      <p className="card-sub">{t('bcAbsentIntro', { n: absentKept.length })}</p>
                      {absentList(absentKept)}
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
              {unpriced.length > 0 && (
                <>
                  <p className="card-sub">{t('bcUnpricedIntro', { n: unpriced.length })}</p>
                  <ul className="bc-problem-list">
                    {unpriced.map(l => (
                      <li key={l.id}>
                        <span className="mono">#{lineNo(l)} {l.partNumber ?? lineLabel(l)}</span>
                        {' · '}{t('bcUnpricedNote')}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="bc-finish-earn">
                <span>{t('eoPurchaserEarns')}</span>
                <b className={earnsClass}>{fmtUSD(money.earns, locale)}</b>
              </div>
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
          onChange={patch => setEditing(e => e && {
            ...e, line: { ...e.line, ...patch, _dirty: e.line._dirty || patchEditsLine(patch) },
          })}
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
      {label.element}
    </div>
  );
}

function lineLabel(l: OrderLine): string {
  return lineSpecLabel(l) || l.description || l.category;
}

// The count, typed beside − / +. It lands on Enter or on leaving the field,
// never per keystroke: the 6 of a 67 would be saved, and take the line's tick
// away on the way.
function CountField({ value, max, disabled, label, onFocus, onCommit, onScanKey }: {
  value: number;
  max: number;
  disabled: boolean;
  label: string;
  onFocus: () => void;
  onCommit: (n: number) => void;
  onScanKey: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Set right before blur(), whose handler still sees the draft as it was.
  const cancelled = useRef(false);
  const typed = useRef(false);
  const leave = (el: HTMLInputElement) => {
    cancelled.current = true;
    el.blur();
  };
  return (
    <input
      className="mono bc-count-in"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      disabled={disabled}
      value={draft ?? String(value)}
      onFocus={e => {
        // Back from another window, what was typed before is still the draft.
        if (draft !== null) return;
        setDraft(String(value));
        typed.current = false;
        e.target.select();
        onFocus();
      }}
      onChange={e => {
        typed.current = true;
        setDraft(e.target.value.replace(/\D/g, ''));
      }}
      onBlur={e => {
        // The window lost focus, not the field.
        if (document.activeElement === e.currentTarget) return;
        if (!cancelled.current && draft) onCommit(Number(draft));
        cancelled.current = false;
        setDraft(null);
      }}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          // Puts the count back; never leaves the page.
          e.stopPropagation();
          leave(e.currentTarget);
        } else if (e.key === '+' || e.key === '=' || e.key === '-') {
          // The page's count keys keep their meaning here: they step what is
          // typed, and Enter saves it.
          e.preventDefault();
          typed.current = true;
          const n = Number(draft || value) + (e.key === '-' ? -1 : 1);
          setDraft(String(Math.max(0, Math.min(max, n))));
        } else if (e.key.length === 1 && e.key.trim() && !/\d/.test(e.key)) {
          // A scanner typing a label here: it goes to the scan box, digits
          // it had already typed included, and the count stays as it was.
          e.preventDefault();
          const head = typed.current ? draft ?? '' : '';
          leave(e.currentTarget);
          onScanKey(head + e.key);
        }
      }}
    />
  );
}

// The sell price, typed beside the count. It lands on Enter or on leaving the
// field, never per keystroke. Unpriced (no price, or the 0 that also means
// none), the field shows the market's value as a ghost, and Enter on the empty
// field takes it; a price typed back to blank unprices the line.
function PriceField({ value, suggestion, incoming = false, disabled, label, inputRef, onFocus, onCommit, onScanKey }: {
  value: number | null;
  suggestion: number | null;
  // Shows a sheet's price waiting to be applied.
  incoming?: boolean;
  disabled: boolean;
  label: string;
  inputRef: (el: HTMLInputElement | null) => void;
  onFocus: () => void;
  onCommit: (v: number | null) => void;
  onScanKey: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Set right before blur(), whose handler still sees the draft as it was.
  const cancelled = useRef(false);
  const takeSuggestion = useRef(false);
  const priced = isPricedSellPrice(value);
  const shown = priced ? value!.toFixed(2) : '';
  const leave = (el: HTMLInputElement) => {
    cancelled.current = true;
    el.blur();
  };
  return (
    <input
      ref={inputRef}
      className={'bc-price-in' + (incoming ? ' incoming' : '')}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      disabled={disabled}
      placeholder={suggestion != null ? suggestion.toFixed(2) : '—'}
      value={draft ?? shown}
      onFocus={e => {
        // Back from another window, what was typed before is still the draft.
        if (draft !== null) return;
        setDraft(shown);
        e.target.select();
        onFocus();
      }}
      onChange={e => setDraft(e.target.value.replace(/[^\d.,]/g, ''))}
      onBlur={e => {
        // The window lost focus, not the field.
        if (document.activeElement === e.currentTarget) return;
        if (!cancelled.current) {
          if (takeSuggestion.current && suggestion != null) onCommit(suggestion);
          else {
            const parsed = parsePriceInput(draft ?? '');
            // What is not a price is dropped; the field reads the saved one again.
            if (parsed !== undefined) onCommit(parsed);
          }
        }
        cancelled.current = false;
        takeSuggestion.current = false;
        setDraft(null);
      }}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          // Only a line never priced takes the ghost: a price cleared and
          // entered is the manager unpricing it.
          takeSuggestion.current = !priced && (draft ?? '').trim() === '';
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          // Puts the price back; never leaves the page.
          e.stopPropagation();
          leave(e.currentTarget);
        } else if (e.key.length === 1 && e.key.trim() && !/[\d.,]/.test(e.key)) {
          // A scanner typing a label here: it goes to the scan box, and the
          // price stays as it was.
          e.preventDefault();
          leave(e.currentTarget);
          onScanKey(e.key);
        }
      }}
    />
  );
}

// What a sell order sheet says about one row while it waits to be applied:
// where an incoming price was read, why the row can't be matched, or that it
// already stands at the sheet's price.
function SheetNote({ plan, figure, reason, disabled, onKeep }: {
  plan: Exclude<SheetRowPlan, { kind: 'off' }>;
  figure: (c: SheetCell) => string;
  reason: (m: SheetSkip) => string;
  disabled: boolean;
  onKeep: () => void;
}) {
  const { t, locale } = useT();
  if (plan.kind === 'same') {
    return <div className="bc-price-sub" title={plan.cell.sheet}>{t('bcSheetSame', { row: plan.cell.rowNumber })}</div>;
  }
  if (plan.kind === 'skip') return <div className="bc-price-sub warn">{reason(plan.match)}</div>;
  const kept = plan.kind === 'kept';
  // A dollar figure is the one in the field already. Yuan are shown as the
  // sheet has them, so a wrong match or a wrong rate is caught by eye; a kept
  // row shows what it turned down.
  const withFigure = kept || plan.cell.listedPrice != null;
  return (
    <>
      <div className={'bc-price-src mono' + (kept ? ' kept' : '')} title={plan.cell.sheet}>
        {withFigure && <><span className="fig">{figure(plan.cell)}</span><span>·</span></>}
        <span>{t('bcSheetRow', { row: plan.cell.rowNumber })}</span>
      </div>
      {plan.kind !== 'in' && (
        <button
          type="button"
          className={'bc-keep' + (kept ? ' on' : '')}
          aria-pressed={kept}
          disabled={disabled}
          onClick={onKeep}
        >
          {plan.was === null
            ? t('bcSheetKeptBlank')
            : t(kept ? 'bcSheetKeeping' : 'bcSheetKeep', { price: fmtUSD(plan.was, locale) })}
        </button>
      )}
    </>
  );
}

// The PO's commission rate as a percent, saved on Enter or on leaving the
// field; Escape puts it back. Blank unsets it, which the maths reads as 0.
function RateField({ id, value, disabled, onCommit }: {
  id: string;
  value: number | null;
  disabled: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const shown = value != null ? String(+(value * 100).toFixed(2)) : '';
  return (
    <input
      id={id}
      className="input mono"
      type="number"
      min={0}
      max={100}
      step="0.1"
      disabled={disabled}
      placeholder="—"
      value={draft ?? shown}
      onFocus={() => { if (draft === null) setDraft(shown); }}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => {
        if (!cancelled.current && draft !== null) {
          const s = draft.trim();
          const n = s === '' ? null : Number(s);
          if (n === null) onCommit(null);
          else if (Number.isFinite(n) && n >= 0 && n <= 100) onCommit(n / 100);
        }
        cancelled.current = false;
        setDraft(null);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
