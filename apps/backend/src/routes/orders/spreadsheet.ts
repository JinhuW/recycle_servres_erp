// GET /api/orders/:id/spreadsheet — the PO as a workbook.
import { Hono } from 'hono';
import { getDb } from '../../db';
import { effectiveRole } from '../../lib/role';
import { buildXlsxWorkbook, xlsxResponse, type XlsxColumn } from '../../lib/xlsx';
import { SPEC_COLS_BY_CATEGORY, exportCategory, lineSpecFields, categoryTabSheets, type ExportCategory } from '../../lib/categoryColumns';
import { LIFECYCLE_LABEL, visibleLifecycle } from '../../services/orderAdvance';
import { sortCategories } from '../../services/orderCategory';
import { poLineOrder } from '../../lib/poLineNo';
import { type OrdersEnv } from './shared';

const spreadsheetRoutes = new Hono<OrdersEnv>();

const fmtTs = (v: unknown): string =>
  v ? new Date(v as string).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';

// ── PO spreadsheet (XLSX). Same access rules as GET /:id: owner + manager.
// A Payment tab with the header/payment fields, and a Products tab with the
// costed lines. Reuses the shared exceljs builder.
//
// The line columns are a category's full spec set — the same table the
// inventory export renders — so a RAM PO carries rank/gen/speed/chip # in their
// own sortable columns. There is deliberately no composed `Item` label column:
// once every attribute has its own cell it only repeated them, unsorted.
//
// The sets are disjoint, so a PO spanning categories splits into one sheet per
// category (categoryTabSheets). A single-category PO keeps its one 'Products'
// sheet exactly as before.
const PO_LINE_TAIL_COLS: XlsxColumn[] = [
  { header: 'Serial #',   key: 'serial',    width: 24 },
  { header: 'Qty',        key: 'qty',       width: 8,  numFmt: '#,##0' },
  { header: 'Unit cost',  key: 'unitCost',  width: 12, numFmt: '#,##0.00' },
  { header: 'Cost total', key: 'lineTotal', width: 13, numFmt: '#,##0.00' },
  { header: 'Sell price', key: 'sellPrice', width: 12, numFmt: '#,##0.00' },
  { header: 'Sell total', key: 'sellTotal', width: 13, numFmt: '#,##0.00' },
  { header: 'Profit',     key: 'profit',    width: 12, numFmt: '#,##0.00' },
];

// Each row leads with its product's # on the PO, the one the page shows: a
// PO spanning categories splits across sheets, so a row's place in its sheet
// is not its #.
const poLineCols = (cat: ExportCategory): XlsxColumn[] => [
  { header: '#', key: 'no', width: 6 },
  ...SPEC_COLS_BY_CATEGORY[cat],
  ...PO_LINE_TAIL_COLS,
];

const PO_PAYMENT_COLS: XlsxColumn[] = [
  { header: 'Field', key: 'field', width: 24 },
  { header: 'Value', key: 'value', width: 44 },
];

spreadsheetRoutes.get('/:id/spreadsheet', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const order = (await sql`
    SELECT o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
           o.total_cost::float AS total_cost, o.commission_rate::float AS commission_rate,
           o.other_fees::float AS other_fees, o.other_fees_note, o.paypal_txn_id,
           u.name AS user_name,
           w.short AS warehouse_short, w.region AS warehouse_region
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = ${id}
    LIMIT 1
  `)[0] as Record<string, unknown> | undefined;
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (effectiveRole(u) !== 'manager' && order.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  // The sheet is the PO as bought. A partial sale decrements `qty` and parks
  // the original in `qty_purchased`, so reading `qty` shrank the subtotal, the
  // fee basis and the projected profit with every sale — the same basis
  // lib/po-cost.ts and the goods-total mirror use.
  const lines = await sql`
    SELECT product_no, category, brand, capacity, generation, type, classification, rank, speed,
           interface, form_factor, description, item_type, part_number, chip_number, serial_number,
           condition, COALESCE(qty_purchased, qty) AS qty, health::float AS health, rpm,
           unit_cost::float AS unit_cost, sell_price::float AS sell_price
    FROM order_lines WHERE order_id = ${id} ORDER BY ${poLineOrder(sql, 'order_lines')}
  ` as unknown as Record<string, unknown>[];

  // Mirror the invoice's payment summary: subtotal is the sum of line costs;
  // total_cost may be a manual override (negotiated lot price), and other_fees
  // is charged on top of whichever of the two applies.
  const subtotal = +lines.reduce((s, l) => s + Number(l.qty ?? 0) * Number(l.unit_cost ?? 0), 0).toFixed(2);
  const totalQty = lines.reduce((s, l) => s + Number(l.qty ?? 0), 0);
  const otherFees = Number(order.other_fees ?? 0);

  // Same allocation rule as lib/po-cost.ts — keep the two in sync. Cost-weighted
  // share of the order-level fee, with a flat per-unit fallback for a free lot
  // (every unit_cost 0) so the fee can't silently disappear.
  const effUnitCost = (unitCost: number): number =>
    subtotal > 0 ? unitCost + (otherFees * unitCost) / subtotal
    : totalQty > 0 ? unitCost + otherFees / totalQty
    : unitCost;

  // Projected economics. The PO carries a manager-set `sell_price` per line (a
  // target, not a realized sale — the spreadsheet is purchaser-facing and a PO
  // has no sell-side data of its own). Profit/commission here are the projected
  // figures the purchaser sees on their dashboard; lines without a sell price
  // set simply don't contribute (left blank, no profit).
  const lineRows = lines.map((l) => {
    const qty = Number(l.qty ?? 0);
    const unitCost = Number(l.unit_cost ?? 0);
    const sellPrice = l.sell_price != null ? Number(l.sell_price) : null;
    return {
      no: l.product_no,
      ...lineSpecFields(l),
      // Read by categoryTabSheets to pick the sheet; not a declared column on
      // any of them, so it never renders.
      category: l.category,
      serial: String(l.serial_number ?? ''),
      qty,
      unitCost,
      lineTotal: +(qty * unitCost).toFixed(2),
      sellPrice,
      sellTotal: sellPrice != null ? +(qty * sellPrice).toFixed(2) : null,
      // unitCost / lineTotal stay raw — those columns are what was paid for the
      // goods, and the fee is disclosed on its own Payment row. Only profit
      // carries the fee share, per line rather than as one subtraction at the
      // bottom, so an unpriced line's share drops out the same way it does on
      // the dashboard.
      profit: sellPrice != null ? +(qty * (sellPrice - effUnitCost(unitCost))).toFixed(2) : null,
    };
  });

  // Derived from the LINES, so a legacy PO whose header disagrees with its sole
  // line still renders that line's columns.
  // Through sortCategories, not a bare indexOf: an unknown category scores -1
  // there and would sort ahead of RAM, so the workbook's tabs and the chips on
  // screen would disagree about the same order.
  const lineCats = sortCategories([...new Set(lines.map(l => exportCategory(l.category)))]);

  const goodsCost = order.total_cost != null ? +Number(order.total_cost).toFixed(2) : subtotal;
  const totalCost = +(goodsCost + otherFees).toFixed(2);
  const commissionRate = order.commission_rate != null ? Number(order.commission_rate) : null;
  const warehouse = [order.warehouse_short, order.warehouse_region].filter(Boolean).join(' — ');

  // Projected totals over priced lines, consistent with the purchaser dashboard
  // KPIs. Commission is the projected profit times the manager-set rate.
  const projectedRevenue = +lineRows.reduce((s, r) => s + (r.sellTotal ?? 0), 0).toFixed(2);
  const projectedProfit = +lineRows.reduce((s, r) => s + (r.profit ?? 0), 0).toFixed(2);
  const commissionAmount = commissionRate != null ? +(projectedProfit * commissionRate).toFixed(2) : null;

  const paymentRows = [
    { field: 'PO ID',                 value: String(order.id) },
    { field: 'Date',                  value: fmtTs(order.created_at).slice(0, 10) },
    { field: 'Status',                value: LIFECYCLE_LABEL[visibleLifecycle(String(order.lifecycle), effectiveRole(u))] ?? String(order.lifecycle) },
    { field: 'Buyer',                 value: String(order.user_name ?? '') },
    { field: 'Category',              value: lineCats.length > 1 ? lineCats.join(' · ') : String(order.category ?? '') },
    { field: 'Warehouse',             value: warehouse },
    { field: 'Payment method',        value: order.payment === 'self' ? 'Self pay' : 'Company pay' },
    { field: 'Total quantity',        value: totalQty },
    // Subtotal -> Other fees -> Total cost reads as an arithmetic column, which
    // is why the fee rows sit here rather than at the bottom.
    { field: 'Subtotal (product costs)', value: subtotal },
    { field: 'Other fees',            value: otherFees },
    { field: 'Other fees note',       value: String(order.other_fees_note ?? '') },
    { field: 'Total cost',            value: totalCost },
    { field: 'Projected sell value',  value: projectedRevenue },
    { field: 'Projected profit',      value: projectedProfit },
    { field: 'Commission rate',       value: commissionRate != null ? `${(commissionRate * 100).toFixed(2)}%` : '—' },
    { field: 'Commission amount',     value: commissionAmount != null ? commissionAmount : '—' },
    { field: 'Notes',                 value: String(order.notes ?? '') },
    { field: 'PayPal transaction ID', value: String(order.paypal_txn_id ?? '') },
  ];

  const buf = await buildXlsxWorkbook([
    { name: 'Payment', columns: PO_PAYMENT_COLS, rows: paymentRows },
    ...categoryTabSheets(lineRows, poLineCols, {
      singleSheetName: 'Products',
      emptySheetName: 'Products',
    }),
  ]);
  return xlsxResponse(buf, `${order.id}.xlsx`);
});

export default spreadsheetRoutes;
