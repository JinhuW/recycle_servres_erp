import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { handleFetchError } from './errorToast';

// Which manager paid the purchaser their commission, behind the desktop
// Commission tab and the phone fold. Not part of the page's draft and Save:
// the commission is paid once the PO is a closed book, where Save is off, so
// a pick goes straight to the server, as the commission screenshot does.
// Nothing reads as saved before the server says so — a failed write leaves
// the select on the record.

export type PaidBy = { id: string; name: string } | null;

export type CommissionPaidByInit = {
  orderId: string;
  /** The order's record, `order.commissionPaidBy ?? null`. */
  paidBy: PaidBy;
  /** Active managers, for the picker. Empty for a viewer who cannot pick. */
  managers: { id: string; name: string }[];
  /** After every successful write — the pages refresh their activity log. */
  onMutated?: () => void;
};

export function useCommissionPaidBy({ orderId, paidBy: initial, managers, onMutated }: CommissionPaidByInit) {
  const [paidBy, setPaidByState] = useState<PaidBy>(initial);
  const [saving, setSaving] = useState(false);

  // A fresh read of the order (a reload, another order on the same page)
  // replaces what is shown.
  const initialId = initial?.id ?? null;
  const initialName = initial?.name ?? null;
  useEffect(() => {
    setPaidByState(initialId === null ? null : { id: initialId, name: initialName ?? '' });
  }, [orderId, initialId, initialName]);

  // A payer who is no longer an active manager still needs a row, or the
  // select could not show the record.
  const options = useMemo(() => {
    if (!paidBy || managers.some(m => m.id === paidBy.id)) return managers;
    return [paidBy, ...managers];
  }, [managers, paidBy]);

  const setPaidBy = async (userId: string | null) => {
    if (saving || userId === (paidBy?.id ?? null)) return;
    setSaving(true);
    try {
      const r = await api.put<{ commissionPaidBy: PaidBy }>(
        `/api/orders/${orderId}/commission-paid-by`, { userId });
      setPaidByState(r.commissionPaidBy);
      onMutated?.();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setSaving(false);
    }
  };

  return { paidBy, options, saving, setPaidBy };
}

export type CommissionPaidBy = ReturnType<typeof useCommissionPaidBy>;
