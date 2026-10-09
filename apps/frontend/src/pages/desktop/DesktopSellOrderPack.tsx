import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseSerials } from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { LineSpecChips, lineHasSpecChips } from '../../components/LineSpecChips';
import { StatusChangeDialog, type StatusAttachment } from '../../components/StatusChangeDialog';
import { api, ApiError, rawFetch } from '../../lib/api';
import {
  countOf, emptyCheck, filterScan, isAbsentChecked, isShortChecked, lineState, partsNamed, type LineCheck,
} from '../../lib/boxCheck';
import { handleFetchError, showErrorDialog, showWarnToast } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import { sellOrderStatuses } from '../../lib/lookups';
import { navigate, navigateBack } from '../../lib/route';
import {
  flaggedLots, isPackable, nextOpenProduct, packBody, packGroups, packProducts, packScan, packView, packWarehouseOf,
  packWarehouseOptions, productSummary, productTally, productTick, shipBlockers, sourceTag, toCheck, UNASSIGNED,
  type PackLine, type PackProduct, type PackResponse,
} from '../../lib/sellOrderPack';
import type { Category } from '../../lib/types';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { useLineSaveQueue } from '../../lib/useLineSaveQueue';
import { useScanFilterText } from '../../lib/useScanFilter';

// Pack mode: a sell order as a packing checklist, laid out like the PO's
// Review mode and built for an iPad on a cart. Products run in the order's own
// list order, each led by its # on the order — the number the packer writes on
// the item's label and the receiver checks the box by. A product picked from
// several lots folds them under one row: ticking the row packs every lot at
// its full count, and opening it shows each lot (From PO-1111 #1) with its own
// count and tick. A packed product sinks under Packed, newest first, as Review
// mode's checked lines do, and what is left stays on top in # order; one
// packed at 0 keeps its place. (Rows stayed put from 2026-10-07; sinking was
// asked for on 2026-10-08.) Counts start full and are lowered only when the
// shelf is short. On a Draft the tick writes the count onto the order's line
// and taking it back puts the qty back — the server's rule, in
// routes/sellOrderPack.ts — so a lot held at 0 has nothing left to pack.
// Lots lowered and left unticked are listed in Finish, whose Apply ticks them
// all at their counts in one request.

type OrderLine = {
  id: string;
  // The product's # on the order — the label the packer writes.
  no: number;
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
type Product = PackProduct<Line>;
type Undo = { prev: LineCheck[]; msg: string };
type ScanMsg = { tone: 'muted' | 'pos' | 'warn' | 'neg'; text: string };

type Props = {
  id: string;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

const toneFor = (s: string) => sellOrderStatuses.find(o => o.id === s)?.tone ?? 'muted';
const pnOf = (l: Line) => l.partNumber ?? l.label;
// A row is a lot (its line id) or a folded product's head row.
const prodKey = (no: number) => 'p:' + no;
const rowElId = (key: string) => (key.startsWith('p:') ? 'pk-prod-' + key.slice(2) : 'pk-row-' + key);
const COLS = 6;

export default function DesktopSellOrderPack({ id, onToast }: Props) {
  const { t } = useT();
  const [order, setOrder] = useState<PackOrder | null>(null);
  // Only the first read can leave the page with no order; a failed re-read
  // keeps the one already shown.
  const [orderFailed, setOrderFailed] = useState(false);
  const [serials, setSerials] = useState<ReadonlyMap<string, string | null>>(new Map());
  // Each line's qty as the pack endpoints last reported it: a tick on a Draft
  // changes it without the order being re-read.
  const [qtys, setQtys] = useState<ReadonlyMap<string, number>>(new Map());
  const [showPacked, setShowPacked] = useState(true);
  const [wh, setWh] = useState('');
  const [undo, setUndo] = useState<Undo | null>(null);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<ScanMsg | null>(null);
  // Lines a part-number scan could have meant, waiting for a tap.
  const [choose, setChoose] = useState<ReadonlySet<string>>(new Set());
  // Folded products the packer opened, by #.
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
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

  // Opening Pack mode is what moves a Draft to Packing — once per visit, so a
  // refocus doesn't undo a manager stepping it back to Draft. A refusal stays
  // quiet: packing works the same on a Draft, and a backend older than this
  // bundle refuses the status it doesn't know on every open.
  const enteredPacking = useRef(false);
  useEffect(() => {
    if (!order || enteredPacking.current) return;
    enteredPacking.current = true;
    if (order.status !== 'Draft' || order.archivedAt !== null) return;
    api.post(`/api/sell-orders/${id}/status`, { to: 'Packing' }).then(
      () => setOrder(o => o && { ...o, status: 'Packing' }),
      () => {},
    );
  }, [order, id]);

  const qtyById = useRef(new Map<string, number>());
  qtyById.current = useMemo(
    () => new Map((order?.lines ?? []).map(l => [l.id, qtys.get(l.id) ?? l.qty])),
    [order, qtys],
  );
  const url = (lineId: string) => `/api/sell-orders/${id}/pack/${lineId}`;
  const bodyOf = (c: LineCheck) => packBody(c, qtyById.current.get(c.lineId) ?? c.counted);

  const { checks, loadState, reload, save, flush, accept } = useLineSaveQueue<PackResponse>({
    read: () => api.get<PackResponse>(`/api/sell-orders/${id}/pack`),
    // Only the written line's qty is taken from a write: writes of one line
    // land in order, while the rest of the reply can be older than theirs.
    send: c => api.put<PackResponse>(url(c.lineId), bodyOf(c)).then(r => {
      const q = r.lines.find(x => x.lineId === c.lineId)?.qty;
      if (q !== undefined) setQtys(m => (m.get(c.lineId) === q ? m : new Map(m).set(c.lineId, q)));
      return r;
    }),
    beacon: c => { void rawFetch('PUT', url(c.lineId), bodyOf(c), undefined, { keepalive: true }).catch(() => {}); },
    checksOf: r => r.lines.map(toCheck),
    onServer: r => {
      setSerials(new Map(r.lines.map(x => [x.lineId, x.serialNumber])));
      setQtys(new Map(r.lines.flatMap(x => (x.qty === undefined ? [] : [[x.lineId, x.qty] as const]))));
    },
    onWriteError: e => {
      // Saving the order's lines replaces their rows, so a line this page
      // still holds may be gone; the fresh order carries its successor.
      if (e instanceof ApiError && e.status === 404) {
        showWarnToast(t('pkLineChanged'));
        void loadOrder();
        return;
      }
      handleFetchError(e);
      // The page's copy is behind: another iPad or the editor changed the
      // line, or its lot went elsewhere before its qty could be put back.
      if (e instanceof ApiError && (e.status === 400 || e.status === 409)) void loadOrder();
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
    () => (order?.lines ?? []).map(l => ({ ...l, qty: qtys.get(l.id) ?? l.qty, serialNumber: serials.get(l.id) ?? null })),
    [order, serials, qtys],
  );
  const lineById = useMemo(() => new Map(lines.map(l => [l.id, l])), [lines]);
  const readOnly = !!order && (order.archivedAt !== null || order.status === 'Closed');
  const ready = loadState === 'ok' && !!order && !readOnly;
  // A Draft or Packing order takes its counts from the box: a short tick sets
  // the line's qty, and the order can ship from here.
  const takesCounts = order?.status === 'Draft' || order?.status === 'Packing';

  const warehouses = useMemo(() => packWarehouseOptions(lines), [lines]);
  // A picked warehouse the order no longer has (a line was moved) falls back to all.
  const picked = warehouses.includes(wh) ? wh : '';
  const allProducts = useMemo(() => packProducts(packView(lines, '')), [lines]);
  const products = useMemo(() => packProducts(packView(lines, picked)), [lines, picked]);
  const productByNo = useMemo(() => new Map(allProducts.map(p => [p.no, p])), [allProducts]);
  const lineNo = useMemo(() => new Map(lines.map(l => [l.id, l.no])), [lines]);
  // Typing narrows the list once it pauses. The filter searches the whole
  // order, packable lines only, as Enter does, so it never hides the line
  // Enter would pack; a product holding a match shows whole, opened. It
  // changes only what is listed — progress and Mark shipped read `products`
  // and `lines`.
  const filterText = useScanFilterText(scan);
  const fit = useMemo(() => {
    const hits = filterScan(lines.filter(isPackable), filterText);
    return hits ? new Set(hits.map(l => l.id)) : null;
  }, [lines, filterText]);
  const listed = useMemo(
    () => (fit ? allProducts.filter(p => p.lots.some(l => fit.has(l.id))) : products),
    [fit, allProducts, products],
  );
  const sum = useMemo(() => productTally(products, checks), [products, checks]);
  const whole = useMemo(() => productTally(allProducts, checks), [allProducts, checks]);
  const blockers = useMemo(() => shipBlockers(lines, checks), [lines, checks]);
  const flagged = useMemo(() => flaggedLots(lines, checks), [lines, checks]);
  const canShip = ready && takesCounts && lines.some(isPackable)
    && blockers.open === 0 && blockers.short === 0 && blockers.zero === 0;

  const folds = (p: Product) => p.lots.length > 1;
  // Opened by the packer, or held open while the filter has a match in it.
  const forcedOpen = (p: Product) => !!fit && p.lots.some(l => fit.has(l.id));
  const isOpen = (p: Product) => folds(p) && (open.has(p.no) || forcedOpen(p));
  const keysOf = (p: Product) => (folds(p) ? [prodKey(p.no), ...(isOpen(p) ? p.lots.map(l => l.id) : [])] : [p.head.id]);
  const groups = useMemo(() => packGroups(listed, checks), [listed, checks]);
  const visibleKeys = [...groups.open, ...(showPacked ? groups.packed : [])].flatMap(keysOf);
  const selKey = selected && visibleKeys.includes(selected) ? selected : visibleKeys[0] ?? null;
  const productOf = (lineId: string) => productByNo.get(lineNo.get(lineId) ?? -1) ?? null;
  // The row a line shows on: its own, or its product's while folded.
  const rowKeyOf = (lineId: string) => {
    const p = productOf(lineId);
    return p && folds(p) && !isOpen(p) ? prodKey(p.no) : lineId;
  };

  // ── FLIP: a row that changes group slides from where it was, as in Review
  // mode. Positions are measured inside the table, so scrolling between two
  // changes doesn't read as every row having moved.
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const lastTops = useRef(new Map<string, number>());
  const lastLayout = useRef({ fit, picked, open });
  useLayoutEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // A filter, a warehouse or a fold moves rows without any of them changing
    // group: measured, never animated.
    const was = lastLayout.current;
    const relaid = was.fit !== fit || was.picked !== picked || was.open !== open;
    lastLayout.current = { fit, picked, open };
    const tops = new Map<string, number>();
    rowRefs.current.forEach((el, key) => {
      const top = el.offsetTop;
      tops.set(key, top);
      const before = lastTops.current.get(key);
      if (!reduce && !relaid && before !== undefined && Math.abs(before - top) > 2 && el.animate) {
        el.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }],
          { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    lastTops.current = tops;
  }, [groups, showPacked, fit, picked, open]);

  const showWh = warehouses.length > 1 && (!!fit || !picked);
  const whName = (w: string | null) => (w === null || w === UNASSIGNED ? t('sodNoWarehouse') : w);
  const fromText = (l: Line) => {
    const tag = sourceTag(l);
    if (!tag) return t('pkTypedIn');
    return tag.no != null ? t('pkFromPoLine', { po: tag.po, n: tag.no }) : t('pkFromPo', { po: tag.po });
  };
  const lotTag = (l: Line) => {
    const tag = sourceTag(l);
    if (!tag) return t('pkNoPo');
    return tag.no != null ? `${tag.po} #${tag.no}` : tag.po;
  };
  const lotTags = (lots: readonly Line[]) => {
    const shown = lots.slice(0, 2).map(lotTag).join(', ');
    return lots.length > 2 ? `${shown} ${t('pkSourcesMore', { n: lots.length - 2 })}` : shown;
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

  const setFold = (no: number, to: boolean) => {
    setOpen(prev => {
      const next = new Set(prev);
      if (to) next.add(no); else next.delete(no);
      return next;
    });
    // A lot can't stay selected inside a fold that closed over it.
    if (!to && selKey && !selKey.startsWith('p:') && lineNo.get(selKey) === no) setSelected(prodKey(no));
  };
  const openFolds = (nos: Iterable<number>) => setOpen(prev => new Set([...prev, ...nos]));

  // The stepper only changes the number. Lowering a packed line takes the
  // tick away, so a short pick is always confirmed by a tick made after it.
  const setCount = (l: Line, n: number) => {
    if (!ready) return;
    const prev = checkOf(l.id);
    const counted = Math.max(0, Math.min(l.qty, n));
    if (counted === prev.counted) return;
    save({ ...prev, counted, checkedAt: counted < l.qty ? null : prev.checkedAt });
  };

  // Once a tick packs the product the selection is on, the selection moves on
  // to the next one still to pack, as Review mode's does: the packed row has
  // sunk, or at 0 has nothing left to do.
  const moveOn = (lineId: string, after: ReadonlyMap<string, LineCheck>) => {
    const p = productOf(lineId);
    if (!p || productSummary(p.lots, after).state !== 'done') return;
    const next = nextOpenProduct(products, after, p.no);
    if (next) setSelected(keysOf(next)[0]!);
  };

  const pack = (l: Line) => {
    const prev = checkOf(l.id);
    const next = { ...prev, checkedAt: new Date().toISOString() };
    save(next);
    setChoose(new Set());
    const n = countOf(l, prev);
    flashUndo({ prev: [prev], msg: t(takesCounts && n < l.qty ? 'pkPackedSetToast' : 'pkPackedToast', { pn: pnOf(l), n, of: l.qty }) });
    moveOn(l.id, new Map(checks).set(l.id, next));
  };

  const toggle = (l: Line) => {
    if (!ready) return;
    const c = checkOf(l.id);
    if (lineState(l, c) === 'done') {
      save({ ...c, checkedAt: null });
      flashUndo({ prev: [c], msg: t('pkUnpackedToast', { pn: pnOf(l) }) });
      return;
    }
    pack(l);
  };

  const toggleProduct = (p: Product) => {
    if (!ready) return;
    const plan = productTick(p.lots, checks);
    const pn = pnOf(p.head);
    setChoose(new Set());
    if (plan.untick.length) {
      const prev = plan.untick.map(l => checkOf(l.id));
      prev.forEach(c => save({ ...c, checkedAt: null }));
      flashUndo({ prev, msg: t('pkUnpackedToast', { pn }) });
      return;
    }
    if (plan.left.length) {
      setFold(p.no, true);
      setScanMsg({ tone: 'warn', text: t('pkProductLeft', { pn, n: plan.left.length }) });
    }
    if (!plan.tick.length) return;
    const now = new Date().toISOString();
    const prev = plan.tick.map(l => checkOf(l.id));
    const after = new Map(checks);
    prev.forEach(c => {
      const next = { ...c, checkedAt: now };
      save(next);
      after.set(c.lineId, next);
    });
    flashUndo({ prev, msg: t('pkPackedLotsToast', { pn, n: plan.tick.length, of: p.lots.length }) });
    moveOn(p.head.id, after);
  };

  const toggleKey = (key: string) => {
    if (key.startsWith('p:')) {
      const p = productByNo.get(Number(key.slice(2)));
      if (p) toggleProduct(p);
      return;
    }
    const l = lineById.get(key);
    if (l && isPackable(l)) toggle(l);
  };

  // Every lot lowered and left unticked, ticked at its count in one request:
  // on a Draft or Packing order each line goes to its count, a 0 included,
  // and keeps its #.
  const applyFlagged = async () => {
    if (!ready || !takesCounts || busy || !flagged.length) return;
    const before = new Map(flagged.map(l => [l.id, checkOf(l.id)]));
    setBusy(true);
    try {
      // The counts being applied are the server's, so none may still be waiting.
      await flush();
      const r = await api.post<PackResponse>(`/api/sell-orders/${id}/pack/apply`, { lineIds: [...before.keys()] });
      accept(r);
      const applied = r.applied ?? [];
      setChoose(new Set());
      if (!applied.length) {
        showWarnToast(t('pkApplyNone'));
        return;
      }
      flashUndo({
        prev: applied.flatMap(lineId => before.get(lineId) ?? []),
        msg: applied.length === 1 ? t('pkAppliedToastOne') : t('pkAppliedToast', { n: applied.length }),
      });
      // The selection moves on as a tick's does, judged on the reply: a fold
      // that lost a lot to 0 may now be a single row, under another key.
      const selNo = selKey ? (selKey.startsWith('p:') ? Number(selKey.slice(2)) : lineNo.get(selKey)) : undefined;
      if (selNo !== undefined && applied.some(lineId => lineNo.get(lineId) === selNo)) {
        const qtyNow = new Map(r.lines.map(x => [x.lineId, x.qty]));
        const now = packProducts(packView(lines.map(l => ({ ...l, qty: qtyNow.get(l.id) ?? l.qty })), picked));
        const after = new Map(r.lines.map(x => [x.lineId, toCheck(x)]));
        const p = now.find(x => x.no === selNo);
        const state = p && productSummary(p.lots, after).state;
        const target = state === 'open' || state === 'mixed' ? p : nextOpenProduct(now, after, selNo);
        setSelected(target ? keysOf(target)[0]! : null);
      }
    } catch (e) {
      handleFetchError(e);
      void loadOrder();
      void reload();
    } finally {
      setBusy(false);
    }
  };

  const undoLast = () => {
    if (!undo || !ready) return;
    undo.prev.forEach(save);
    setUndo(null);
  };

  const scrollTo = (key: string) =>
    requestAnimationFrame(() => document.getElementById(rowElId(key))?.scrollIntoView({ block: 'nearest' }));

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
      // The candidates can sit in several products, and in another warehouse.
      setChoose(new Set(m.choose.map(l => l.id)));
      openFolds(m.choose.map(l => lineNo.get(l.id) ?? -1));
      setScanMsg({ tone: 'warn', text: t('pkScanChoose', { pn: text, n: m.choose.length, lots: m.choose.map(l => `#${lineNo.get(l.id)} ${fromText(l)}`).join(', ') }) });
      if (picked && m.choose.some(l => packWarehouseOf(l) !== picked)) setWh('');
      setSelected(m.choose[0]!.id);
      scrollTo(m.choose[0]!.id);
      return;
    }
    const hit = m.line;
    const c = checks.get(hit.id);
    const key = rowKeyOf(hit.id);
    setSelected(key);
    if (countOf(hit, c) === 0) {
      setScanMsg({ tone: 'neg', text: t('pkScanZero', { pn: pnOf(hit) }) });
      scrollTo(key);
      return;
    }
    if (lineState(hit, c) === 'done') {
      setScanMsg({ tone: 'muted', text: t('pkScanAlready', { pn: pnOf(hit) }) });
      return;
    }
    setScanMsg({ tone: 'pos', text: t('pkScanPacked', { pn: pnOf(hit) }) });
    pack(hit);
    scrollTo(key);
  };

  // ── Keyboard. Arrows, Space and / only: every other key a scanner or a
  // person types starts the scan box, which filters as it fills.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The photo viewer isn't an aria-modal dialog, so it is named here.
      if (shipping || zoom || document.querySelector('[aria-modal="true"]')) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const move = (d: number) => {
        const i = selKey ? visibleKeys.indexOf(selKey) : -1;
        const next = visibleKeys[Math.max(0, Math.min(visibleKeys.length - 1, i + d))];
        if (!next) return;
        setSelected(next);
        scrollTo(next);
      };
      const foldOf = (key: string) => productByNo.get(key.startsWith('p:') ? Number(key.slice(2)) : lineNo.get(key) ?? -1);
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); move(1); return;
        case 'ArrowUp': e.preventDefault(); move(-1); return;
        case 'ArrowRight':
        case 'ArrowLeft': {
          const p = selKey ? foldOf(selKey) : undefined;
          if (!p || !folds(p)) return;
          e.preventDefault();
          setFold(p.no, e.key === 'ArrowRight');
          return;
        }
        case ' ':
          // Buttons outside the list (Mark shipped) keep their own Space.
          if (target?.closest('button') && !target.closest('.pk-table')) return;
          e.preventDefault();
          if (target?.closest('button')) target.blur();
          if (selKey) toggleKey(selKey);
          return;
        case '/':
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

  // ── Rows
  // A product shows the first lot with a photo, as the packing list does.
  const photoOf = (p: Product) => p.lots.find(l => l.imageUrl) ?? p.head;
  const thumb = (l: Line) => (l.imageUrl ? (
    <button type="button" className="pk-thumb" aria-label={t('pkPhoto', { pn: pnOf(l) })} onClick={() => setZoom(l.imageUrl!)}>
      <img src={l.imageUrl} alt="" loading="lazy" decoding="async" />
    </button>
  ) : (
    // Same footprint, so the items stay in one column.
    <span className="pk-thumb pk-thumb-none" aria-hidden="true">
      <Icon name={l.category === 'RAM' ? 'chip' : 'drive'} size={18} />
    </span>
  ));

  const itemCell = (l: Line, meta: ReactNode) => {
    // Condition has its own column, so the SSD/HDD chips don't repeat it.
    const chipLine = { ...l, condition: null };
    return (
      <td className="pk-item-cell">
        <div className="bc-pn mono">{pnOf(l)}</div>
        <div className="bc-spec">
          {l.partNumber && <span>{l.label}</span>}
          {lineHasSpecChips(chipLine, true) ? <LineSpecChips line={chipLine} withType /> : l.sub && <span>{l.sub}</span>}
        </div>
        <div className="pk-meta">
          {meta}
          {l.condition && <span className="pk-cond-inline">{l.condition}</span>}
        </div>
      </td>
    );
  };

  // The click stops here: the row's own click would select it again after a
  // tick that packed it had moved the selection on.
  const tickCell = (key: string, pressed: boolean | 'mixed', label: string, onTick: () => void) => (
    <td className="bc-cb-cell">
      <button
        type="button"
        className="bc-cb pk-cb"
        aria-pressed={pressed}
        aria-label={label}
        disabled={!ready}
        onClick={e => { e.stopPropagation(); setSelected(key); onTick(); }}
      >
        {pressed === true && <Icon name="check" size={18} stroke={3} />}
      </button>
    </td>
  );

  const flag = (n: number, qty: number) => (n === 0
    ? <div className="pk-flag neg">{t('pkZeroTag')}</div>
    : n < qty && <div className="pk-flag warn">{t('pkShortTag')}</div>);

  const countCell = (l: Line, n: number) => (
    <td className="num pk-count-cell">
      <div className="pk-count">
        <button type="button" className="pk-step" aria-label={t('pkLess')} disabled={!ready || n === 0} onClick={() => setCount(l, n - 1)}>
          <Icon name="minus" size={16} />
        </button>
        <span className="mono bc-count-n"><b>{n}</b><span className="muted"> / {l.qty}</span></span>
        <button type="button" className="pk-step" aria-label={t('pkMore')} disabled={!ready || n >= l.qty} onClick={() => setCount(l, n + 1)}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      {flag(n, l.qty)}
    </td>
  );

  const lineClass = (l: Line) => {
    const c = checks.get(l.id);
    return 'bc-' + lineState(l, c)
      + (isShortChecked(l, c) ? ' pk-done-short' : '')
      + (isAbsentChecked(l, c) ? ' bc-done-absent' : '')
      + (choose.has(l.id) ? ' pk-choose' : '');
  };
  const rowProps = (key: string, cls: string) => ({
    id: rowElId(key),
    ref: (el: HTMLTableRowElement | null) => { if (el) rowRefs.current.set(key, el); else rowRefs.current.delete(key); },
    className: 'bc-row ' + cls + (selKey === key ? ' row-selected' : ''),
    onClick: () => setSelected(key),
  });

  // A product from one lot is one row, as a line.
  const singleRow = (p: Product) => {
    const l = p.head;
    const c = checkOf(l.id);
    const state = lineState(l, c);
    return (
      <tr key={l.id} {...rowProps(l.id, lineClass(l))}>
        {tickCell(l.id, state === 'done', t(state === 'done' ? 'pkUnpackLine' : 'pkPackLine', { pn: pnOf(l) }), () => toggle(l))}
        <td className="pk-no-cell mono"><span className="pk-no">#{p.no}</span></td>
        <td className="pk-thumb-cell">{thumb(l)}</td>
        {itemCell(l, (
          <>
            <span className="mono pk-from">{fromText(l)}</span>
            {showWh && <span>{whName(packWarehouseOf(l))}</span>}
          </>
        ))}
        <td className="muted bc-cond pk-cond-cell">{l.condition}</td>
        {countCell(l, countOf(l, c))}
      </tr>
    );
  };

  // Every lot of the product is held at 0: it keeps its # and nothing else.
  const zeroRow = (p: Product) => {
    const l = p.head;
    return (
      <tr key={l.id} {...rowProps(l.id, 'pk-zero')}>
        <td className="bc-cb-cell" />
        <td className="pk-no-cell mono"><span className="pk-no">#{p.no}</span></td>
        <td className="pk-thumb-cell">{thumb(l)}</td>
        {itemCell(l, <span className="mono">{fromText(l)}</span>)}
        <td className="muted bc-cond pk-cond-cell">{l.condition}</td>
        <td className="num pk-zero-note">{t('pkZeroLine')}</td>
      </tr>
    );
  };

  const foldRows = (p: Product) => {
    const s = productSummary(p.lots, checks);
    const pn = pnOf(p.head);
    const opened = isOpen(p);
    const key = prodKey(p.no);
    const cls = 'pk-prod ' + (s.state === 'done' ? 'bc-done' : s.state === 'mixed' ? 'pk-mixed' : 'bc-open')
      + (s.zeroed ? ' pk-has-zero' : s.short ? ' pk-has-short' : '')
      + (p.lots.some(l => choose.has(l.id)) ? ' pk-choose' : '');
    return (
      <Fragment key={key}>
        <tr {...rowProps(key, cls)}>
          {tickCell(
            key,
            s.state === 'done' ? true : s.state === 'mixed' ? 'mixed' : false,
            t(s.state === 'done' ? 'pkUnpackProduct' : 'pkPackProduct', { pn }),
            () => toggleProduct(p),
          )}
          <td className="pk-no-cell">
            <button
              type="button"
              className="pk-fold mono"
              aria-expanded={opened}
              aria-label={t(opened ? 'pkFoldClose' : 'pkFoldOpen', { no: p.no, n: p.lots.length })}
              // The filter holds a fold with a match open.
              disabled={forcedOpen(p)}
              onClick={() => setFold(p.no, !opened)}
            >
              <Icon name="chevronDown" size={14} />
              <span className="pk-no">#{p.no}</span>
            </button>
          </td>
          <td className="pk-thumb-cell">{thumb(photoOf(p))}</td>
          {itemCell(p.head, (
            <>
              <span className="pk-lots">{t('pkLotsCount', { n: p.lots.length })}</span>
              <span className="mono pk-from">{lotTags(p.lots)}</span>
              {showWh && <span>{whName(packWarehouseOf(p.head))}</span>}
            </>
          ))}
          <td className="muted bc-cond pk-cond-cell">{p.head.condition}</td>
          <td className="num pk-count-cell">
            <span className="mono bc-count-n pk-sum"><b>{s.counted}</b><span className="muted"> / {s.qty}</span></span>
            {flag(s.counted, s.qty)}
          </td>
        </tr>
        {opened && p.lots.map(l => {
          const c = checkOf(l.id);
          const state = lineState(l, c);
          return (
            <tr key={l.id} {...rowProps(l.id, 'pk-lot ' + lineClass(l) + (fit?.has(l.id) ? ' pk-hit' : ''))}>
              {tickCell(l.id, state === 'done', t(state === 'done' ? 'pkUnpackLine' : 'pkPackLine', { pn: `${pn} ${lotTag(l)}` }), () => toggle(l))}
              <td className="pk-no-cell" />
              <td className="pk-thumb-cell">{thumb(l)}</td>
              <td className="pk-item-cell pk-lot-cell">
                <div className="pk-lot-src mono">{fromText(l)}</div>
                {/* A lot corrected after its product was numbered keeps the #,
                    so the row says what this lot is when it differs. */}
                {(pnOf(l) !== pnOf(p.head) || l.condition !== p.head.condition) && (
                  <div className="pk-meta mono">
                    {pnOf(l)}{l.condition !== p.head.condition && l.condition ? ` · ${l.condition}` : ''}
                  </div>
                )}
                {showWh && <div className="pk-meta">{whName(packWarehouseOf(l))}</div>}
              </td>
              <td className="pk-cond-cell" />
              {countCell(l, countOf(l, c))}
            </tr>
          );
        })}
      </Fragment>
    );
  };

  const productRows = (p: Product) => (!p.lots.length ? zeroRow(p) : folds(p) ? foldRows(p) : singleRow(p));

  // ── The selected row, beside the list.
  const selProduct = selKey?.startsWith('p:') ? productByNo.get(Number(selKey.slice(2))) ?? null : null;
  const selLine = selProduct ? selProduct.head : selKey ? lineById.get(selKey) ?? null : null;
  const selNo = selLine ? lineNo.get(selLine.id) : undefined;
  const selPhoto = (selProduct ? photoOf(selProduct) : selLine)?.imageUrl ?? null;
  const selSummary = selProduct ? productSummary(selProduct.lots, checks) : null;
  const selSerials = selLine && !selProduct ? parseSerials(selLine.serialNumber) : [];

  const problems = lines.filter(isPackable).filter(l => {
    const c = checks.get(l.id);
    return isShortChecked(l, c) || isAbsentChecked(l, c);
  });
  const left = whole.products - whole.done;
  const finishText = !order
    ? ''
    : readOnly
      ? t(order.archivedAt ? 'pkArchived' : 'pkClosed')
      : whole.products === 0
        ? t('pkFinishNothing')
        : blockers.open > 0
          ? t(left === 1 ? 'pkFinishLeftOne' : 'pkFinishLeft', { n: left })
          : blockers.short > 0 || blockers.zero > 0
            ? t('pkFinishFix', { short: blockers.short, zero: blockers.zero })
            : !takesCounts
              ? t('pkFinishStatus', { status: order.status })
              : t('pkFinishDone');

  const units = lines.reduce((a, l) => a + l.qty, 0);
  const shippedMeta = order?.statusMeta.Shipped;

  return (
    <div className="pk-page">
      <div className="page-head">
        <div>
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
              {order.customer.name} · {t('pkSub', { products: whole.products, units })}
            </div>
          )}
        </div>
        <div className="bc-keys pk-keys" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('bcKeyMove')}</span>
          <span><kbd>{t('bcKeySpace')}</kbd> {t('pkKeyPack')}</span>
          <span><kbd>←</kbd><kbd>→</kbd> {t('pkKeyFold')}</span>
          <span><kbd>/</kbd> {t('bcKeyScan')}</span>
        </div>
      </div>

      {readOnly && (
        <div className="oe-banner bc-banner"><Icon name="lock" size={13} /> {finishText}</div>
      )}

      <div className="card bc-tally pk-tally">
        <div className="bc-tally-num">
          <span className="mono"><b>{sum.done}</b><span className="muted"> / {sum.products}</span></span>
          <span className="card-sub">{t('pkUnits', { n: sum.counted, of: sum.units })}</span>
        </div>
        <div className="bc-tally-meter">
          <div className="bc-meter" role="img" aria-label={t('pkProgress', { n: sum.done, of: sum.products })}>
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

      <div className="pk-grid">
        <div className="card pk-list-card">
          <div className="card-head bc-scan-head">
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
            <table className="table bc-table pk-table">
              <thead>
                <tr>
                  <th className="bc-cb-cell" aria-label={t('pkColPacked')} />
                  <th className="pk-no-cell">#</th>
                  <th className="pk-thumb-cell" aria-label={t('linePhotos')} />
                  <th>{t('bcColItem')}</th>
                  <th className="pk-cond-cell">{t('bcColCondition')}</th>
                  <th className="num">{t('pkColCount')}</th>
                </tr>
              </thead>
              <tbody>
                {groups.open.map(productRows)}
                {fit?.size === 0 && (
                  <tr className="pk-empty"><td colSpan={COLS}>{t('pkFilterNone', { pn: filterText, id })}</td></tr>
                )}
                {!fit && products.length === 0 && (
                  <tr className="pk-empty"><td colSpan={COLS}>{t('pkNoneHere')}</td></tr>
                )}
                {groups.packed.length > 0 && (
                  <tr className="bc-group pk-group">
                    <td colSpan={COLS}>
                      {t('pkGroupPacked')} <span className="mono muted">{groups.packed.length}</span>
                      <button type="button" className="bc-link" onClick={() => setShowPacked(v => !v)}>
                        {showPacked ? t('bcHide') : t('bcShow')}
                      </button>
                    </td>
                  </tr>
                )}
                {showPacked && groups.packed.map(productRows)}
              </tbody>
            </table>
          )}
        </div>

        <div className="pk-side">
          {selLine && (
            <div className="card bc-compare pk-compare">
              <div className="card-head">
                <span className="card-title">
                  {t('pkSelTitle')} <span className="mono muted">#{selNo}</span>
                </span>
              </div>
              <div className="bc-photo">
                {selPhoto ? (
                  <button type="button" className="bc-photo-btn" onClick={() => setZoom(selPhoto)} title={t('linePhotos')}>
                    <img src={selPhoto} alt={t('pkPhoto', { pn: pnOf(selLine) })} />
                  </button>
                ) : (
                  <div className="bc-photo-empty"><Icon name="image" size={20} /><span>{t('bcNoPhoto')}</span></div>
                )}
              </div>
              <div className="card-body bc-compare-body">
                <div className="bc-pn mono">{pnOf(selLine)}</div>
                {selLine.partNumber && <div className="card-sub">{selLine.label}</div>}
                <dl className="bc-kv">
                  {selLine.condition && <><dt>{t('condition')}</dt><dd>{selLine.condition}</dd></>}
                  {!selProduct && <><dt>{t('pkFrom')}</dt><dd className="mono">{lotTag(selLine)}</dd></>}
                  <dt>{t('warehouse')}</dt><dd>{whName(packWarehouseOf(selLine))}</dd>
                  <dt>{t('qty')}</dt><dd className="mono">{selSummary ? selSummary.qty : selLine.qty}</dd>
                  <dt>{t('bcColCounted')}</dt>
                  <dd className="mono">{selSummary ? selSummary.counted : countOf(selLine, checks.get(selLine.id))}</dd>
                </dl>
                {selProduct ? (
                  <ul className="pk-sel-lots">
                    {selProduct.lots.map(l => {
                      const c = checks.get(l.id);
                      const done = lineState(l, c) === 'done';
                      return (
                        <li key={l.id} className={done ? 'pk-sel-done' : ''}>
                          <span className="mono">{lotTag(l)}</span>
                          <span className="mono">
                            {done && <Icon name="check" size={12} stroke={3} />} {countOf(l, c)} / {l.qty}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="bc-serials">
                    <div className="card-sub">{selSerials.length ? t('bcSerialsOnFile', { n: selSerials.length }) : t('bcNoSerials')}</div>
                    {selSerials.length > 0 && (
                      <div className="bc-serial-list">{selSerials.map(s => <span key={s} className="mono">{s}</span>)}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="card bc-finish">
            <div className="card-head"><span className="card-title">{t('pkFinishTitle')}</span></div>
            <div className="card-body">
              <p className="card-sub">{finishText}</p>
              {!readOnly && blockers.open === 0 && problems.length > 0 && (
                <ul className="bc-problem-list">
                  {problems.map(l => (
                    <li key={l.id}>
                      <span className="mono">#{lineNo.get(l.id)} {lotTag(l)}</span>
                      {' · '}{t('bcShortNote', { n: countOf(l, checks.get(l.id)), of: l.qty })}
                    </li>
                  ))}
                </ul>
              )}
              {!readOnly && takesCounts && flagged.length > 0 && (
                <div className="pk-flagged">
                  <div className="pk-flagged-title">{t('pkFlaggedTitle')}</div>
                  <ul className="bc-problem-list pk-flagged-list">
                    {flagged.map(l => (
                      <li key={l.id}>
                        <span className="mono">#{lineNo.get(l.id)} {pnOf(l)}</span>
                        {' · '}<span className="muted">{lotTag(l)}</span>
                        {' · '}{t('bcShortNote', { n: countOf(l, checks.get(l.id)), of: l.qty })}
                      </li>
                    ))}
                  </ul>
                  <p className="card-sub">{t('pkApplyHint')}</p>
                </div>
              )}
              {!readOnly && takesCounts && (
                <div className="bc-finish-actions">
                  {flagged.length > 0 && (
                    <button type="button" className="btn" disabled={!ready || busy} onClick={() => void applyFlagged()}>
                      <Icon name="check" size={15} />
                      {' '}{flagged.length === 1 ? t('pkApplyOne') : t('pkApply', { n: flagged.length })}
                    </button>
                  )}
                  {(blockers.short > 0 || blockers.zero > 0) && (
                    <button type="button" className="btn" onClick={() => navigate(`/sell-orders/${id}/edit`)}>
                      <Icon name="edit" size={15} /> {t('editOrder')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn accent"
                    disabled={!canShip || busy}
                    title={canShip ? undefined : t('pkMarkShippedTip')}
                    onClick={() => void startShip()}
                  >
                    <Icon name="truck" size={16} /> {t('pkMarkShipped')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {undo && (
        <div className="toast-wrap">
          <div className="toast info bc-undo pk-undo">
            <Icon name="check2" size={16} />
            <span>{undo.msg}</span>
            <button type="button" onClick={undoLast}>{t('undo')}</button>
          </div>
        </div>
      )}
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
