import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';
import type { Translate } from './orderPresentation';
import type { CommissionPayer } from './types';

// Who paid the purchaser their commission, a manager or the company, behind
// the desktop Commission tab and the phone fold. Not part of the page's draft
// and Save: the commission is paid once the PO is a closed book, where Save is
// off, so it is written as it changes, as the commission screenshot is. The
// screenshot's upload names the uploader when nobody is on file; any other
// change waits for a yes in the page's confirm, and nothing reads as saved
// before the server says so — a refused or failed write leaves the record.

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
  return p.kind === 'company' ? t('payBusiness') : p.name;
}

// A bank payment linked as the commission says the company paid; the server
// refuses a pick by hand until it is unlinked.
export const paidByLocked = (p: PaidBy) => p?.kind === 'company' && p.linked;

// A change waiting on the manager's yes: a pick in the select, or taking over
// a payer already on file after uploading the screenshot themselves.
export type PaidByChange = { value: string; reason: 'pick' | 'upload' };

export type CommissionPaidByInit = {
  orderId: string;
  /** The order's record, `order.commissionPaidBy ?? null`. */
  paidBy: PaidBy;
  /** Active managers, for the picker. Empty for a viewer who cannot pick. */
  managers: { id: string; name: string }[];
  /** The signed-in user — who an upload offers to record as the payer. */
  me: { id: string; name: string } | null;
  /** After every successful write, with what the server saved. */
  onMutated?: (paidBy: PaidBy) => void;
};

export function useCommissionPaidBy({ orderId, paidBy: initial, managers, me, onMutated }: CommissionPaidByInit) {
  const [paidBy, setPaidByState] = useState<PaidBy>(initial);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PaidByChange | null>(null);

  // A fresh read of the order (a reload, another order on the same page)
  // replaces what is shown. Keyed on the value, not the object, which a list
  // rebuilds on every page it loads.
  const initialKey = JSON.stringify(initial);
  useEffect(() => {
    setPaidByState(JSON.parse(initialKey) as PaidBy);
  }, [orderId, initialKey]);
  useEffect(() => { setPending(null); }, [orderId]);

  // A payer who is no longer an active manager still needs a row, or the
  // select could not show the record.
  const options = useMemo(() => {
    if (!paidBy || paidBy.kind === 'company' || managers.some(m => m.id === paidBy.id)) return managers;
    return [{ id: paidBy.id, name: paidBy.name }, ...managers];
  }, [managers, paidBy]);

  // `value` is the select's: '', PAID_BY_COMPANY or a manager's id.
  const write = async (value: string) => {
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

  /** A pick in the select: asks first, writes nothing. */
  const request = (value: string) => {
    if (saving || paidByLocked(paidBy) || value === paidByValue(paidBy)) return;
    setPending({ value, reason: 'pick' });
  };
  const confirm = async () => {
    if (!pending) return;
    setPending(null);
    await write(pending.value);
  };
  const cancel = () => setPending(null);

  /** After a commission screenshot upload, with the server's record. An empty
   *  one was filled with the uploader there; someone else's is offered to them. */
  const adopt = (next: PaidBy) => {
    setPaidByState(next);
    if (me && !paidByLocked(next) && paidByValue(next) !== me.id) setPending({ value: me.id, reason: 'upload' });
  };

  /** A payer the server recorded on its own — an Accounting commission entry
   *  names the manager it was for, who need not be the one signed in, so
   *  nobody is offered a takeover. */
  const sync = (next: PaidBy) => setPaidByState(next);

  /** The name a select value stands for, for the confirm. */
  const nameFor = (value: string): string | null => {
    if (value === '' || value === PAID_BY_COMPANY) return null;
    if (value === me?.id) return me.name;
    return options.find(m => m.id === value)?.name ?? null;
  };

  return { paidBy, options, saving, pending, request, confirm, cancel, adopt, sync, nameFor };
}

export type CommissionPaidBy = ReturnType<typeof useCommissionPaidBy>;
