import { useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { RAM_BRANDS } from '../lib/catalog';

type Props = {
  // The scan's photo. Stub placeholders are filtered by the caller's existing
  // showThumb rule; a null here just drops the picture, it never blocks.
  photoUrl?: string | null;
  // What the model actually read, when that was a value we couldn't accept
  // (off-catalog, or "Other"). Shown so the purchaser knows what to disagree
  // with rather than being asked a bare question.
  aiRead?: string | null;
  // Seeded from the line, not from the scan — someone who already picked a
  // brand confirms in one click instead of re-picking it.
  brand?: string | null;
  onConfirm: (brand: string) => void;
  onRetake?: () => void;
  // The two shells reach a new photo differently — the phone reopens the
  // camera, the desktop drawer takes another file.
  retakeLabel?: string;
  onCancel: () => void;
};

/**
 * Blocking "look at the photo again" step for a RAM line whose brand the AI
 * couldn't identify. Shared by both shells: the desktop drawer and the phone
 * submit form gate their save on it.
 */
export function BrandConfirmDialog({ photoUrl, aiRead, brand, onConfirm, onRetake, retakeLabel, onCancel }: Props) {
  const { t } = useT();
  // An off-catalog reading ("Nanya") can be sitting on the line — it must not
  // seed the picker, or Confirm would be enabled on a value the <select> has
  // no option for and so shows as blank.
  const [picked, setPicked] = useState(
    brand && RAM_BRANDS.includes(brand) ? brand : '',
  );
  const [imgBroken, setImgBroken] = useState(false);
  const showPhoto = !!photoUrl && !imgBroken;

  return (
    <Modal onClose={onCancel} shellStyle={{ maxWidth: 420 }}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{t('brandConfirmTitle')}</div>
          <div className="modal-sub">{t('brandConfirmSub')}</div>
        </div>
        <Icon name="alert" size={16} />
      </div>
      <div className="modal-body">
        {showPhoto ? (
          <img
            src={photoUrl!}
            alt={t('aiPhotoLabel')}
            onError={() => setImgBroken(true)}
            style={{
              width: '100%', maxHeight: 220, objectFit: 'contain',
              borderRadius: 12, border: '1px solid var(--border)',
              background: 'var(--bg-soft)',
            }}
          />
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{t('brandConfirmNoPhoto')}</div>
        )}
        {!!aiRead && (
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>
            {t('brandConfirmAiRead', { value: aiRead })}
          </div>
        )}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, fontWeight: 600 }}>
          {t('brand')}
          <select
            className="select"
            value={picked}
            autoFocus
            onChange={e => setPicked(e.target.value)}
          >
            <option value="">{t('brandConfirmPick')}</option>
            {RAM_BRANDS.map(b => <option key={b}>{b}</option>)}
          </select>
        </label>
      </div>
      <div className="modal-foot" style={{ justifyContent: onRetake ? 'space-between' : 'flex-end' }}>
        {onRetake && (
          <button className="btn" onClick={onRetake}>
            <Icon name="camera" size={13} /> {retakeLabel ?? t('brandConfirmReupload')}
          </button>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onCancel}>{t('cancel')}</button>
          <button className="btn accent" disabled={!picked} onClick={() => onConfirm(picked)}>
            <Icon name="check" size={13} /> {t('brandConfirmCta')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
