// Worker bindings + shared API types.

export type Env = {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  JWT_SECRET: string;
  JWT_ISSUER?: string;
  STUB_OCR?: string;
  CF_ACCOUNT_ID?: string;
  CF_IMAGES_TOKEN?: string;
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
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
};

export type LineCategory = 'RAM' | 'SSD' | 'Other';

export type OrderLine = {
  id: string;
  orderId: string;
  category: LineCategory;
  brand: string | null;
  capacity: string | null;
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
