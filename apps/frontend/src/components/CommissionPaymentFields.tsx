import { AttachmentChip } from './AttachmentChip';
import { AttachmentDropzone } from './AttachmentDropzone';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import type { ProofAttachment } from '../lib/usePaymentProof';

// The commission payment — the screenshot that shows the purchaser was paid
// — on the desktop Commission tab and in the phone fold, one component so the
// two cannot drift. Files go straight to the order's Commission bucket as
// they are dropped; there is no Save. The Done dialog offers the same box on
// the way to Done when nothing is here yet. No panel around it: the drop box
// is the whole thing.

export type CommissionShots = {
  atts: ProofAttachment[];
  uploading: boolean;
  add: (files: FileList | null) => void;
  remove: (att: ProofAttachment) => void;
};

type Props = {
  shots: CommissionShots;
  /** Managers edit; everyone else reads what is on file. */
  editable: boolean;
};

export function CommissionPaymentFields({ shots, editable }: Props) {
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
