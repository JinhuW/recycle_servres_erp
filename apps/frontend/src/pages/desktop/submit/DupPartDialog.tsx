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
  /** Closes the dialog and opens the product at that list index, to fold the repeat into its quantity. */
  onOpenLine?: (idx: number) => void;
};

// The warning shown before a PO with repeated part numbers goes to the server.
export function DupPartDialog({
  groups, refOf, busy, confirmTone, confirmLabel, onClose, onConfirm, onOpenLine,
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
        <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: onOpenLine ? 10 : 6, fontSize: 13 }}>
          {groups.map(g => (
            <li key={g.partNumber.toLowerCase()}>
              {t('dupPartModalRow', { pn: g.partNumber, nums: [...new Set(g.idxs.map(refOf))].join(', ') })}
              {/* The first product is the one already on the PO; the later
                  rows repeat it, so that is where the units belong. */}
              {onOpenLine && (
                <div style={{ marginTop: 4 }}>
                  <button className="btn sm" disabled={busy} onClick={() => onOpenLine(g.idxs[0])}>
                    {t('dupPartOpenLine', { line: refOf(g.idxs[0]) })}
                  </button>
                </div>
              )}
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
