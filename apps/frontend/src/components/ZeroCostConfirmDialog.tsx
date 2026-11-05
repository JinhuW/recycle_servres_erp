// Asked when a PO with $0 products leaves Draft, by whoever submits it and while
// they can still correct the price. The server holds an all-$0 PO to this answer.

import { Icon } from './Icon';
import { Modal } from './Modal';
import { useT } from '../lib/i18n';
import { lineRef, newOrdinals } from '../lib/productNo';

type Line = { no?: number | null; partNumber?: string | null; description?: string | null };

export function ZeroCostConfirmDialog({ lines, onCancel, onConfirm }: {
  lines: readonly Line[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  const newNos = newOrdinals(lines);
  return (
    <Modal onClose={onCancel} shellStyle={{ maxWidth: 460 }} ariaLabel={t('poZeroCostTitle')}>
      <div className="modal-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: 'var(--warn-soft)', color: 'var(--warn)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Icon name="flag" size={18} />
          </div>
          <div>
            <div className="modal-title">{t('poZeroCostTitle')}</div>
            <div className="modal-sub">{t('poZeroCostMsg')}</div>
          </div>
        </div>
      </div>
      <ul style={{ margin: 0, padding: '4px 20px 12px 38px', fontSize: 13, maxHeight: 200, overflowY: 'auto' }}>
        {lines.map((l, i) => (
          <li key={i}>
            {lineRef(l, t, newNos[i])}{l.no != null && l.partNumber ? ` · ${l.partNumber}` : ''}
          </li>
        ))}
      </ul>
      <div className="modal-foot">
        <button className="btn" onClick={onCancel} autoFocus>{t('poZeroCostBack')}</button>
        <button className="btn accent" onClick={onConfirm}>{t('poZeroCostConfirm')}</button>
      </div>
    </Modal>
  );
}
