import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { acctLedgerPath, type AcctLedger, type AcctScope } from './accounting';

// One record's side of the book, for the cards on the PO, sell-order and
// after-sales pages. `scope` null renders nothing (a non-manager's page).
export function useAccountingTarget(scope: AcctScope | null) {
  const path = scope ? acctLedgerPath(scope) : null;
  const [ledger, setLedger] = useState<AcctLedger | null>(null);
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api.get<AcctLedger>(path)
      .then(r => { if (alive) setLedger(r); })
      // Silent: the card is a side panel, not the page — a hiccup here must
      // not throw a dialog over an order being edited.
      .catch(() => {});
    return () => { alive = false; };
  }, [path, gen]);
  const reload = useCallback(() => setGen(g => g + 1), []);
  return { ledger, reload };
}
