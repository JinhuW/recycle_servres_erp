// Types shared across the frontend, mirroring the backend Hono routes.

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
};

export type OrderLine = {
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
  serialNumber: string | null;
  chipNumber: string | null;
  condition: string;
  qty: number;
  unitCost: number;
  sellPrice: number | null;
  status: string;
  scanImageId: string | null;
  scanConfidence: number | null;
  scanImageUrl: string | null;
  position: number;
  health: number | null;
  rpm: number | null;
};

export type OrderSummary = {
  id: string;
  userId: string;
  userName: string;
  userInitials: string;
  commissionRate: number | null;
  category: Category;
  payment: 'company' | 'self';
  notes: string | null;
  lifecycle: string;
  archivedAt: string | null;
  createdAt: string;
  totalCost: number | null;
  warehouse: Warehouse | null;
  qty: number;
  revenue: number;
  profit: number;
  lineCount: number;
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

export type Order = OrderSummary & { lines: OrderLine[]; statusMeta?: OrderStatusMeta };

export type OrderEventKind =
  | 'submitted'
  | 'advanced'
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'status_meta_changed'
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

export type DashboardData = {
  role: Role;
  kpis: {
    count: number; cost: number; revenue: number; profit: number; commission: number;
    prev: { revenue: number; profit: number };
  };
  weeks: { label: string; profit: number }[];
  leaderboard: {
    id: string; name: string; initials: string; email: string; role: Role;
    count: number; revenue: number; profit: number; commission: number;
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
    profit: number;
    created_at: string;
    user_name: string;
    user_initials: string;
    user_id: string;
  }[];
};
