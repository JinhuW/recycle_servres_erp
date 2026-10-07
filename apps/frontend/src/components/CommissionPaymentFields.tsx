import { useId } from 'react';
import { AttachmentChip } from './AttachmentChip';
import { AttachmentDropzone } from './AttachmentDropzone';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import type { CommissionPaidBy } from '../lib/useCommissionPaidBy';
import type { ProofAttachment } from '../lib/usePaymentProof';

// The commission payment — which manager paid the purchaser, and the
// screenshot that shows it — on the desktop Commission tab and in the phone
// fold, one component so the two cannot drift. Both write through as they are
// used: the pick saves at once and files go straight to the order's
// Commission bucket; there is no Save. The Done dialog offers the same drop box
// on the way to Done when nothing is here yet. No panel around it.

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
  if (!editable) {
    return (
      <div className="field" style={{ marginBottom: 0, display: 'grid', gap: 8 }}>
        <span className="label">{t('cpPaidByLabel')}</span>
        <div className={paidBy.paidBy ? '' : 'pay-proof-title muted'}>
          {paidBy.paidBy?.name ?? t('cpPaidByNone')}
        </div>
      </div>
    );
  }
  return (
    <div className="field" style={{ marginBottom: 0, display: 'grid', gap: 8 }}>
      <label className="label" htmlFor={id}>{t('cpPaidByLabel')}</label>
      <select
        id={id}
        className="select"
        value={paidBy.paidBy?.id ?? ''}
        onChange={e => void paidBy.setPaidBy(e.target.value || null)}
        disabled={paidBy.saving}
        style={{ width: '100%' }}
      >
        <option value="">{t('cpPaidByNone')}</option>
        {paidBy.options.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </div>
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
