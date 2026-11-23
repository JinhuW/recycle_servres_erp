import type { EbayCounts, EbayLotStock, EbayListingStatus, EbayPartInput } from './api';

// The eBay desk's queues, in the order the tab bar shows them. Each is a
// piece of the operator's work, not a status report: "confirm" holds sales,
// the rest hold listings.
export type EbayTab = 'post' | 'confirm' | 'live' | 'sold' | 'ended';
export const EBAY_TABS: readonly EbayTab[] = ['post', 'confirm', 'live', 'sold', 'ended'];

export function ebayTabCount(tab: EbayTab, counts: EbayCounts): number {
  return tab === 'post' ? counts.Queued
    : tab === 'confirm' ? counts.ToConfirm
    : tab === 'live' ? counts.Listed
    : tab === 'sold' ? counts.Sold
    : counts.Ended;
}

/** The desk opens on the first queue with work in it; with none, on Live. */
export function firstTabWithWork(counts: EbayCounts): EbayTab {
  if (counts.Queued > 0) return 'post';
  if (counts.ToConfirm > 0) return 'confirm';
  return 'live';
}

export function tabForStatus(status: EbayListingStatus): EbayTab {
  return status === 'Queued' ? 'post' : status === 'Listed' ? 'live' : status === 'Sold' ? 'sold' : 'ended';
}

// Past this many days on eBay a listing is worth asking about: should it come
// off as not sold? The shelf bar fills over these days and turns warn after.
export const SHELF_DAYS = 30;

export function shelfBar(days: number): { pct: number; over: boolean } {
  const d = Math.max(0, days);
  return { pct: Math.min(100, Math.round((d / SHELF_DAYS) * 100)), over: d > SHELF_DAYS };
}

// ── The listing rows of Send to eBay and Split ─────────────────────────────

export type PartRow = { key: number; spec: string; qty: string; price: string };

const isWholeQty = (s: string) => /^\d+$/.test(s.trim()) && Number(s) >= 1;
const isPrice = (s: string) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0;

export type PartTotals = {
  assigned: number;
  /** More units than the lot (or the listing being split) has. */
  over: boolean;
  /** A split must hand out every unit; Send to eBay may leave some sellable. */
  short: boolean;
  /** Rows whose units or price can't be sent. */
  badRows: number[];
  ok: boolean;
};

/**
 * The running total under the rows. `exact` is the split: its parts have to
 * add up to the listing, where a send only has to fit within what is
 * sellable.
 */
export function partTotals(rows: readonly PartRow[], limit: number, exact: boolean, minRows = 1): PartTotals {
  const assigned = rows.reduce((n, r) => n + (isWholeQty(r.qty) ? Number(r.qty) : 0), 0);
  const badRows = rows.filter(r => !isWholeQty(r.qty) || !isPrice(r.price)).map(r => r.key);
  const over = assigned > limit;
  const short = exact && assigned < limit;
  return { assigned, over, short, badRows, ok: rows.length >= minRows && !over && !short && badRows.length === 0 };
}

export function partInputs(rows: readonly PartRow[]): EbayPartInput[] {
  return rows.map(r => ({
    qty: Number(r.qty),
    listPrice: Math.round(Number(r.price) * 100) / 100,
    spec: r.spec.trim() || null,
  }));
}

// ── The lot behind a listing ───────────────────────────────────────────────

/**
 * Units promised beyond what the lot holds. Sellable is what is left once
 * eBay and the sell orders have their share, so below zero the shelf and the
 * books disagree, and someone has to count it.
 */
export function stockShortfall(stock: EbayLotStock): number {
  return stock.sellable < 0 ? -stock.sellable : 0;
}

/** "2567…0987": an eBay item number short enough for a table cell. */
export function shortItemId(id: string): string {
  return id.length > 9 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

/**
 * What holds a PO line, split by kind. The PO page gets one list of holder
 * ids; eBay listings are the `EB-n` ones and are not shipments.
 */
export function splitLineHolders(ids: readonly string[]): { sellOrders: string[]; ebay: string[] } {
  return {
    sellOrders: ids.filter(id => !/^EB-\d+$/.test(id)),
    ebay: ids.filter(id => /^EB-\d+$/.test(id)),
  };
}
