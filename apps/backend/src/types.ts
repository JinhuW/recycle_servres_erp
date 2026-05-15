// Worker bindings + shared API types.

export type Env = {
  DATABASE_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  JWT_SECRET: string;
  JWT_ISSUER?: string;
  STUB_LOW_CONF?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_OCR_MODEL?: string;
  CF_ACCOUNT_ID?: string;
  CF_IMAGES_TOKEN?: string;
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  // R2 bucket for sell-order status attachments (proof of shipment, invoices,
  // proof of payment). Optional — when absent, uploadAttachment returns a stub.
  R2_ATTACHMENTS?: {
    put(
      key: string,
      value: ArrayBuffer | ReadableStream,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<unknown>;
    delete(key: string): Promise<void>;
  };
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
