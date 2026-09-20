import { AttachmentChip } from './AttachmentChip';
import { AttachmentDropzone } from './AttachmentDropzone';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { isStrictPaypalTxnId } from '../lib/paypalTxn';
import type { CommissionPayment } from '../lib/useCommissionPayment';

// How the purchaser was paid their commission — the method, the PayPal id and
// the screenshot — on the desktop Commission tab and in the phone fold, one
// component so the two cannot drift. Every control writes through
// lib/useCommissionPayment.ts as it is used; there is no Save. The picker
// opens on PayPal, a dropped screenshot fills an empty id, and Cash keeps the
// id out of sight rather than throwing it away.

type Props = {
  cp: CommissionPayment;
  /** Managers edit; everyone else reads what is on file. */
  editable: boolean;
  phone?: boolean;
  /** Keeps element ids unique when two instances share a page. */
  idPrefix?: string;
};

export function CommissionPaymentFields({ cp, editable, phone = false, idPrefix = 'cp' }: Props) {
  const { t } = useT();
  const paypal = cp.method === 'paypal';
  const txnLooksOdd = cp.txnId !== '' && !isStrictPaypalTxnId(cp.txnId);
  const cls = 'pay-proof cp-fields' + (cp.onFile ? ' ok' : '');

  if (!editable) {
    return (
      <div className={cls}>
        {!cp.onFile ? (
          <div className="pay-proof-title muted">{t('cpNothingYet')}</div>
        ) : (
          <>
            <div className={phone ? 'ph-fold-ro' : 'cp-ro'}>
              <div className={phone ? 'ph-field' : 'field'}>
                <label>{t('hoMethod')}</label>
                <div className="v">{t(paypal ? 'hoMethodPaypal' : 'hoMethodCash')}</div>
              </div>
              {paypal && cp.txnId !== '' && (
                <div className={phone ? 'ph-field' : 'field'}>
                  <label>{t('shipPayTxnLabel')}</label>
                  <div className="v mono">{cp.txnId}</div>
                </div>
              )}
            </div>
            {cp.atts.length > 0 && (
              <div className="ho-chips">
                {cp.atts.map(a => <AttachmentChip key={a.id} a={a} />)}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={cls}>
      <div className="cp-grid">
        <div className="cp-pick">
          <div className="field">
            <span className="label" id={`${idPrefix}-method`}>{t('hoMethod')}</span>
            <div className="seg ho-seg" role="radiogroup" aria-labelledby={`${idPrefix}-method`}>
              <button type="button" role="radio" aria-checked={paypal} className={paypal ? 'active' : ''}
                disabled={cp.saving} onClick={() => void cp.setMethod('paypal')}>{t('hoMethodPaypal')}</button>
              <button type="button" role="radio" aria-checked={!paypal} className={!paypal ? 'active' : ''}
                disabled={cp.saving} onClick={() => void cp.setMethod('cash')}>{t('hoMethodCash')}</button>
            </div>
          </div>
          {paypal && (
            <div className="field pay-reveal">
              <label className="label" htmlFor={`${idPrefix}-txn`}>{t('shipPayTxnLabel')}</label>
              <input
                id={`${idPrefix}-txn`}
                className={'input mono' + (cp.scanNoticeKey === 'hoShotRead' ? ' ai-filled' : '')}
                value={cp.txnId}
                onChange={e => cp.setTxnId(e.target.value)}
                onBlur={cp.flushTxnId}
                onKeyDown={e => { if (e.key === 'Enter') cp.flushTxnId(); }}
                placeholder={t('shipPayTxnPh')}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="ship-add-hint">{txnLooksOdd ? t('shipPayTxnFormatHint') : t('cpTxnHint')}</div>
            </div>
          )}
        </div>

        <div className="field cp-shots">
          <span className="label">{t('cpShotLabel')}</span>
          {cp.atts.length > 0 && (
            <div className="ho-chips">
              {cp.atts.map(a => <AttachmentChip key={a.id} a={a} onRemove={() => void cp.removeShot(a)} />)}
            </div>
          )}
          <AttachmentDropzone
            onFiles={files => void cp.addShot(files)}
            uploading={cp.uploading}
            accept="image/*"
            multiple={false}
            capture={phone ? 'environment' : undefined}
            compact
            boxHint={t(paypal ? 'cpShotHintPaypal' : 'cpShotHintCash')}
          />
          {cp.scanNoticeKey && <div className="ship-add-hint" role="status">{t(cp.scanNoticeKey)}</div>}
          {cp.scanError && (
            <div className="ship-add-hint" role="alert">
              {'text' in cp.scanError ? cp.scanError.text : t(cp.scanError.key)}
            </div>
          )}
        </div>
      </div>
      {cp.atts.length > 0 && (
        <div className="pay-proof-status" role="status">
          <Icon name="check" size={13} /> {t('payProofOnFile', { n: String(cp.atts.length) })}
        </div>
      )}
    </div>
  );
}
