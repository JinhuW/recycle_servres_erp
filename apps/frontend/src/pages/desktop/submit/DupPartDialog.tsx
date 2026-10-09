import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { useT } from '../../../lib/i18n';
import type { DuplicatePartGroup } from './line';

type Props = {
  groups: DuplicatePartGroup[];
  /** How a line at a list index is named: lineRef over the page's lines. */
  refOf: (idx: number) => string;
  busy: boolean;
  /** Button tone: the capture form submits (`accent`), the edit page saves (`primary`). */
  confirmTone: 'accent' | 'primary';
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
};

// The warning shown before a PO with repeated part numbers goes to the server.
export function DupPartDialog({
  groups, refOf, busy, confirmTone, confirmLabel, onClose, onConfirm,
}: Props) {
  const { t } = useT();
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 480 }}>
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
              {t('dupPartModalRow', { pn: g.partNumber, nums: [...new Set(g.idxs.map(refOf))].join(', ') })}
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
    </Modal>
  );
}
