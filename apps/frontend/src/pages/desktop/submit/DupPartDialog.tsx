import { Icon } from '../../../components/Icon';
import { useT } from '../../../lib/i18n';
import type { DuplicatePartGroup } from './line';

type Props = {
  groups: DuplicatePartGroup[];
  busy: boolean;
  /** Button tone: the capture form submits (`accent`), the edit page saves (`primary`). */
  confirmTone: 'accent' | 'primary';
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
};

// The warning shown before a PO with repeated part numbers goes to the server.
export function DupPartDialog({
  groups, busy, confirmTone, confirmLabel, onClose, onConfirm,
}: Props) {
  const { t } = useT();
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon name="alert" size={18} />
            </div>
            <div>
              <div className="modal-title">{t('dupPartModalTitle')}</div>
              <div className="modal-sub">{t('dupPartModalSub')}</div>
            </div>
          </div>
        </div>
        <div className="modal-body">
          <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
            {groups.map(g => (
              <li key={g.partNumber.toLowerCase()}>
                {(g.lineNums.length === 1 ? t('dupPartModalRowOne') : t('dupPartModalRowMany'))
                  .replace('{pn}', g.partNumber)
                  .replace('{nums}', g.lineNums.join(', '))}
              </li>
            ))}
          </ul>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={busy}>
            {t('dupPartReview')}
          </button>
          <button
            className={'btn ' + confirmTone}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
