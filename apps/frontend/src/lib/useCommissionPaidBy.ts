import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';
import type { Translate } from './orderPresentation';
import type { CommissionPayer } from './types';

// Who paid the purchaser their commission, a manager or the company, behind
// the desktop Commission tab, the phone fold and the PO list's Paid by cell.
// Not part of the page's draft and Save: the commission is paid once the PO is
// a closed book, where Save is off, so a pick goes straight to the server, as
// the commission screenshot does. Nothing reads as saved before the server
// says so — a failed write leaves the select on the record.

export type PaidBy = CommissionPayer | null;

// The select's value for the company: not a user id, so it cannot be one.
export const PAID_BY_COMPANY = 'company';

// The select's value for a record, '' for none. Checks for the company rather
// than the manager: an older backend sends a manager without `kind`.
export function paidByValue(p: PaidBy): string {
  if (!p) return '';
  return p.kind === 'company' ? PAID_BY_COMPANY : p.id;
}

export function paidByLabel(p: PaidBy, t: Translate): string {
  if (!p) return t('cpPaidByNone');
  return p.kind === 'company' ? t('cpPaidByCompany') : p.name;
}

// A bank payment linked as the commission says the company paid; the server
// refuses a pick by hand until it is unlinked.
export const paidByLocked = (p: PaidBy) => p?.kind === 'company' && p.linked;

export type CommissionPaidByInit = {
  orderId: string;
  /** The order's record, `order.commissionPaidBy ?? null`. */
  paidBy: PaidBy;
  /** Active managers, for the picker. Empty for a viewer who cannot pick. */
  managers: { id: string; name: string }[];
  /** After every successful write, with what the server saved. */
  onMutated?: (paidBy: PaidBy) => void;
};

export function useCommissionPaidBy({ orderId, paidBy: initial, managers, onMutated }: CommissionPaidByInit) {
  const [paidBy, setPaidByState] = useState<PaidBy>(initial);
  const [saving, setSaving] = useState(false);

  // A fresh read of the order (a reload, another order on the same page)
  // replaces what is shown. Keyed on the value, not the object, which a list
  // rebuilds on every page it loads.
  const initialKey = JSON.stringify(initial);
  useEffect(() => {
    setPaidByState(JSON.parse(initialKey) as PaidBy);
  }, [orderId, initialKey]);

  // A payer who is no longer an active manager still needs a row, or the
  // select could not show the record.
  const options = useMemo(() => {
    if (!paidBy || paidBy.kind === 'company' || managers.some(m => m.id === paidBy.id)) return managers;
    return [{ id: paidBy.id, name: paidBy.name }, ...managers];
  }, [managers, paidBy]);

  /** `value` is the select's: '', PAID_BY_COMPANY or a manager's id. */
  const setPaidBy = async (value: string) => {
    if (saving || paidByLocked(paidBy) || value === paidByValue(paidBy)) return;
    setSaving(true);
    try {
      const r = await api.put<{ commissionPaidBy: PaidBy }>(
        `/api/orders/${orderId}/commission-paid-by`,
        value === PAID_BY_COMPANY ? { company: true } : { userId: value || null });
      setPaidByState(r.commissionPaidBy);
      onMutated?.(r.commissionPaidBy);
    } catch (e) {
      handleFetchError(e);
    } finally {
      setSaving(false);
    }
  };

  return { paidBy, options, saving, setPaidBy };
}

export type CommissionPaidBy = ReturnType<typeof useCommissionPaidBy>;
