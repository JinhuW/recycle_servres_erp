import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import { useEscapeKey } from '../../../lib/useEscapeKey';

// ─── Danger zone confirm dialog ──────────────────────────────────────────────
export function DangerConfirmDialog({
  kind, onCancel, onConfirm,
}: {
  kind: 'transfer' | 'delete';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const PHRASE = kind === 'delete' ? 'DELETE WORKSPACE' : 'TRANSFER';
  const [phrase, setPhrase] = useState('');
  const matches = phrase.trim() === PHRASE;

  useEscapeKey(onCancel);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-shell" style={{ maxWidth: 460 }}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'var(--neg-soft)', color: 'var(--neg)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon name="alert" size={18} />
            </div>
            <div>
              <div className="modal-title">
                {kind === 'delete' ? 'Delete this workspace?' : 'Transfer workspace ownership?'}
              </div>
              <div className="modal-sub">
                {kind === 'delete'
                  ? 'All orders, inventory, sell orders and audit logs will be permanently deleted. This cannot be undone.'
                  : 'You will be demoted to purchaser. Only the new owner can change roles, billing, or workspace settings.'}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="label">
              Type <span className="mono">{PHRASE}</span> to confirm
            </label>
            <input
              className="input mono"
              value={phrase}
              onChange={e => setPhrase(e.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button
            className="btn"
            style={{
              background: 'var(--neg)', color: 'white',
              borderColor: 'var(--neg)',
              opacity: matches ? 1 : 0.5,
            }}
            disabled={!matches}
            onClick={onConfirm}
          >
            {kind === 'delete' ? 'Delete workspace' : 'Transfer ownership'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
          <button className="btn" onClick={onCancel}>Cancel</button>
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
