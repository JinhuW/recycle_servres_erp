import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { acctLedgerPath, type AcctLedger } from './accounting';

export type CommissionBankPayment = {
  id: string; postedAt: string; amount: number; source: string;
  counterparty: string | null; settleStatus: 'settled' | 'pending' | 'failed' | 'reversed';
};

type Payments = { book: AcctLedger; bank: CommissionBankPayment[]; bankNet: number };
const hasPayment = (r: Payments) => r.book.entries.some(e => e.direction === 'out' && !e.voided)
  || r.bank.some(e => e.amount < 0 && e.settleStatus === 'settled');

export function useCommissionPayments(orderId: string, enabled: boolean) {
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<Payments | null>(null);
  const read = useCallback(async () => {
    const [book, bank] = await Promise.all([
      api.get<AcctLedger>(acctLedgerPath({ orderId, kind: 'commission' })),
      api.get<{ payments: CommissionBankPayment[]; net: number }>(`/api/bank-transactions/by-order/${encodeURIComponent(orderId)}?kind=commission`),
    ]);
    return { book, bank: bank.payments, bankNet: bank.net };
  }, [orderId]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    read().then(r => { if (alive) setData(r); }).catch(() => {});
    return () => { alive = false; };
  }, [enabled, read, version]);
  const check = async () => {
    const r = await read();
    setData(r);
    return hasPayment(r);
  };
  return { data, check, hasPayment: data ? hasPayment(data) : false, reload: () => setVersion(v => v + 1), version };
}

export type CommissionPayments = ReturnType<typeof useCommissionPayments>;
