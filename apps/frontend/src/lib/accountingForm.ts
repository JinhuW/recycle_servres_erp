import {
  KIND_DEFAULT_DIRECTION, KIND_TARGET, isIsoDate,
  type AccountingCurrency, type AccountingDirection, type AccountingKind, type AccountingMethod, type IsoDate,
} from '@recycle-erp/shared';
import { BUSINESS_PAYER, type AcctEntry, type AcctEntryBody, type AcctTarget } from './accounting';

// The entry form both shells render: the state, the rules that move it, and
// the one place it turns into a request. One module so the desktop dialog and
// the phone sheet can't drift.

// A record named by its id, with whatever the opener knew about it.
export type FormTarget = Pick<AcctTarget, 'id'> & Partial<AcctTarget>;

export type EntryForm = {
  direction: AccountingDirection;
  // Once the manager flips it, a kind change no longer resets it.
  directionTouched: boolean;
  kind: AccountingKind;
  target: FormTarget | null;
  // Opened from a record's own page: the record is the point, not a field.
  targetLocked: boolean;
  amount: string;
  currency: AccountingCurrency;
  fxRate: string;
  method: AccountingMethod;
  occurredOn: IsoDate;
  // Who paid: a person's id, or BUSINESS_PAYER for the Business Account.
  managerId: string;
  // Once the manager picks a payer, a record's payer no longer moves it.
  managerTouched: boolean;
  counterparty: string;
  counterpartyTouched: boolean;
  reference: string;
  note: string;
};

export type EntryPreset = {
  kind: AccountingKind;
  target?: FormTarget;
  direction?: AccountingDirection;
  managerId?: string;
  amount?: number;
};

// The record's own payer, as the form picks it: the Business Account, the
// person, or nothing to say.
function payerOf(t: FormTarget | null | undefined): string | undefined {
  if (!t) return undefined;
  return t.payerBusiness ? BUSINESS_PAYER : t.payerId ?? undefined;
}

/**
 * When the PO settles Paid by itself: a bank row stands as the commission,
 * or the cost was paid from the company's account. Both are undone on the
 * PO, so the form shows the Business Account and will not move it.
 */
export function payerLock(kind: AccountingKind, t: FormTarget | null): 'linked' | 'company' | null {
  if (!t) return null;
  if (kind === 'commission' && t.commissionLinked) return 'linked';
  if (kind === 'purchase' && t.payment === 'company') return 'company';
  return null;
}

/** A self-paid cost names who paid in person: the Business Account is not offered. */
export const businessOffered = (kind: AccountingKind, t: FormTarget | null): boolean =>
  !(kind === 'purchase' && t?.payment === 'self');

export function initialForm(opts: { meId: string; today: IsoDate; preset?: EntryPreset; entry?: AcctEntry }): EntryForm {
  const { entry, preset } = opts;
  if (entry) {
    return {
      direction: entry.direction, directionTouched: true, kind: entry.kind,
      target: entry.target ? { id: entry.target.id } : null, targetLocked: false,
      amount: String(entry.amount), currency: entry.currency,
      fxRate: entry.fxRate === null ? '' : String(entry.fxRate),
      method: entry.method, occurredOn: entry.occurredOn,
      managerId: entry.manager?.id ?? BUSINESS_PAYER, managerTouched: true,
      counterparty: entry.counterparty ?? '', counterpartyTouched: true,
      reference: entry.reference ?? '', note: entry.note ?? '',
    };
  }
  const kind = preset?.kind ?? 'other';
  return {
    direction: preset?.direction ?? KIND_DEFAULT_DIRECTION[kind],
    directionTouched: preset?.direction !== undefined,
    kind,
    target: preset?.target ?? null,
    targetLocked: !!preset?.target,
    amount: preset?.amount ? String(preset.amount) : '',
    currency: 'CNY',
    fxRate: '',
    method: 'bank',
    occurredOn: opts.today,
    // The record's own payer when it names one (a PO's cost or commission
    // payer, the Business Account included), else the recorder. A pre-filled
    // person the picker does not list is swapped for the recorder by the hook.
    managerId: preset?.managerId ?? payerOf(preset?.target) ?? opts.meId,
    managerTouched: preset?.managerId !== undefined,
    counterparty: preset?.target?.party ?? '',
    counterpartyTouched: false,
    reference: '',
    note: '',
  };
}

export function applyKind(f: EntryForm, kind: AccountingKind): EntryForm {
  if (f.targetLocked || kind === f.kind) return f;
  const sameRecord = KIND_TARGET[kind] === KIND_TARGET[f.kind];
  const target = sameRecord ? f.target : null;
  return {
    ...f,
    kind,
    direction: f.directionTouched ? f.direction : KIND_DEFAULT_DIRECTION[kind],
    target,
    counterparty: sameRecord || f.counterpartyTouched ? f.counterparty : '',
    // The same PO read as a cost or a commission may settle Paid by differently.
    managerId: payerLock(kind, target) ? BUSINESS_PAYER : f.managerId,
  };
}

export function pickTarget(f: EntryForm, t: FormTarget | null): EntryForm {
  return {
    ...f,
    target: t,
    counterparty: f.counterpartyTouched ? f.counterparty : t?.party ?? '',
    // The record's payer, unless one was picked by hand (or the entry is
    // being edited, which counts as picked); a PO that settles it wins.
    managerId: payerLock(f.kind, t) ? BUSINESS_PAYER
      : f.managerTouched ? f.managerId : payerOf(t) ?? f.managerId,
  };
}

// The figure a dollar entry adds to the book, for the form's hint.
export function previewCny(f: EntryForm, latestRate: number | null): number | null {
  const amount = Number(f.amount);
  if (!f.amount || !Number.isFinite(amount) || amount <= 0) return null;
  if (f.currency === 'CNY') return amount;
  const rate = f.fxRate ? Number(f.fxRate) : latestRate;
  return rate && Number.isFinite(rate) && rate > 0 ? Math.round(amount * rate * 100) / 100 : null;
}

export type FormError =
  | 'acctErrAmount' | 'acctErrRate' | 'acctErrTarget' | 'acctErrDate' | 'acctErrManager';

/** The request the form stands for, or the i18n key of what is missing. */
export function toRequestBody(f: EntryForm, opts: { orphan?: boolean } = {}): { body: AcctEntryBody } | { error: FormError } {
  const amount = Number(f.amount);
  if (!f.amount.trim() || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    return { error: 'acctErrAmount' };
  }
  let fxRate: number | null = null;
  if (f.currency === 'USD' && f.fxRate.trim()) {
    fxRate = Number(f.fxRate);
    if (!Number.isFinite(fxRate) || fxRate <= 0 || fxRate > 100) return { error: 'acctErrRate' };
  }
  if (KIND_TARGET[f.kind] && !f.target && !opts.orphan) return { error: 'acctErrTarget' };
  if (!isIsoDate(f.occurredOn)) return { error: 'acctErrDate' };
  if (!f.managerId) return { error: 'acctErrManager' };
  const text = (s: string) => s.trim() || null;
  return {
    body: {
      direction: f.direction, kind: f.kind, amount: Math.round(amount * 100) / 100, currency: f.currency,
      fxRate, method: f.method, occurredOn: f.occurredOn,
      managerId: f.managerId === BUSINESS_PAYER ? null : f.managerId,
      targetId: KIND_TARGET[f.kind] ? f.target?.id ?? null : null,
      counterparty: text(f.counterparty), reference: text(f.reference), note: text(f.note),
    },
  };
}
