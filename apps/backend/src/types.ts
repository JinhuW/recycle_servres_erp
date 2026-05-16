// App configuration, built from process.env (see src/env.ts). Passed to the
// Hono app as `Bindings` so existing `c.env` / getDb(c.env) call sites work
// unchanged.

export type Env = {
  DATABASE_URL?: string;
  JWT_SECRET: string;
  JWT_ISSUER?: string;
  STUB_LOW_CONF?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_OCR_MODEL?: string;
  // Cloudflare R2 via its S3-compatible API. When any of endpoint / key /
  // secret / bucket is missing, uploadAttachment returns a stub (dev/tests).
  R2_S3_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_ATTACHMENTS_PUBLIC_URL?: string;
};

export type Role = 'manager' | 'purchaser';

export type User = {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: Role;
  team: string | null;
  language: 'en' | 'zh';
  preferences: Record<string, unknown>;
};

export type LineCategory = 'RAM' | 'SSD' | 'HDD' | 'Other';

export type OrderLine = {
  id: string;
  orderId: string;
  category: LineCategory;
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
  condition: string;
  qty: number;
  unitCost: number;
  sellPrice: number | null;
  status: string;
  scanImageId: string | null;
  scanConfidence: number | null;
  position: number;
  health: number | null;
  rpm: number | null;
};

export type Order = {
  id: string;
  userId: string;
  userName: string;
  userInitials: string;
  category: LineCategory;
  warehouse: { id: string; short: string; region: string } | null;
  payment: 'company' | 'self';
  notes: string | null;
  totalCost: number;
  lifecycle: string;
  createdAt: string;
  lines: OrderLine[];
  // derived
  qty: number;
  revenue: number;
  profit: number;
  status: string;
};
