// Off-ramp dialog: marks a Sell Order Closed with a structured reason +
// freeform note. Backend POST /api/sell-orders/:id/status validates both
// (closeReasonId must be active in sell_order_close_reasons; note satisfies
// the evidence gate). Mirrors StatusChangeDialog scaffolding (modal-backdrop
// + modal-shell, useEscapeKey, inline error banner) so users get the same
// modal feel across all status transitions.

import { useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { useEscapeKey } from '../lib/useEscapeKey';
import { useT } from '../lib/i18n';
import { closeReasons } from '../lib/lookups';

type Props = {
  orderId: string;
  currentStatus: string;
  onCancel: () => void;
  // Fired once the backend has flipped the order to Closed. Parent should
  // re-fetch the order so it sees the new status + close_reason_id.
  onClosed: () => void;
};

export function CloseSellOrderDialog({ orderId, currentStatus, onCancel, onClosed }: Props) {
  const { t } = useT();
  const [reasonId, setReasonId] = useState<string>(closeReasons[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onCancel);

  const canSubmit = reasonId.length > 0 && note.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/sell-orders/${orderId}/status`, {
        to: 'Closed',
        closeReasonId: reasonId,
        note: note.trim(),
      });
      onClosed();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('discardSoError'));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ zIndex: 110 }}
    >
      <div className="modal-shell" style={{ maxWidth: 520, width: 'calc(100vw - 80px)' }}>
        {/* Header */}
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 14,
        }}>
          <span
            className="chip muted"
            style={{
              width: 38, height: 38, padding: 0, borderRadius: 10,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            <Icon name="x" size={18} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg)' }}>{t('discardSoTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {t('discardSoSub')}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="chip" style={{ fontSize: 11 }}>{currentStatus}</span>
              <Icon name="arrow" size={10} />
              <span className="chip muted" style={{ fontSize: 11 }}>{t('discardSoStatusClosed')}</span>
            </div>
          </div>
          <button className="btn icon sm" onClick={onCancel} title={t('cancel')}>
            <Icon name="x" size={13} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 24, display: 'grid', gap: 18 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label">{t('discardSoReasonLabel')}</label>
            <select
              className="select"
              value={reasonId}
              onChange={e => setReasonId(e.target.value)}
              autoFocus
            >
              {closeReasons.length === 0 && <option value="">{t('discardSoNoReasons')}</option>}
              {closeReasons.map(r => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label">{t('discardSoNoteLabel')}</label>
            <textarea
              className="input"
              rows={4}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t('discardSoNoteReasonPlaceholder')}
              style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            />
          </div>

          {error && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'var(--neg-soft)', color: 'var(--neg)', fontSize: 12.5,
            }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
        }}>
          <button
            className="btn"
            onClick={submit}
            disabled={!canSubmit}
            style={{ background: 'var(--neg, #c0392b)', color: '#fff', borderColor: 'transparent' }}
          >
            {submitting ? t('discardSoSubmitting') : t('discardSoSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}

// Mirrors CloseSellOrderDialog minus the structured reason picker. Reopen
// (Closed → Draft) only needs a freeform note — the backend hard-requires
// it inside the transaction. On success the parent re-fetches.
type ReopenProps = {
  orderId: string;
  onCancel: () => void;
  onReopened: () => void;
};

export function ReopenSellOrderDialog({ orderId, onCancel, onReopened }: ReopenProps) {
  const { t } = useT();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onCancel);

  const canSubmit = note.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/api/sell-orders/${orderId}/status`, {
        to: 'Draft',
        note: note.trim(),
      });
      onReopened();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('reopenSoError'));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ zIndex: 110 }}
    >
      <div className="modal-shell" style={{ maxWidth: 480, width: 'calc(100vw - 80px)' }}>
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 14,
        }}>
          <span
            className="chip accent"
            style={{
              width: 38, height: 38, padding: 0, borderRadius: 10,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            <Icon name="edit" size={18} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg)' }}>{t('reopenSoTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {t('reopenSoSub')}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="chip muted" style={{ fontSize: 11 }}>{t('discardSoStatusClosed')}</span>
              <Icon name="arrow" size={10} />
              <span className="chip" style={{ fontSize: 11 }}>{t('reopenSoStatusDraft')}</span>
            </div>
          </div>
          <button className="btn icon sm" onClick={onCancel} title={t('cancel')}>
            <Icon name="x" size={13} />
          </button>
        </div>

        <div style={{ padding: 24, display: 'grid', gap: 18 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label">{t('discardSoNoteLabel')}</label>
            <textarea
              className="input"
              rows={3}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={t('reopenSoNotePlaceholder')}
              style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              autoFocus
            />
          </div>

          {error && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'var(--neg-soft)', color: 'var(--neg)', fontSize: 12.5,
            }}>{error}</div>
          )}
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
        }}>
          <button
            className="btn accent"
            onClick={submit}
            disabled={!canSubmit}
          >
            {submitting ? t('reopenSoSubmitting') : t('reopenSoSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}
