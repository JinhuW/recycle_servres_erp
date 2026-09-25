// Types shared across the frontend, mirroring the backend Hono routes.

// LinePhoto is declared next to the accessor that reads it, and re-exported
// here because OrderLine carries one.
import type { LinePhoto } from './linePhotos';
import type { PackageSource } from './packageSource';
import type { TrackedPackage } from './packages';
export type { LinePhoto };

export type Role = 'manager' | 'purchaser';
export type Lang = 'en' | 'zh';
export type Category = 'RAM' | 'SSD' | 'HDD' | 'Other';

export type User = {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: Role;
  team: string | null;
  language: Lang;
  defaultWarehouseId?: string | null;
  preferences?: Record<string, unknown>;
};

export type Warehouse = {
  id: string;
  name?: string;
  short: string;
  region: string;
  address?: string | null;
  managerUserId?: string | null;  // FK → users.id (the managing user)
  manager?: string | null;        // derived: users.name  (read-only)
  managerPhone?: string | null;   // derived: users.phone (read-only)
  managerEmail?: string | null;   // derived: users.email (read-only)
  timezone?: string | null;
  active?: boolean; // false = archived: hidden from every UI surface (DB row kept)
  // Structured ship-to address. `address` is the display line derived from
  // these on the server.
  shipContactName?: string | null;
  shipPhone?: string | null;
  shipStreet1?: string | null;
  shipStreet2?: string | null;
  shipCity?: string | null;
  shipState?: string | null;
  shipZip?: string | null;
  shipCountry?: string | null;
};

export type OrderLine = {
  // Merged AI-scan + uploaded photos. Read it through lib/linePhotos, which
  // also synthesizes the scan entry for payloads that predate this field.
  photos?: LinePhoto[];
  id: string;
  category: Category;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  formFactor: string | null;
  description: string | null;
  itemType: string | null;
  partNumber: string | null;
  serialNumber: string | null;
  chipNumber: string | null;
  condition: string;
  qty: number;
  unitCost: number;
  sellPrice: number | null;
  // What the units actually sold for: the qty-weighted unit price over Done
  // sell orders naming this line, and how many units that covers (a partial
  // sale leaves the remainder in `qty`). Null when nothing has sold; absent
  // when the caller is not a manager. Optional for deploy skew too, like
  // `linkedPaid`.
  finalSellPrice?: number | null;
  finalSoldQty?: number | null;
  status: string;
  scanImageId: string | null;
  scanConfidence: number | null;
  scanImageUrl: string | null;
  position: number;
  health: number | null;
  rpm: number | null;
};

// What a PO's units earned on Done sell orders, net of the commission paid
// to the purchaser. `soldQty` of `boughtQty` says how much of the PO it
// covers. Managers only; null until something has sold.
export type OrderRealized = {
  soldQty: number;
  boughtQty: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  commission: number;
  profit: number;
};

export type OrderSummary = {
  id: string;
  userId: string;
  userName: string;
  userInitials: string;
  commissionRate: number | null;
  // Absent for non-managers (and for deploy skew, like `linkedPaid`); null
  // for a PO nothing has sold from.
  realized?: OrderRealized | null;
  // Derived from the lines: the sole category when they agree, 'Mixed' when
  // they don't. Widened from `Category` for that reason — render chips from
  // `categories` rather than switching on this.
  category: string;
  // Every category the order's lines hold, in display order. Empty on a draft
  // with no lines yet.
  categories: Category[];
  payment: 'company' | 'self';
  notes: string | null;
  lifecycle: string;
  archivedAt: string | null;
  createdAt: string;
  // The goods cost — a negotiated override of the line subtotal, or null for
  // none. `otherFees` is charged on top of it, never folded into it.
  totalCost: number | null;
  otherFees: number;
  otherFeesNote: string | null;
  // PayPal payment reference, seeded from the tracked package's screenshot
  // scan when the PO is minted from one; manager-editable after submission.
  paypalTxnId: string | null;
  // Whether this PO must name its transaction before it can leave Draft — the
  // server decides, because the rule's cutoff lives in the DB. Optional: the
  // Worker and Railway deploy independently, so a frontend that ships first
  // sees it undefined and must read that as "not required". The backend's 409
  // is the real gate either way.
  txnRequired?: boolean;
  // The self-paid twin of `txnRequired`: whether the chat with the seller
  // (a Submission attachment) must be on file before the PO leaves Draft.
  chatShotRequired?: boolean;
  // The cash twin: whether a screenshot of the amount paid (a Payment
  // attachment) must be on file before a company-cash PO leaves Draft.
  cashShotRequired?: boolean;
  // Everything still between a Draft and In Transit, in display order, as the
  // server's own advance would refuse it (`noCost`, `missingSource`,
  // `missingDelivery`, `missingTracking`, `missingMethod`, `missingTxnId`,
  // `unknownTxnId`, `missingChatShot`, `missingCashShot`). Empty past Draft.
  // Optional for the deploy-skew reason above — undefined means "judge from
  // the form"; see lib/poReadiness.ts.
  blockers?: string[];
  // The hand-off facts — where the goods came from, how they travel, who
  // collected them. Written by the In Transit checkpoint and editable on the
  // page until Ready to Pay. All optional for the deploy-skew reason above;
  // null on orders that predate it.
  source?: PackageSource | null;
  paymentMethod?: 'paypal' | 'cash' | null;
  handoffMethod?: 'pickup' | 'label' | null;
  handoffBy?: { id: string; name: string } | null;
  // The hand-off's package — what the In Transit chip links. Only the list
  // endpoint reports it; null on a pickup or a pre-hand-off order.
  tracking?: PackageTracking | null;
  // The dashboard's goods figure: the stored total, else the line sum. Optional
  // for the deploy-skew reason above.
  goodsTotal?: number;
  // Net of the bank payments linked to this PO on the Payments page (refunds
  // subtract, failed/reversed excluded) — the ledger's "Net paid". Null when
  // nothing is linked; absent altogether for a non-manager. Either way there
  // is no link to draw. Optional for the same deploy-skew reason as `txnRequired`.
  linkedPaid?: number | null;
  warehouse: Warehouse | null;
  qty: number;
  // Priced lines only — an unpriced line contributes no revenue and no margin,
  // while `otherFees` is subtracted whole. Profit can therefore be negative on
  // a PO nobody has priced yet; `unpricedLineCount` is what explains it.
  revenue: number;
  profit: number;
  lineCount: number;
  // Only the list endpoint reports it; absent on an order read on its own.
  unpricedLineCount?: number;
  status: string;
};

// Per-status evidence (note + attachments) — only the detail endpoint
// returns it, and currently only for 'Done'.
export type OrderStatusMeta = Record<string, {
  note: string | null;
  when: string;
  attachments: {
    id: string; filename: string; size: number; mime: string; url: string; uploadedAt: string;
  }[];
}>;

// The newest package linked to a PO, as the PO page reads it: the tracked
// package's own fields plus the carrier's words for the last scan. Null
// until Shippo's first update.
export type OrderPackage =
  Pick<TrackedPackage, 'id' | 'carrier' | 'trackingNumber' | 'trackingUrl' | 'status' | 'trackingEta' | 'lastTrackedAt'>
  & { trackingStatus: string | null; source?: PackageSource | null };

// The list's slice of it. `status` and `trackingEta` arrived later than the
// first three and are optional for the deploy-skew reason.
export type PackageTracking =
  Pick<OrderPackage, 'carrier' | 'trackingNumber' | 'trackingUrl'>
  & Partial<Pick<OrderPackage, 'status' | 'trackingEta'>>;

// The per-order aggregates are computed by the list query's GROUP BY; reading
// one order on its own returns the lines themselves and none of the rollups,
// so they are dropped here rather than left declared and absent at runtime.
export type Order =
  Omit<OrderSummary, 'lineCount' | 'qty' | 'revenue' | 'profit'>
  & {
    lines: OrderLine[]; statusMeta?: OrderStatusMeta;
    // The newest package linked to the PO; optional for the deploy-skew reason.
    package?: OrderPackage | null;
    // Managers only — absent for everyone else: the purchaser's changes since
    // the last time a manager acknowledged them.
    pendingRevert?: PendingRevert[] | null;
    // An order sent back to Draft by an edit is a draft that has already been
    // submitted — deletable only while this is false.
    everSubmitted?: boolean;
    // Managers only — absent for everyone else: the Done sell orders that
    // sold this PO's units, with the units each took.
    sellOrders?: { id: string; customer: string; qty: number }[] | null;
  };

export type RevertLineSnapshot = {
  lineId: string;
  category?: string | null;
  partNumber: string | null;
  qty: number;
  unitCost: number;
};

export type RevertChangeSet = {
  from: string;
  to: string;
  fields: OrderEventChange[];
  lines: {
    added: RevertLineSnapshot[];
    removed: RevertLineSnapshot[];
    edited: { lineId: string; partNumber: string | null; changes: OrderEventChange[] }[];
  };
};

export type PendingRevert = {
  id: string;
  createdAt: string;
  actor: { id: string; name: string; initials: string } | null;
  detail: RevertChangeSet;
};

export type OrderEventKind =
  | 'created'
  | 'submitted'
  | 'advanced'
  | 'reverted'
  | 'revert_ack'
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'handoff'
  | 'owner_changed'
  | 'status_meta_changed'
  | 'line_photo_added'
  | 'line_photo_removed'
  | 'archived'
  | 'unarchived';

export type OrderEventChange = { field: string; from: unknown; to: unknown };

export type OrderEvent = {
  id: string;
  kind: OrderEventKind;
  actor: { id: string; name: string; initials: string } | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export type SellOrderEventKind =
  | 'created'
  | 'status_changed'
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'price_adjusted'
  | 'status_meta_changed'
  | 'archived'
  | 'unarchived'
  | 'closed'
  | 'reopened';

export type SellOrderEvent = {
  id: string;
  kind: SellOrderEventKind;
  detail: Record<string, unknown>;
  createdAt: string;
  actor: { id: string; name: string; initials: string } | null;
};

export type DraftLine = {
  id?: string;
  /** Stable client-side key for React lists; never sent to the API. */
  _cid?: string;
  category: Category;
  brand?: string | null;
  capacity?: string | null;
  generation?: string | null;
  type?: string | null;
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
  qty: number;
  unitCost: number;
  sellPrice?: number | null;
  scanImageId?: string | null;
  scanConfidence?: number | null;
  scanImageUrl?: string | null;
  health?: number | null;
  rpm?: number | null;
  // UI label for cards
  label?: string;
  // Set to true once this line has been persisted to the server-side draft;
  // prevents double-insert on final submit.
  _confirmed?: boolean;
};

export type ScanResponse = {
  imageId: string;
  deliveryUrl: string;
  extracted: Record<string, string>;
  confidence: number;
  provider: 'stub' | 'openrouter';
};

export type RefPrice = {
  id: string;
  category: Category;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  formFactor: string | null;
  description: string | null;
  partNumber: string | null;
  label: string;
  sub: string | null;
  target: number | null;
  low: number | null;
  high: number | null;
  avgSell: number | null;
  trend: number;
  samples: number;
  source: string | null;
  stock: number;
  demand: 'high' | 'medium' | 'low';
  history: number[];
  updatedAt: string;
  maxBuy: number | null;
  health: number | null;
  rpm: number | null;
  internalSales: { avgPrice: number | null; samples: number };
  lastPrice: number | null;
  lastPriceAt: string | null;
  lastPriceSource: string | null;
  recentPrices: { ts: string; price: number }[];
};

export type Notification = {
  id: string;
  kind: string;
  tone: 'pos' | 'info' | 'accent' | 'warn' | 'muted';
  icon: string;
  title: string;
  body: string;
  unread: boolean;
  time: string;
};

// The leaderboard's ranking metric, sent as `?lb=` — the server sorts because
// a purchaser cannot see the peer figures it would take to sort locally.
export type LeaderboardSort = 'cost' | 'commission';

import type { Bucket, RangePreset, IsoDate } from '@recycle-erp/shared';
export type { Bucket, RangePreset, IsoDate };

// Who drove a dashboard figure in the window, one grouping at a time. `rows`
// is every contributor, largest first — the card scrolls rather than folding
// a tail. A null id is the unattributed row (a PO with no supplier). Which dimensions come back depends on the lens: a purchaser
// never receives a purchaser or customer grouping.
export type ContribDim = 'supplier' | 'purchaser' | 'customer' | 'category';
export type ContribMetric = 'cost' | 'revenue' | 'profit';
export type ContribRow = { id: string | null; name: string | null; amount: number; count: number };
export type ContribRows = { rows: ContribRow[] };
export type ContribMetricData = {
  total: number;
  count: number;
  byDim: Partial<Record<ContribDim, ContribRows>>;
};

export type DashboardData = {
  role: Role;
  kpis: {
    count: number; cost: number; revenue: number; profit: number; commission: number;
    prev: { revenue: number; profit: number };
  };
  // The window every figure below was computed over — calendar dates in the
  // business time zone — and the bucket the series is cut in.
  window: {
    from: string; to: string; prevFrom: string; prevTo: string;
    bucket: Bucket; bucketAuto: boolean; tz: string;
  };
  // The first day there is anything to report; the range strip's left edge.
  bounds: { first: string | null };
  // Sales in, spend out, and the gross profit on what sold, per bucket. Each
  // bucket holds only the window's rows, so the series sums to the tiles.
  series: { start: string; revenue: number; cost: number; profit: number }[];
  contrib: Record<ContribMetric, ContribMetricData>;
  // Money fields (and email) are absent — not null — on every row but the
  // caller's own for a purchaser (PRD §6.8); a manager sees them all.
  leaderboard: {
    id: string; name: string; initials: string; email?: string | null; role: Role;
    count: number;
    cost?: number | null; revenue?: number | null; profit?: number | null; commission?: number | null;
  }[];
  byCat: Record<Category, { count: number; revenue: number; profit: number }>;
  recent: {
    id: string;
    category: Category;
    brand: string | null;
    capacity: string | null;
    generation: string | null;
    type: string | null;
    interface: string | null;
    description: string | null;
    rpm: number | null;
    health: number | null;
    qty: number;
    unit_cost?: number;
    sell_price: number | null;
    // null, not 0, on a line nobody has priced — the KPI tiles above the strip
    // never counted it, so a row stating $0 margin would answer one question
    // two ways. Render it as an em-dash.
    profit: number | null;
    created_at: string;
    user_name: string;
    user_initials: string;
    user_id: string;
  }[];
};
