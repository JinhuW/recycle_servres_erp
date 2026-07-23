import { Icon } from '../../../components/Icon';
import { useEscapeKey } from '../../../lib/useEscapeKey';
import { useT } from '../../../lib/i18n';

export function ConfirmDialog({
  title, message, confirmLabel, danger, onCancel, onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  useEscapeKey(onCancel);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-shell" style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: danger ? 'var(--neg-soft)' : 'var(--accent-soft)',
              color: danger ? 'var(--neg)' : 'var(--accent-strong)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon name={danger ? 'alert' : 'info'} size={18} />
            </div>
            <div>
              <div className="modal-title">{title}</div>
              <div className="modal-sub">{message}</div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>{t('cancel')}</button>
          <button
            className="btn"
            style={danger
              ? { background: 'var(--neg)', color: 'white', borderColor: 'var(--neg)' }
              : { background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)' }}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
