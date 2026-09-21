import { AttachmentChip } from './AttachmentChip';
import { AttachmentDropzone } from './AttachmentDropzone';
import { Icon } from './Icon';
import type { HandoffMethod } from '../lib/handoff';
import { useT } from '../lib/i18n';
import { normalizePaypalTxnInput, isStrictPaypalTxnId } from '../lib/paypalTxn';
import type { PaymentProof } from '../lib/usePaymentProof';

// How a PO was paid, and the proof that goes with it — one component behind
// the create pages, both PO pages, the hand-off dialog and the phone sheet.
// Paid by, then (for the company card) the method, then a proof panel whose
// heading names exactly what the chosen path needs, so the requirement is
// read before anything is typed. The rules live in lib/handoff.ts; this file
// is markup. Without `proof` (the create pages — no order to attach to yet)
// only the picker renders.

type Props = {
  paidBy: 'company' | 'self';
  onPaidBy: (v: 'company' | 'self') => void;
  method: HandoffMethod | null;
  onMethod: (v: HandoffMethod) => void;
  txnId: string;
  onTxnId: (v: string) => void;
  /** Star on the transaction id. The hand-off passes true; the PO pages pass
   *  what the server said about the saved order. */
  txnRequired?: boolean;
  disabled?: boolean;
  /** Short option labels for a narrow grid cell. */
  compact?: boolean;
  proof?: PaymentProof;
  /** Whether the proof panel offers upload / remove (the PO pages gate it on
   *  who may annotate the order). Read-only still shows what is on file. */
  canEditProof?: boolean;
  /** Keeps element ids unique when two instances share a page. */
  idPrefix?: string;
};

export function PaymentFields({
  paidBy, onPaidBy, method, onMethod, txnId, onTxnId,
  txnRequired = false, disabled = false, compact = false,
  proof, canEditProof = true, idPrefix = 'pay',
}: Props) {
  const { t } = useT();
  const company = paidBy === 'company';
  const p = idPrefix;

  return (
    <div className={'pay-fields' + (compact ? ' compact' : '')}>
      <div className="pay-row">
        <div className="field">
          <span className="label" id={`${p}-paidby`}>{t('hoPaidBy')}</span>
          <div className="seg ho-seg" role="radiogroup" aria-labelledby={`${p}-paidby`}>
            <button type="button" role="radio" aria-checked={company} className={company ? 'active' : ''}
              disabled={disabled} onClick={() => onPaidBy('company')}>
              {t(compact ? 'payCompanyShort' : 'payCompany')}
            </button>
            <button type="button" role="radio" aria-checked={!company} className={!company ? 'active' : ''}
              disabled={disabled} onClick={() => onPaidBy('self')}>
              {t(compact ? 'paySelfShort' : 'paySelf')}
            </button>
          </div>
        </div>
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
