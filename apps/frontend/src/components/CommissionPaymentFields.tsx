import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { AttachmentChip } from './AttachmentChip';
import { useT } from '../lib/i18n';
import { PAID_BY_COMPANY, paidByLabel, type CommissionPaidBy } from '../lib/useCommissionPaidBy';
import type { ProofAttachment } from '../lib/usePaymentProof';
import { ConfirmDialog } from '../pages/desktop/settings/dialogs';
import { api } from '../lib/api';
import { RouteLink } from './RouteLink';
import { paymentsForOrderPath } from '../lib/route';
import { fmtMoney } from '../lib/format';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { showSuccessToast } from '../lib/errorToast';
import type { CommissionPayments } from '../lib/useCommissionPayments';
import '../styles/accounting.css';

// Legacy evidence stays readable while payments live in their own ledgers.
export type CommissionShots = {
  atts: ProofAttachment[];
  uploading: boolean;
  add: (files: FileList | null) => void;
  remove: (att: ProofAttachment) => void;
};

type Props = {
  orderId: string;
  paidBy: CommissionPaidBy;
  shots: CommissionShots;
  editable: boolean;
  payments: CommissionPayments;
  onLinked: () => void;
  rmbFlow?: ReactNode;
};

type Candidate = { id: string; day: string; party: string; amount: number; currency: string; detail: string };

export function CommissionPaymentFields({ orderId, paidBy, shots, editable, payments, onLinked, rmbFlow }: Props) {
  const { t, locale } = useT();
  const id = useId();
  const [source, setSource] = useState<'rmb' | 'business'>(paidBy.paidBy?.kind === 'company' ? 'business' : 'rmb');
  const [query, setQuery] = useState('');
  const settled = useDebouncedValue(query, 200);
  const [results, setResults] = useState<{ rows: Candidate[]; nextCursor: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [generation, setGeneration] = useState(0);
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
    if (!editable || source !== 'business') return;
    let alive = true;
    setLoading(true);
    setResults(null);
    setError(null);
    search().then(r => { if (alive) setResults(r); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : t('cpSearchFailed')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [editable, source, search, generation, t]);

  const link = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/bank-transactions/${encodeURIComponent(selected.id)}/link`, { orderId, kind: 'commission', onlyUnlinked: true });
      paidBy.sync({ kind: 'company', linked: true });
      setSelected(null);
      setGeneration(v => v + 1);
      payments.reload();
      onLinked();
      showSuccessToast(t('cpPaymentLinked'));
    } catch (e) {
      setSelected(null);
      setError(e instanceof Error ? e.message : t('saveFailed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="commission-transactions">
      <div className="acct-hint">{t('cpPaidByLabel')}: {paidByLabel(paidBy.paidBy, t)}</div>
      {editable && (
        <>
          <div className="seg" role="group" aria-label={t('cpPaymentSource')}>
            {(['rmb', 'business'] as const).map(s => (
              <button key={s} type="button" className={source === s ? 'active' : ''} aria-pressed={source === s}
                      disabled={busy} onClick={() => { setSource(s); setSelected(null); }}>
                {t(s === 'rmb' ? 'acctCardTitle' : 'payBusiness')}
              </button>
            ))}
          </div>
          {source === 'rmb' ? rmbFlow : (
            <>
              <label className="label" htmlFor={id}>{t('cpSearchTransactions')}</label>
              <input id={id} className="input" type="search" value={query} disabled={busy} autoComplete="off"
                     placeholder={t('cpSearchBusinessPh')}
                     onChange={e => setQuery(e.target.value)} />
              <div className="acct-hint">{t('cpSearchHint')}</div>
              {loading ? <div className="acct-hint" role="status">{t('cpSearchLoading')}</div> : results && (
                <div className="acct-pick-list commission-search-results">
                  {results.rows.length === 0 && <div className="acct-empty">{t('cpNoTransactions')}</div>}
                  {results.rows.map(row => (
                    <button key={row.id} type="button" className="acct-pick-row commission-search-row" disabled={busy}
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
                  {results.nextCursor && <button type="button" className="btn sm" disabled={busy} onClick={async () => {
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
            </>
          )}
        </>
      )}
      {!!payments.data?.bank.length && (
        <div className="commission-linked-bank">
          <div className="acct-card-title">{t('payLedgerTitle')}</div>
          {payments.data.bank.map(payment => (
            <div key={payment.id} className="commission-bank-row">
              <span>{payment.postedAt.slice(0, 10)} · {payment.counterparty ?? payment.source}</span>
              <span className="mono">{fmtMoney(payment.amount, 'USD', locale)}</span>
              <span className="chip">{t('paySettle' + payment.settleStatus[0].toUpperCase() + payment.settleStatus.slice(1))}</span>
              <RouteLink to={paymentsForOrderPath(orderId, payment.id)} className="btn sm ghost commission-bank-open">{t('payLedgerOpen')}</RouteLink>
            </div>
          ))}
          <div className="acct-card-net"><span>{t('payLedgerNet')}</span><span className="mono">{fmtMoney(payments.data.bankNet, 'USD', locale)}</span></div>
        </div>
      )}
      {shots.atts.length > 0 && (
        <div>
          <span className="label">{t('cpShotLabel')}</span>
          <div className="ho-chips">{shots.atts.map(a => <AttachmentChip key={a.id} a={a} />)}</div>
        </div>
      )}
      {selected && (
        <ConfirmDialog title={t('cpLinkPayment')} busy={busy} message={t('cpLinkBusinessConfirm', {
          amount: fmtMoney(selected.amount, selected.currency, locale), party: selected.party, id: orderId,
        })} confirmLabel={t('cpLinkPayment')} onCancel={() => { if (!busy) setSelected(null); }}
          onConfirm={() => { void link(); }} />
      )}
    </div>
  );
}

type BankCandidate = {
  id: string; postedAt: string; counterparty: string | null; amount: number; currency: string;
  source: string; paypalTxnId: string | null; description: string | null;
};

// The yes behind every change to Paid by except an upload's first record: a
// pick in the select, or an upload by a manager other than the one on file.
// The page renders it once, beside its other dialogs, so an upload in the
// Done dialog asks too.
// Above the Done dialog (110), whose drop box can be what opened it.
const DIALOG_ABOVE_DONE = 120;

export function CommissionPaidByConfirm({ paidBy }: { paidBy: CommissionPaidBy }) {
  const { t } = useT();
  const change = paidBy.pending;
  if (!change) return null;
  const from = paidByLabel(paidBy.paidBy, t);
  const onConfirm = () => void paidBy.confirm();
  if (change.reason === 'upload') {
    return (
      <ConfirmDialog
        title={t('cpPaidByTakeTitle')}
        message={t('cpPaidByTakeMsg', { from })}
        confirmLabel={t('cpPaidByTakeConfirm')}
        zIndex={DIALOG_ABOVE_DONE}
        onCancel={paidBy.cancel}
        onConfirm={onConfirm}
      />
    );
  }
  const to = change.value === '' ? t('cpPaidByNone')
    : change.value === PAID_BY_COMPANY ? t('payBusiness')
    : paidBy.nameFor(change.value) ?? '';
  return (
    <ConfirmDialog
      title={t('cpPaidByChangeTitle')}
      message={t('cpPaidByChangeMsg', { from, to })}
      confirmLabel={t('cpPaidByChangeConfirm')}
      zIndex={DIALOG_ABOVE_DONE}
      onCancel={paidBy.cancel}
      onConfirm={onConfirm}
    />
  );
}
