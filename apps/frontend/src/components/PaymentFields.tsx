import type { ReactNode } from 'react';
import { AttachmentChip } from './AttachmentChip';
import { AttachmentDropzone } from './AttachmentDropzone';
import { Icon } from './Icon';
import type { HandoffMethod } from '../lib/handoff';
import { useT } from '../lib/i18n';
import { BUSINESS_ACCOUNT } from '../lib/poFacets';
import { normalizePaypalTxnInput, isStrictPaypalTxnId } from '../lib/paypalTxn';
import type { PaymentProof } from '../lib/usePaymentProof';

// How a PO was paid, and the proof that goes with it — one component behind
// the create pages, both PO pages, the hand-off dialog and the phone sheet.
// Paid by — the Business Account, or the person who paid — then (for the
// Business Account) the method, then a proof panel whose heading names
// exactly what the chosen path needs, so the requirement is read before
// anything is typed. The rules live in lib/handoff.ts; this file is markup.
// Without `proof` (the create pages — no order to attach to yet) only the
// picker renders.

type Props = {
  paidBy: 'company' | 'self';
  /** The person on a self-paid order. Null while a stale record names
   *  nobody; the select then shows the old Self-paid label. */
  paidByUserId: string | null;
  /** The people the select offers (lib/poFacets.ts payerChoices). */
  payers: { id: string; name: string }[];
  /** One pick sets both: the Business Account, or self plus the person. */
  onPaidBy: (v: 'company' | 'self', userId: string | null) => void;
  method: HandoffMethod | null;
  onMethod: (v: HandoffMethod) => void;
  txnId: string;
  onTxnId: (v: string) => void;
  /** Star on the transaction id. The hand-off passes true; the PO pages pass
   *  what the server said about the saved order. */
  txnRequired?: boolean;
  disabled?: boolean;
  /** A manager has booked the cost: Paid by is theirs to change. Locks the
   *  select only; method and proof never reach the book. */
  payerLocked?: boolean;
  /** Short option labels for a narrow grid cell. */
  compact?: boolean;
  proof?: PaymentProof;
  /** Whether the proof panel offers upload / remove (the PO pages gate it on
   *  who may annotate the order). Read-only still shows what is on file. */
  canEditProof?: boolean;
  /** Keeps element ids unique when two instances share a page. */
  idPrefix?: string;
  /** A manager's PO page: the payment's source is a switch, as on the
   *  Commission tab — the RMB Flow (a person paid, booked on the RMB book) or
   *  the Business Account (the USD bank's, on Payments) — and each side brings
   *  its own ledger. The select then names people only. */
  sources?: { rmb: ReactNode; business: ReactNode };
  /** Who the RMB side names when the switch moves there and nobody is on file. */
  defaultPayerId?: string | null;
};

export function PaymentFields({
  paidBy, paidByUserId, payers, onPaidBy, method, onMethod, txnId, onTxnId,
  txnRequired = false, disabled = false, payerLocked = false, compact = false,
  proof, canEditProof = true, idPrefix = 'pay', sources, defaultPayerId = null,
}: Props) {
  const { t } = useT();
  const company = paidBy === 'company';
  const p = idPrefix;
  const pickSource = (s: 'rmb' | 'business') => {
    if (s === 'business') { if (!company) onPaidBy('company', null); return; }
    if (!company) return;
    const keep = paidByUserId && payers.some(m => m.id === paidByUserId) ? paidByUserId : null;
    onPaidBy('self', keep ?? defaultPayerId ?? payers[0]?.id ?? null);
  };
  // A self-paid record naming nobody (an older backend, or a payer dropped
  // from the list) keeps a row of its own, or the select could not show it.
  const stale = !company && (paidByUserId === null || !payers.some(m => m.id === paidByUserId));
  const value = company ? BUSINESS_ACCOUNT : stale ? 'self' : paidByUserId!;

  const fields = (
    <div className={'pay-fields' + (compact ? ' compact' : '')}>
      <div className="pay-row">
        {/* With the switch, the Business Account is the switch's to name. */}
        {!(sources && company) && <div className="field">
          <label className="label" htmlFor={`${p}-paidby`}>{t('hoPaidBy')}</label>
          <select
            id={`${p}-paidby`}
            className="select"
            value={value}
            disabled={disabled || payerLocked}
            aria-describedby={payerLocked ? `${p}-paidby-locked` : undefined}
            onChange={e => {
              const v = e.target.value;
              onPaidBy(v === BUSINESS_ACCOUNT ? 'company' : 'self', v === BUSINESS_ACCOUNT || v === 'self' ? null : v);
            }}
          >
            {!sources && <option value={BUSINESS_ACCOUNT}>{t(compact ? 'payBusinessShort' : 'payBusiness')}</option>}
            {stale && <option value="self">{t(compact ? 'paySelfShort' : 'paySelf')}</option>}
            {payers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {payerLocked && <div className="field-hint" id={`${p}-paidby-locked`}>{t('payPayerLocked')}</div>}
        </div>}
        {company && (
          <div className="field pay-reveal">
            <span className="label" id={`${p}-method`}>{t('hoMethod')}</span>
            <div className="seg ho-seg" role="radiogroup" aria-labelledby={`${p}-method`}>
              <button type="button" role="radio" aria-checked={method === 'paypal'} className={method === 'paypal' ? 'active' : ''}
                disabled={disabled} onClick={() => onMethod('paypal')}>{t('hoMethodPaypal')}</button>
              <button type="button" role="radio" aria-checked={method === 'cash'} className={method === 'cash' ? 'active' : ''}
                disabled={disabled} onClick={() => onMethod('cash')}>{t('hoMethodCash')}</button>
            </div>
          </div>
        )}
      </div>

      {proof && (
        <ProofPanel
          paidBy={paidBy} method={method} txnId={txnId} onTxnId={onTxnId}
          txnRequired={txnRequired} disabled={disabled}
          proof={proof} canEdit={canEditProof && !disabled} idPrefix={p}
        />
      )}
    </div>
  );
  if (!sources) return fields;
  const locked = disabled || payerLocked;
  return (
    <div className="pay-sourced">
      <div className="seg" role="group" aria-label={t('cpPaymentSource')}>
        {(['rmb', 'business'] as const).map(s => {
          const on = (s === 'business') === company;
          return (
            <button key={s} type="button" className={on ? 'active' : ''} aria-pressed={on}
                    disabled={locked} onClick={() => pickSource(s)}>
              {t(s === 'rmb' ? 'acctCardTitle' : 'payBusiness')}
            </button>
          );
        })}
      </div>
      {payerLocked && company && <div className="field-hint">{t('payPayerLocked')}</div>}
      {fields}
      {company ? sources.business : sources.rmb}
    </div>
  );
}

function ProofPanel({
  paidBy, method, txnId, onTxnId, txnRequired, disabled, proof, canEdit, idPrefix: p,
}: {
  paidBy: 'company' | 'self';
  method: HandoffMethod | null;
  txnId: string;
  onTxnId: (v: string) => void;
  txnRequired: boolean;
  disabled: boolean;
  proof: PaymentProof;
  canEdit: boolean;
  idPrefix: string;
}) {
  const { t } = useT();
  const path = paidBy === 'self' ? 'self' : method;
  const txnLooksOdd = txnId !== '' && !isStrictPaypalTxnId(txnId);

  // The left rule is the panel's one colour: quiet while something required
  // is still missing, accent once the path is satisfied.
  const satisfied =
    path === 'paypal' ? txnId.trim() !== ''
    : path === 'cash' ? proof.proofAtts.length > 0
    : path === 'self' ? proof.chatAtts.length > 0
    : false;
  const cls = 'pay-proof' + (satisfied ? ' ok' : '');

  if (path === null) {
    return (
      <div className={cls} aria-live="polite">
        <div className="pay-proof-title muted">{t('payMethodPick')}</div>
      </div>
    );
  }

  if (path === 'paypal') {
    return (
      <div className={cls}>
        <div className="field">
          <label className="label" htmlFor={`${p}-txn`}>
            {t('shipPayTxnLabel')} {txnRequired && <span className="req">*</span>}
          </label>
          <input
            id={`${p}-txn`}
            className={'input mono' + (proof.scanNoticeKey === 'hoShotRead' ? ' ai-filled' : '')}
            value={txnId}
            onChange={e => onTxnId(normalizePaypalTxnInput(e.target.value))}
            placeholder={disabled ? '—' : t('shipPayTxnPh')}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="ship-add-hint">{txnLooksOdd ? t('shipPayTxnFormatHint') : t('hoTxnHint')}</div>
        </div>
        {/* The screenshot is a Payment attachment like the cash one, so what
            is on file shows even read-only; only adding and removing is
            gated. Dropping one also reads the transaction id into the field. */}
        {(canEdit || proof.proofAtts.length > 0) && (
          <div className="field">
            <span className="label">{t('hoShotLabel')} <span className="ho-optional">{t('hoOptional')}</span></span>
            {proof.proofAtts.length > 0 && (
              <div className="ho-chips">
                {proof.proofAtts.map(a => (
                  <AttachmentChip key={a.id} a={a} onRemove={canEdit ? () => void proof.removeProofAtt(a) : undefined} />
                ))}
              </div>
            )}
            {canEdit && proof.canAttach && (
              <AttachmentDropzone
                onFiles={files => void proof.handlePaymentFile(files)}
                uploading={proof.scanBusy}
                accept="image/*"
                multiple={false}
                compact
                boxHint={t('hoShotHint')}
              />
            )}
            {proof.scanNoticeKey && <div className="ship-add-hint" role="status">{t(proof.scanNoticeKey)}</div>}
            {proof.scanError && (
              <div className="ship-add-hint" role="alert">
                {'text' in proof.scanError ? proof.scanError.text : t(proof.scanError.key)}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Cash and self-paid share one shape: a required set of files in a bucket.
  const cash = path === 'cash';
  const atts = cash ? proof.proofAtts : proof.chatAtts;
  const add = cash ? proof.addProofFiles : proof.addChatFiles;
  const remove = cash ? proof.removeProofAtt : proof.removeChatAtt;
  const uploading = cash ? proof.proofUploading : proof.chatUploading;
  return (
    <div className={cls}>
      <div className="pay-proof-title">
        {t(cash ? 'payProofCash' : 'hoChatShot')} <span className="req">*</span>
      </div>
      <div className="pay-proof-hint">{t(cash ? 'payProofCashHint' : 'hoChatHint')}</div>
      {atts.length > 0 && (
        <div className="ho-chips">
          {atts.map(a => <AttachmentChip key={a.id} a={a} onRemove={canEdit ? () => void remove(a) : undefined} />)}
        </div>
      )}
      {canEdit && proof.canAttach && (
        <AttachmentDropzone
          onFiles={files => void add(files)}
          uploading={uploading}
          accept={cash ? 'image/*' : 'image/*,application/pdf'}
          compact
          boxHint={t(cash ? 'payProofCashDrop' : 'payProofChatDrop')}
        />
      )}
      {atts.length > 0 && (
        <div className="pay-proof-status" role="status">
          <Icon name="check" size={13} /> {t('payProofOnFile', { n: String(atts.length) })}
        </div>
      )}
    </div>
  );
}
