import { useCallback, useEffect, useId, useState } from 'react';
import { api } from '../lib/api';
import { showSuccessToast } from '../lib/errorToast';
import { fmtMoney } from '../lib/format';
import { useT } from '../lib/i18n';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { ConfirmDialog } from '../pages/desktop/settings/dialogs';
import '../styles/accounting.css';

// A Business Account payment on a PO is a PayPal or Mercury transaction: the
// search over the unlinked, settled outgoing ones, and the link that files
// the picked one against the PO's cost or its commission.

type Candidate = { id: string; day: string; party: string; amount: number; currency: string; detail: string };

type BankCandidate = {
  id: string; postedAt: string; counterparty: string | null; amount: number; currency: string;
  source: string; paypalTxnId: string | null; description: string | null;
};

type Props = {
  orderId: string;
  kind: 'cost' | 'commission';
  onLinked: () => void;
  /** The search runs only while it is shown. */
  active?: boolean;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
};

export function BankTxnLinkPicker({ orderId, kind, onLinked, active = true, disabled = false, onBusy }: Props) {
  const { t, locale } = useT();
  const id = useId();
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query, 200);
  const [results, setResults] = useState<{ rows: Candidate[]; nextCursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [generation, setGeneration] = useState(0);
  const setBusy = (b: boolean) => { setBusyState(b); onBusy?.(b); };
  const search = useCallback(async (cursor?: string) => {
    const q = new URLSearchParams({ q: settled.trim(), direction: 'out', limit: '30', ...(cursor ? { cursor } : {}) });
    q.set('status', 'unlinked');
    q.set('settle', 'settled');
    const r = await api.get<{ rows: BankCandidate[]; nextCursor: string | null }>('/api/bank-transactions?' + q);
    return { nextCursor: r.nextCursor, rows: r.rows.map(e => ({
      id: e.id, day: e.postedAt.slice(0, 10), party: e.counterparty ?? e.source,
      amount: Math.abs(e.amount), currency: e.currency, detail: e.paypalTxnId ?? e.description ?? e.source,
    })) };
  }, [settled]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    setResults(null);
    setError(null);
    search().then(r => { if (alive) setResults(r); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : t('cpSearchFailed')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, search, generation, t]);

  const link = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/bank-transactions/${encodeURIComponent(selected.id)}/link`, { orderId, kind, onlyUnlinked: true });
      setSelected(null);
      setGeneration(v => v + 1);
      onLinked();
      showSuccessToast(t(kind === 'cost' ? 'payCostLinked' : 'cpPaymentLinked'));
    } catch (e) {
      setSelected(null);
      setError(e instanceof Error ? e.message : t('saveFailed'));
    } finally { setBusy(false); }
  };

  const off = busy || disabled;
  return (
    <>
      <label className="label" htmlFor={id}>{t('cpSearchTransactions')}</label>
      <input id={id} className="input" type="search" value={query} disabled={off} autoComplete="off"
             placeholder={t('cpSearchBusinessPh')}
             onChange={e => setQuery(e.target.value)} />
      <div className="acct-hint">{t('cpSearchHint')}</div>
      {loading ? <div className="acct-hint" role="status">{t('cpSearchLoading')}</div> : results && (
        <div className="acct-pick-list commission-search-results">
          {results.rows.length === 0 && <div className="acct-empty">{t('cpNoTransactions')}</div>}
          {results.rows.map(row => (
            <button key={row.id} type="button" className="acct-pick-row commission-search-row" disabled={off}
                    onClick={() => setSelected(row)}>
              <span className="commission-search-info">
                <strong>{row.party}</strong>
                <span className="acct-sub">{row.day} · {row.detail}</span>
                <span className="acct-sub mono">{row.id}</span>
              </span>
              <span className="mono">{fmtMoney(row.amount, row.currency, locale)}</span>
              <span className="commission-link-label">{t('cpLinkPayment')}</span>
            </button>
          ))}
          {results.nextCursor && <button type="button" className="btn sm" disabled={off} onClick={async () => {
            setBusy(true);
            try {
              const r = await search(results.nextCursor!);
              setResults(prev => prev && ({ rows: [...prev.rows, ...r.rows], nextCursor: r.nextCursor }));
            } catch (e) { setError(e instanceof Error ? e.message : t('cpSearchFailed')); }
            finally { setBusy(false); }
          }}>{t('cpMoreTransactions')}</button>}
        </div>
      )}
      {error && <div className="acct-error" role="alert">{error}</div>}
      {selected && (
        <ConfirmDialog title={t('cpLinkPayment')} busy={busy} message={t(kind === 'cost' ? 'payCostLinkConfirm' : 'cpLinkBusinessConfirm', {
          amount: fmtMoney(selected.amount, selected.currency, locale), party: selected.party, id: orderId,
        })} confirmLabel={t('cpLinkPayment')} onCancel={() => { if (!busy) setSelected(null); }}
          onConfirm={() => { void link(); }} />
      )}
    </>
  );
}
