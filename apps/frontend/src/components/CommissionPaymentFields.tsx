import { useState, type ReactNode } from 'react';
import { AttachmentChip } from './AttachmentChip';
import { BankTxnLinkPicker } from './BankTxnLinkPicker';
import { PaymentSourceSwitch } from './PaymentFields';
import { useT } from '../lib/i18n';
import { PAID_BY_COMPANY, paidByLabel, type CommissionPaidBy } from '../lib/useCommissionPaidBy';
import type { ProofAttachment } from '../lib/usePaymentProof';
import { ConfirmDialog } from '../pages/desktop/settings/dialogs';
import { RouteLink } from './RouteLink';
import { paymentsForOrderPath } from '../lib/route';
import { fmtMoney } from '../lib/format';
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

export function CommissionPaymentFields({ orderId, paidBy, shots, editable, payments, onLinked, rmbFlow }: Props) {
  const { t, locale } = useT();
  const [source, setSource] = useState<'rmb' | 'business'>(paidBy.paidBy?.kind === 'company' ? 'business' : 'rmb');
  const [busy, setBusy] = useState(false);

  return (
    <div className="commission-transactions">
      <div className="acct-hint">{t('cpPaidByLabel')}: {paidByLabel(paidBy.paidBy, t)}</div>
      {editable && (
        <>
          <PaymentSourceSwitch value={source} disabled={busy} onChange={setSource} />
          {source === 'rmb' ? rmbFlow : (
            <BankTxnLinkPicker orderId={orderId} kind="commission" onBusy={setBusy} onLinked={() => {
              paidBy.sync({ kind: 'company', linked: true });
              payments.reload();
              onLinked();
            }} />
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
    </div>
  );
}

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
