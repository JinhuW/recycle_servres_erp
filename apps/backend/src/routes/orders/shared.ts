// Helpers and types more than one orders route module uses.
import { getDb } from '../../db';
import { UUID_RE } from '../../lib/pagination';
import { LINE_FIELDS, type SqlLike } from '../../services/orderAudit';
import { type TrackablePart } from '../../lib/marketAutoTrack';
import { effectiveRole } from '../../lib/role';
import { specVal } from '../../lib/orderInput';
import { activeMember, type HandoffPackage } from '../../services/orderHandoff';
import { pickTrackingClient, carrierTrackingUrl } from '../../shipping';
import { registerPackageTracking } from '../../shipping/track';
import { synthesizePartNumber, chipMarkingCanon, normSellPrice, CARRIERS, PACKAGE_SOURCES, isValidTracking, normalizeTracking, type SerialIssue, type Carrier, type PackageSource } from '@recycle-erp/shared';
import { type Env, type LineCategory, type User } from '../../types';
import { normPaypalTxnId } from '../../ai/paypal';

export type OrdersEnv = { Bindings: Env; Variables: { user: User } };

// A typed/OCR part number always wins; otherwise fall back to a synthetic one
// (e.g. Mixed-brand SSDs the user left blank) so grouping/pricing has a stable
// key. Applied only at line creation — edits never rewrite an existing part
// number. Returns null when neither applies.
export function resolvePartNumber(
  category: string | undefined,
  l: { partNumber?: string | null; brand?: string | null; capacity?: string | null;
       interface?: string | null; formFactor?: string | null; generation?: string | null;
       speed?: string | null; rpm?: string | number | null },
): string | null {
  const typed = l.partNumber?.trim();
  if (typed) return typed;
  return synthesizePartNumber(category ?? '', l);
}

// Every write of chip_number goes through here (chipMarkingCanon has the rule;
// the brand decides whether a Micron marking is cut to its die code). `''`
// passes through untouched — PATCH uses it as the explicit "clear this field"
// sentinel, distinct from undefined/"keep".
export function canonChipNumber(v: string | null | undefined, brand: string | null | undefined): string | null {
  return v == null ? null : chipMarkingCanon(v, brand);
}

// "sell order SO-4056" / "sell orders SO-4056, SO-4057" for a committed-line
// refusal: the ids are what the manager needs to go and cancel.
export function describeSellOrders(ids: string[]): string {
  return `sell order${ids.length === 1 ? '' : 's'} ${ids.join(', ')}`;
}

// Which sell orders block is a manager's to see — every /api/sell-orders route
// 403s a purchaser — so a non-manager, a previewing manager included, gets
// their lines and a plain refusal. The archive conflict keeps its own richer,
// raw-role shape.
export function committedLinesBody(
  u: User, offendingLineIds: string[], sellOrderIds: string[], named: string, plain: string,
) {
  return effectiveRole(u) === 'manager'
    ? { error: named, offendingLineIds, sellOrderIds }
    : { error: plain, offendingLineIds };
}

// Serial rules (shared with the frontend forms via @recycle-erp/shared):
// DDR5 RAM must carry serials, and any entered serials must match qty.
// Enforced here too so no client can write a violating line.
export function serialErr(label: string, issue: SerialIssue): string {
  return issue.kind === 'ddr5Required'
    ? `${label}: DDR5 RAM products require serial numbers`
    : `${label}: serial number count (${issue.count}) must equal qty (${issue.qty})`;
}

// Every category a write touches must exist and be enabled. Checked per line
// rather than once per order — a PO may span categories — and only over the
// categories the request actually names, so a category disabled after the fact
// can't retro-block an unrelated edit to a legacy line.
export async function assertCategoriesEnabled(
  sql: ReturnType<typeof getDb>,
  cats: readonly string[],
): Promise<string | null> {
  const wanted = [...new Set(cats.filter(Boolean))];
  if (wanted.length === 0) return null;
  const rows = await sql<{ id: string; enabled: boolean }[]>`
    SELECT id, enabled FROM categories WHERE id = ANY(${wanted})
  `;
  const known = new Map(rows.map(r => [r.id, r.enabled]));
  for (const cat of wanted) {
    if (!known.has(cat)) return `unknown category: ${cat}`;
    if (!known.get(cat)) return `category ${cat} is disabled`;
  }
  return null;
}

// Managers may file a PO for another member (`onBehalfOfUserId`) — a manager
// as readily as a purchaser, since managers own the POs they file themselves.
// The raw role is checked — not effectiveRole — so a manager previewing as
// purchaser keeps the ability, and the target is validated up front so a
// typo'd id fails as a 400 rather than an FK 500. Returns the resolved owner
// or an error response.
export async function resolveOrderOwner(
  sql: ReturnType<typeof getDb>,
  u: User,
  onBehalfOfUserId: unknown,
): Promise<
  | { ownerId: string; ownerName: string | null; ownerDefaultWarehouseId: string | null }
  | { error: string; status: 400 | 403 }
> {
  if (onBehalfOfUserId === undefined || onBehalfOfUserId === null || onBehalfOfUserId === u.id) {
    return { ownerId: u.id, ownerName: null, ownerDefaultWarehouseId: u.defaultWarehouseId };
  }
  // The format gate matters, not just the lookup: users.id is uuid, so a
  // malformed string would make the SELECT itself 22P02 into a 500.
  if (typeof onBehalfOfUserId !== 'string'
    || !UUID_RE.test(onBehalfOfUserId)) {
    return { error: 'onBehalfOfUserId must be a user id', status: 400 };
  }
  if (u.role !== 'manager') {
    return { error: 'Only managers can create orders on behalf of someone else', status: 403 };
  }
  const rows = await sql<{ id: string; name: string; defaultWarehouseId: string | null }[]>`
    SELECT id, name, default_warehouse_id AS "defaultWarehouseId" FROM users
    WHERE id = ${onBehalfOfUserId} AND active = TRUE
    LIMIT 1
  `;
  if (!rows.length) {
    return { error: 'onBehalfOfUserId must name an active member', status: 400 };
  }
  return {
    ownerId: onBehalfOfUserId,
    ownerName: rows[0].name,
    ownerDefaultWarehouseId: rows[0].defaultWarehouseId,
  };
}

// A client that sends warehouseId at all must name a real warehouse — a form
// once sent "" before a destination was picked, which sailed past `?? null`
// into the FK and 500ed. Every endpoint that writes the column shares this
// boundary check.
export async function warehouseErr(
  sql: ReturnType<typeof getDb>,
  warehouseId: string | null,
): Promise<string | null> {
  if (warehouseId === null) return null;
  const wh = await sql<{ id: string }[]>`SELECT id FROM warehouses WHERE id = ${warehouseId} LIMIT 1`;
  return wh.length ? null : 'Unknown warehouse';
}

// Same boundary, for the client a PO was bought from. Without it a malformed
// uuid reaches the FK inside the transaction and surfaces as a 500 instead of
// the 400 the caller can act on — and a well-formed id belonging to someone
// else's book was simply accepted, which is how a PO ends up naming a client
// the purchaser was never allowed to see.
//
// Reads elsewhere are scoped with effectiveRole so a manager can preview as a
// purchaser; this is a write, so it consults u.role directly (lib/role.ts: the
// preview is a viewing convenience, not a permission demotion).
export async function supplierErr(
  sql: ReturnType<typeof getDb>,
  u: User,
  supplierId: string | null,
): Promise<string | null> {
  if (supplierId === null) return null;
  let rows: { owner_id: string | null }[];
  try {
    rows = await sql<{ owner_id: string | null }[]>`
      SELECT owner_id FROM suppliers WHERE id = ${supplierId}::uuid LIMIT 1
    `;
  } catch (e) {
    // Only 22P02 is the caller's fault. Swallowing everything else would turn a
    // dead pool into "Unknown client" — see the same idiom in warehouses.ts.
    if ((e as { code?: string }).code === PG_INVALID_TEXT_REPRESENTATION) return 'Unknown client';
    throw e;
  }
  if (rows.length === 0) return 'Unknown client';
  // A house-account client (owner_id null) is nobody's private book, so it stays
  // attachable by anyone; the 0114 backfill never produces one.
  const ownerId = rows[0]!.owner_id;
  if (u.role !== 'manager' && ownerId !== null && ownerId !== u.id) return 'Unknown client';
  return null;
}

export const PG_INVALID_TEXT_REPRESENTATION = '22P02';

// An `Other` line has no spec fields to identify it, so its type carries the
// whole answer to "what kind of thing is this?". Required alongside the
// description, and only for that category — the rest are self-describing.
//
// Brand is deliberately NOT required here even though both editors gate Confirm
// on it: the API has always accepted a line without one, and the scan and
// import paths rely on that. The rule that stops an order becoming unsaveable
// lives in lib/lineRequirements.ts, which both shells share.
export function identityErr(label: string, category: string | undefined, l: { itemType?: string | null }): string | null {
  if (category !== 'Other') return null;
  return (l.itemType ?? '').trim() ? null : `${label}: Other products require an item type`;
}

// Order-level fees, shared by POST / and PATCH /:id so the two can't drift.
// Rejected rather than clamped: other_fees carries a CHECK (>= 0), so a
// negative slipping through would surface as a 500 from inside the transaction
// instead of a 400 at the door. null means "clear" and must be excluded before
// Number.isFinite is asked anything, since Number(null) is 0.
export const FEE_NOTE_MAX = 280;

export function badFees(b: { otherFees?: unknown; otherFeesNote?: unknown }): string | null {
  if (b.otherFees !== undefined && b.otherFees !== null) {
    if (typeof b.otherFees !== 'number' || !Number.isFinite(b.otherFees) || b.otherFees < 0) {
      return 'otherFees must be a number >= 0';
    }
  }
  if (b.otherFeesNote !== undefined && b.otherFeesNote !== null) {
    if (typeof b.otherFeesNote !== 'string') return 'otherFeesNote must be a string or null';
    if (b.otherFeesNote.length > FEE_NOTE_MAX) {
      return `otherFeesNote must be ${FEE_NOTE_MAX} characters or fewer`;
    }
  }
  return null;
}

// Shared by PATCH and the hand-off, which each keep their own manager-only 403
// ahead of it. undefined leaves the rate alone, null clears it, and anything
// else is clamped into [0, 1] rather than refused.
export function parseCommissionRate(v: unknown): { rate: number | null | undefined } | { error: string } {
  if (v !== undefined && v !== null && !Number.isFinite(Number(v))) {
    return { error: 'commissionRate must be a number or null' };
  }
  return { rate: v === undefined ? undefined : v === null ? null : Math.min(1, Math.max(0, Number(v))) };
}

// '' means the user cleared the box — the edit forms echo every field back on
// save — so store NULL rather than an empty string.
export function normFeeNote(v: string | null | undefined): string | null {
  return v == null ? null : (v.trim() || null);
}

// Every proof rule on the way out of Draft keys on exactly these two values;
// a third would match none of them and skip them all.
export function isOrderPayment(v: unknown): v is 'company' | 'self' | undefined {
  return v === undefined || v === 'company' || v === 'self';
}

// Absent and null both mean "not said"; only a third value is a bad request.
export function isPaymentMethod(v: unknown): v is 'paypal' | 'cash' | null | undefined {
  return v === undefined || v === null || v === 'paypal' || v === 'cash';
}

// The hand-off facts, validated the same way whichever door writes them —
// the checkpoint (POST /handoff) or the page (PATCH). Each returns the 400
// message or null.
export function sourceErr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return PACKAGE_SOURCES.includes(v as PackageSource) ? null : 'source must be facebook, local, reddit, or other';
}

// Same boundary as POST /api/packages: the unique index is what keeps one row
// per box, so the number must collide there, not mint a twin.
export function trackingErr(tn: string, carrier: unknown): string | null {
  if (tn.length < 8) return 'A tracking number is required';
  if (!isValidTracking(tn)) return 'A tracking number is letters and digits, at most 30 characters';
  if (!CARRIERS.includes(carrier as Carrier)) return 'carrier must be UPS, FedEx, or USPS';
  return null;
}

export async function handoffByErr(
  sql: SqlLike, v: unknown,
): Promise<{ member: { id: string; name: string } } | { error: string }> {
  if (typeof v !== 'string' || !UUID_RE.test(v)) return { error: 'handoff.byUserId must be a user id' };
  const member = await activeMember(sql, v);
  return member ? { member } : { error: 'handoff.byUserId must name an active member' };
}

export function trackingTakenMsg(otherOrderId: string | null): string {
  return otherOrderId
    ? `This tracking number is already being tracked on ${otherOrderId}`
    : 'This tracking number is already being tracked';
}
export const TRACKING_TAKEN_STANDALONE_MSG =
  'This tracking number is already on the Shipping page under another member — ask a manager to link it.';
export const PACKAGE_DELIVERED_MSG =
  "This order's box has already been delivered — its delivery can't be changed.";

// Detached on purpose, as POST /api/packages does: the row is committed and
// the registration carries its own timeout; the sweep covers what this misses.
// Only a box Shippo isn't pushing for yet — a re-typed number, a fresh row —
// is worth the call; the same number again is already registered.
export function registerIfNeeded(
  env: Env, sql: ReturnType<typeof getDb>, pkg: HandoffPackage | null, needsRegister: boolean,
): void {
  if (!pkg || !needsRegister) return;
  const tracking = pickTrackingClient(env);
  if (tracking.register) void registerPackageTracking(sql, tracking.register, pkg);
}

// A `reverted` event stays pending until a `revert_ack` names its id. A
// timestamp watermark loses any revert whose PATCH commits after the ack:
// order_events.created_at is transaction-START time, and the ack cannot see
// the still-uncommitted row it would need to cover. Acks written before this
// carried no ids and keep falling back to the timestamp.
export function unackedRevertFrag(sql: SqlLike, id: string) {
  return sql`
    NOT EXISTS (
      SELECT 1 FROM order_events a
      WHERE a.order_id = ${id} AND a.kind = 'revert_ack'
        AND (a.detail->'ackedIds' @> to_jsonb(e.id::text)
             OR (a.detail->'ackedIds' IS NULL AND a.created_at > e.created_at))
    )`;
}

// The box the hand-off's label path inserted, for the list's In Transit chip
// and the PO page. Newest wins when a manager re-added one; the id tiebreaker
// keeps every field on the same row. A SELECT-list subquery rather than a
// LATERAL: the planner postpones it past the sort and LIMIT, so it runs once
// per returned row instead of once per filtered one, and it stays out of the
// list's GROUP BY.
export function newestPackageJson(sql: SqlLike) {
  return sql`
    (SELECT json_build_object(
       'id', p.id, 'carrier', p.carrier, 'trackingNumber', p.tracking_number,
       'status', p.status, 'trackingStatus', p.tracking_status,
       'trackingEta', p.tracking_eta, 'lastTrackedAt', p.last_tracked_at,
       'source', p.source)
     FROM packages p WHERE p.order_id = o.id
     ORDER BY p.created_at DESC, p.id DESC LIMIT 1)`;
}
export type PackageJson = {
  id: string; carrier: string; trackingNumber: string; status: string;
  trackingStatus: string | null; trackingEta: string | null; lastTrackedAt: string | null;
  source: string | null;
};
export const packageFromJson = (p: PackageJson | null) => p && {
  ...p, trackingUrl: carrierTrackingUrl(p.carrier, p.trackingNumber),
};

// The columns the audit diffs a line on, read the same way before and after a
// PATCH writes it. NUMERIC is cast to float so the diff compares numbers, not
// "120.00" string forms.
export function lineAuditCols(sql: SqlLike) {
  return sql`
    id, product_no, status, qty, category, brand, capacity, type, generation, classification,
    rank, speed, interface, form_factor, description, item_type, part_number,
    serial_number, chip_number, condition, rpm,
    unit_cost::float AS unit_cost,
    sell_price::float AS sell_price,
    health::float AS health`;
}

// A line as the added / removed / reverted events snapshot it.
export type LineSnapRow = {
  id: string; product_no: number; category: string; part_number: string | null; qty: number; unit_cost: number;
};

export function lineSnapshot(r: LineSnapRow) {
  return {
    lineId: r.id,
    no: r.product_no,
    category: r.category,
    partNumber: r.part_number,
    qty: r.qty,
    unitCost: r.unit_cost,
  };
}

export type LineFields = {
  // Editable: a line filed under the wrong category is corrected in place
  // rather than deleted and retyped. Switching clears the spec fields the old
  // category owned — see staleSpecDbCols.
  category?: LineCategory;
  sellPrice?: number | null;
  qty?: number;
  unitCost?: number;
  brand?: string | null;
  capacity?: string | null;
  type?: string | null;
  generation?: string | null;
  classification?: string | null;
  rank?: string | null;
  speed?: string | null;
  interface?: string | null;
  formFactor?: string | null;
  description?: string | null;
  itemType?: string | null;
  partNumber?: string | null;
  serialNumber?: string | null;
  chipNumber?: string | null;
  condition?: string;
  health?: number | null;
  rpm?: number | null;
  scanImageId?: string | null;
  scanConfidence?: number | null;
};
export type LinePatch = LineFields & { id: string };
export type LineInput = LineFields & { qty: number; unitCost: number };

// One new order_lines row for a multi-row insert. POST and PATCH's addLines
// differ only in the defaults they hand in. Optional fields are nulled here
// because postgres.js refuses an undefined value; qty and unit cost are passed
// through as each route has always sent them.
export function newLineRow(
  orderId: string,
  cat: string,
  l: LineFields,
  d: { qty: number | undefined; unitCost: number | undefined; status: string; position: number },
) {
  return {
    order_id: orderId, category: cat,
    brand: l.brand ?? null, capacity: l.capacity ?? null, generation: l.generation ?? null,
    type: l.type ?? null, classification: l.classification ?? null, rank: l.rank ?? null,
    speed: l.speed ?? null, interface: l.interface ?? null, form_factor: l.formFactor ?? null,
    description: l.description ?? null, item_type: l.itemType?.trim() || null,
    part_number: resolvePartNumber(cat, l), serial_number: l.serialNumber ?? null,
    chip_number: canonChipNumber(l.chipNumber, l.brand), condition: l.condition ?? 'Pulled — Tested',
    qty: d.qty, unit_cost: d.unitCost, sell_price: normSellPrice(l.sellPrice), status: d.status,
    scan_image_id: l.scanImageId ?? null, scan_confidence: l.scanConfidence ?? null,
    position: d.position, health: l.health ?? null, rpm: l.rpm ?? null,
  };
}

// What market tracking learns from a line as it is created.
export function trackInput(l: LineFields, cat: string): TrackablePart {
  return {
    category: cat,
    partNumber: resolvePartNumber(cat, l),
    brand: l.brand,
    capacity: l.capacity,
    type: l.type,
    classification: l.classification,
    rank: l.rank,
    speed: l.speed,
    interface: l.interface,
    formFactor: l.formFactor,
    description: l.description,
    health: l.health,
    rpm: l.rpm,
  };
}

// `materialEdit` below says the request *carries* a field the manager review is
// about. These say it actually *changes* one, compared under the same
// normalisations the UPDATE writes with — so a purchaser re-saving a line
// untouched, or a queued autosave replaying, never drops a submitted order back
// to Draft and hands a manager an empty change set to review.
export function sameStoredValue(before: unknown, after: unknown): boolean {
  const blank = (v: unknown) => v === null || v === undefined || v === '';
  if (typeof before === 'number' || typeof after === 'number') {
    if (blank(before) || blank(after)) return blank(before) && blank(after);
    const a = Number(before);
    const b = Number(after);
    // NUMERIC columns arrive as floats, and a client that rounds one for
    // display sends back a value that differs only in the last bits.
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
  }
  return JSON.stringify(blank(before) ? null : before) === JSON.stringify(blank(after) ? null : after);
}

export const LINE_FIELD_SET: ReadonlySet<string> = new Set(LINE_FIELDS);
// The line columns PATCH writes with a presence sentinel (null clears), not
// COALESCE (null keeps) — must match the UPDATE in PATCH /:id.
export const LINE_SPEC_TEXT_COLS: ReadonlySet<string> = new Set([
  'brand', 'capacity', 'type', 'generation', 'classification', 'rank', 'speed',
  'interface', 'form_factor', 'description', 'item_type',
]);
export const LINE_SENTINEL_COLS: ReadonlySet<string> = new Set([
  ...LINE_SPEC_TEXT_COLS, 'chip_number', 'health', 'rpm', 'sell_price',
]);

// The hand-off facts a PATCH may write, in their after-state: the collector
// is NULLed unless the method is (or becomes) pickup, the way payment_method
// is NULLed on self — so a method flip is judged and written the same way.
export type HandoffFactsBefore = {
  source: string | null; handoff_method: string | null; handoff_by: string | null;
  pkg: { trackingNumber: string; carrier: string } | null;
};
export function handoffFactsAfter(
  body: { source?: string | null; handoffMethod?: 'pickup' | 'label' | null; handoffBy?: string | null },
  before: HandoffFactsBefore,
) {
  const method = body.handoffMethod === undefined ? before.handoff_method : body.handoffMethod;
  const by = method !== 'pickup' ? null
    : body.handoffBy === undefined ? before.handoff_by : body.handoffBy;
  return { method, by };
}

export function changesMaterialField(
  body: {
    lines?: LinePatch[]; addLines?: unknown[]; removeLineIds?: string[];
    totalCost?: number | null; otherFees?: number | null; otherFeesNote?: string | null;
    warehouseId?: string | null; payment?: string; paymentMethod?: string | null;
    paypalTxnId?: string | null;
    source?: string | null; handoffMethod?: 'pickup' | 'label' | null; handoffBy?: string | null;
    trackingNumber?: string; carrier?: string;
  },
  before: Record<string, unknown> & HandoffFactsBefore,
  linesBefore: Map<string, Record<string, unknown>>,
): boolean {
  if (body.addLines?.length) return true;
  // Ids this order no longer holds delete nothing — the DELETE is keyed off the
  // rows it finds, not off the request's list.
  if (body.removeLineIds?.some(lineId => linesBefore.has(lineId))) return true;

  for (const patch of body.lines ?? []) {
    const row = linesBefore.get(patch.id);
    if (!row) continue;
    // A chip lands by the brand the row ends up with, as the UPDATE writes it.
    const brandAfter = patch.brand !== undefined ? specVal(patch.brand) : (row.brand as string | null);
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id') continue;
      const col = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
      // Anything outside LINE_FIELDS is not part of the record a manager
      // reviews (scan refs, positions) and does not cost the order its stage.
      if (!LINE_FIELD_SET.has(col)) continue;
      // Judged on what the UPDATE will store, not on what was sent: a null on
      // a COALESCE column keeps it, and a sentinel field lands normalised.
      // Comparing the raw value read an echoed null as a change and sent the
      // order back to Draft for an edit that never landed.
      if (!LINE_SENTINEL_COLS.has(col) && value == null) continue;
      const landed = col === 'chip_number' ? (canonChipNumber(value as string | null, brandAfter) || null)
        : col === 'sell_price' ? normSellPrice(value as number | null)
        : LINE_SPEC_TEXT_COLS.has(col) ? specVal(value as string | null)
        : value;
      if (!sameStoredValue(row[col], landed)) return true;
    }
  }

  // Only a positive figure is a stated goods total; anything else is "not
  // stated" and writes nothing. Same reading as the UPDATE below.
  if (body.totalCost !== undefined && Number(body.totalCost) > 0
      && !sameStoredValue(before.total_cost, Number(body.totalCost))) return true;
  if (body.otherFees !== undefined
      && !sameStoredValue(before.other_fees, Number(body.otherFees ?? 0))) return true;
  if (body.otherFeesNote !== undefined
      && !sameStoredValue(before.other_fees_note, normFeeNote(body.otherFeesNote))) return true;
  if (body.warehouseId !== undefined
      && !sameStoredValue(before.warehouse_id, body.warehouseId)) return true;
  if (body.payment !== undefined && body.payment !== before.payment) return true;
  if (body.paymentMethod !== undefined
      && !sameStoredValue(before.payment_method, body.paymentMethod)) return true;
  if (body.paypalTxnId !== undefined) {
    if (!sameStoredValue(before.paypal_txn_id, normPaypalTxnId(body.paypalTxnId))) return true;
  }
  if (body.source !== undefined && !sameStoredValue(before.source, body.source)) return true;
  if (body.handoffMethod !== undefined || body.handoffBy !== undefined) {
    const after = handoffFactsAfter(body, before);
    if (!sameStoredValue(before.handoff_method, after.method)) return true;
    if (!sameStoredValue(before.handoff_by, after.by)) return true;
  }
  if (body.trackingNumber !== undefined) {
    const tn = normalizeTracking(body.trackingNumber);
    if (!sameStoredValue(before.pkg?.trackingNumber ?? null, tn)) return true;
    if (!sameStoredValue(before.pkg?.carrier ?? null, body.carrier ?? null)) return true;
  }
  // A flip away from label parts with the box; that is a change even when
  // nothing else in the body is.
  if (body.handoffMethod !== undefined && body.handoffMethod !== 'label'
      && before.handoff_method === 'label' && before.pkg) return true;
  return false;
}

// The stored shape PATCH reads before writing: enough to merge a patch against
// (category/serial/item-type/spec rules) and to tell a synthetic part number
// from a typed one when a line changes category.
export type StoredLine = {
  id: string;
  product_no: number;
  category: string | null;
  generation: string | null;
  qty: number;
  serial_number: string | null;
  item_type: string | null;
  part_number: string | null;
  chip_number: string | null;
  brand: string | null;
  capacity: string | null;
  interface: string | null;
  form_factor: string | null;
  speed: string | null;
  rpm: number | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
};
export function storedLineCols(sql: SqlLike) {
  return sql`
    id, product_no, category, generation, qty, serial_number, item_type, part_number,
    chip_number, brand, capacity, interface, form_factor, speed, rpm, type, classification, rank`;
}
