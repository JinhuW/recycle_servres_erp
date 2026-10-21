import {
  KIND_DEFAULT_DIRECTION, KIND_TARGET, isIsoDate,
  type AccountingCurrency, type AccountingDirection, type AccountingKind, type AccountingMethod, type IsoDate,
} from '@recycle-erp/shared';
import type { AcctEntry, AcctEntryBody, AcctTarget } from './accounting';

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
  managerId: string;
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

export function initialForm(opts: { meId: string; today: IsoDate; preset?: EntryPreset; entry?: AcctEntry }): EntryForm {
  const { entry, preset } = opts;
  if (entry) {
    return {
      direction: entry.direction, directionTouched: true, kind: entry.kind,
      target: entry.target ? { id: entry.target.id } : null, targetLocked: false,
      amount: String(entry.amount), currency: entry.currency,
      fxRate: entry.fxRate === null ? '' : String(entry.fxRate),
      method: entry.method, occurredOn: entry.occurredOn, managerId: entry.manager.id,
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
    managerId: preset?.managerId ?? opts.meId,
    counterparty: preset?.target?.party ?? '',
    counterpartyTouched: false,
    reference: '',
    note: '',
  };
}

export function applyKind(f: EntryForm, kind: AccountingKind): EntryForm {
  if (f.targetLocked || kind === f.kind) return f;
  const sameRecord = KIND_TARGET[kind] === KIND_TARGET[f.kind];
  return {
    ...f,
    kind,
    direction: f.directionTouched ? f.direction : KIND_DEFAULT_DIRECTION[kind],
    target: sameRecord ? f.target : null,
    counterparty: sameRecord || f.counterpartyTouched ? f.counterparty : '',
  };
}

export function pickTarget(f: EntryForm, t: FormTarget | null): EntryForm {
  return {
    ...f,
    target: t,
    counterparty: f.counterpartyTouched ? f.counterparty : t?.party ?? '',
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
      fxRate, method: f.method, occurredOn: f.occurredOn, managerId: f.managerId,
      targetId: KIND_TARGET[f.kind] ? f.target?.id ?? null : null,
      counterparty: text(f.counterparty), reference: text(f.reference), note: text(f.note),
    },
  };
}
