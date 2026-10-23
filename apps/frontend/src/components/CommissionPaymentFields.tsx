import { useId } from 'react';
import { AttachmentChip } from './AttachmentChip';
import { AttachmentDropzone } from './AttachmentDropzone';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { PAID_BY_COMPANY, paidByLabel, paidByLocked, paidByValue, type CommissionPaidBy } from '../lib/useCommissionPaidBy';
import type { ProofAttachment } from '../lib/usePaymentProof';
import { ConfirmDialog } from '../pages/desktop/settings/dialogs';

// The commission payment — who paid the purchaser, and the screenshot that
// shows it — on the desktop Commission tab and in the phone fold, one
// component so the two cannot drift. Both write through, with no Save: files
// go straight to the order's Commission bucket, and the payer follows the
// upload or a pick the manager confirms (CommissionPaidByConfirm, which the
// page renders). The Done dialog offers the same drop box on the way to Done
// when nothing is here yet. No panel around it.

export type CommissionShots = {
  atts: ProofAttachment[];
  uploading: boolean;
  add: (files: FileList | null) => void;
  remove: (att: ProofAttachment) => void;
};

type Props = {
  paidBy: CommissionPaidBy;
  shots: CommissionShots;
  /** Managers edit; everyone else reads what is on file. */
  editable: boolean;
};

export function CommissionPaymentFields({ paidBy, shots, editable }: Props) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <PaidByField paidBy={paidBy} editable={editable} />
      <ScreenshotField shots={shots} editable={editable} />
    </div>
  );
}

function PaidByField({ paidBy, editable }: { paidBy: CommissionPaidBy; editable: boolean }) {
  const { t } = useT();
  const id = useId();
  const locked = paidByLocked(paidBy.paidBy);
  if (!editable) {
    return (
      <div className="field" style={{ marginBottom: 0, display: 'grid', gap: 8 }}>
        <span className="label">{t('cpPaidByLabel')}</span>
        <div className={paidBy.paidBy ? '' : 'pay-proof-title muted'}>
          {paidByLabel(paidBy.paidBy, t)}
        </div>
      </div>
    );
  }
  return (
    <div className="field" style={{ marginBottom: 0, display: 'grid', gap: 8 }}>
      <label className="label" htmlFor={id}>{t('cpPaidByLabel')}</label>
      {/* A pick asks first; the select stays on the record until it is confirmed.
          The company is a fixed option, not a member. */}
      <select
        id={id}
        className="select"
        value={paidByValue(paidBy.paidBy)}
        onChange={e => paidBy.request(e.target.value)}
        disabled={paidBy.saving || locked}
        title={locked ? t('cpPaidByLinkedHint') : undefined}
        style={{ width: '100%' }}
      >
        <option value="">{t('cpPaidByNone')}</option>
        <option value={PAID_BY_COMPANY}>{t('payBusiness')}</option>
        {paidBy.options.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      {locked && (
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('cpPaidByLinkedHint')}</div>
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

function ScreenshotField({ shots, editable }: { shots: CommissionShots; editable: boolean }) {
  const { t } = useT();

  if (!editable) {
    return (
      <div className="field" style={{ marginBottom: 0, display: 'grid', gap: 8 }}>
        <span className="label">{t('cpShotLabel')}</span>
        {shots.atts.length === 0 ? (
          <div className="pay-proof-title muted">{t('cpNothingYet')}</div>
        ) : (
          <div className="ho-chips">
            {shots.atts.map(a => <AttachmentChip key={a.id} a={a} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="field" style={{ marginBottom: 0, display: 'grid', gap: 8 }}>
      <span className="label">{t('cpShotLabel')}</span>
      {shots.atts.length > 0 && (
        <div className="ho-chips">
          {shots.atts.map(a => <AttachmentChip key={a.id} a={a} onRemove={() => shots.remove(a)} />)}
        </div>
      )}
      <AttachmentDropzone
        onFiles={shots.add}
        uploading={shots.uploading}
        accept="image/*"
        compact
        boxHint={t('cpShotHint')}
      />
      {shots.atts.length > 0 && (
        <div className="pay-proof-status" role="status">
          <Icon name="check" size={13} /> {t('payProofOnFile', { n: String(shots.atts.length) })}
        </div>
      )}
    </div>
  );
}
