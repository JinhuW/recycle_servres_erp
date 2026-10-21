// Accounting: the managers' own book of money received and paid, kept in RMB.
// The vocabulary the backend route, the API client and both shells agree on.

export const ACCOUNTING_DIRECTIONS = ['in', 'out'] as const;
export type AccountingDirection = typeof ACCOUNTING_DIRECTIONS[number];

// Named after the record an entry is for. The link each one carries is
// KIND_TARGET; `other` is money that belongs to no record.
export const ACCOUNTING_KINDS = ['purchase', 'commission', 'sale', 'after_sales', 'other'] as const;
export type AccountingKind = typeof ACCOUNTING_KINDS[number];

export const ACCOUNTING_METHODS = ['bank', 'alipay', 'wechat', 'cash', 'other'] as const;
export type AccountingMethod = typeof ACCOUNTING_METHODS[number];

// RMB is the book's currency; a dollar entry carries the rate it was booked at.
export const ACCOUNTING_CURRENCIES = ['CNY', 'USD'] as const;
export type AccountingCurrency = typeof ACCOUNTING_CURRENCIES[number];

export type AccountingTargetType = 'po' | 'so' | 'as';

export const KIND_TARGET: Record<AccountingKind, AccountingTargetType | null> = {
  purchase: 'po',
  commission: 'po',
  sale: 'so',
  after_sales: 'as',
  other: null,
};

// What the money usually does for each kind. A refund is the same kind with
// the direction flipped, so this is a default, not a rule.
export const KIND_DEFAULT_DIRECTION: Record<AccountingKind, AccountingDirection> = {
  purchase: 'out',
  commission: 'out',
  sale: 'in',
  after_sales: 'out',
  other: 'out',
};

export const isAccountingKind = (v: unknown): v is AccountingKind =>
  typeof v === 'string' && (ACCOUNTING_KINDS as readonly string[]).includes(v);
export const isAccountingMethod = (v: unknown): v is AccountingMethod =>
  typeof v === 'string' && (ACCOUNTING_METHODS as readonly string[]).includes(v);
export const isAccountingDirection = (v: unknown): v is AccountingDirection =>
  typeof v === 'string' && (ACCOUNTING_DIRECTIONS as readonly string[]).includes(v);
export const isAccountingCurrency = (v: unknown): v is AccountingCurrency =>
  typeof v === 'string' && (ACCOUNTING_CURRENCIES as readonly string[]).includes(v);
