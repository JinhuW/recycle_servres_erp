import { useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { PasswordMeter } from './PasswordMeter';
import { pwStrengthLabels } from '../lib/passwordI18n';
import { validatePasswordChange, passwordChangeErrorKey } from '../lib/passwordPolicy';

type Props = {
  onClose: () => void;
  onSuccess: (msg: string) => void;
};

// Mobile bottom-sheet for changing the signed-in user's password. Mirrors the
// desktop AccountPanel logic (8+ char min, must match confirm, must differ
// from current) but laid out for one-handed phone use: stacked fields, big
// tap targets, single primary action in the header.

export function PhPasswordSheet({ onClose, onSuccess }: Props) {
  const { t } = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext]       = useState('');
  const [confirm, setConfirm] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showCur, setShowCur] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const { newTooShort, sameAsCurrent, confirmMismatch, canSubmit: valid } =
    validatePasswordChange(current, next, confirm);
  const canSubmit = valid && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await api.post('/api/me/password', { currentPassword: current, newPassword: next });
      onSuccess(t('pwSuccess'));
      onClose();
    } catch (err) {
      setError(t(passwordChangeErrorKey(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onClose} />
      <div
        className="ph-sheet"
        style={{ maxHeight: '88%', display: 'flex', flexDirection: 'column', paddingBottom: 18 }}
      >
        <div className="ph-sheet-grabber" />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 6px' }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              background: 'transparent', border: 'none', color: 'var(--fg-muted)',
              fontSize: 14, fontFamily: 'inherit', padding: 4, cursor: saving ? 'default' : 'pointer',
            }}
          >
            {t('cancel')}
          </button>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {t('pwSheetTitle')}
          </div>
          <button
            onClick={submit}
            disabled={!canSubmit}
            style={{
              background: 'transparent', border: 'none',
              color: canSubmit ? 'var(--accent-strong)' : 'var(--fg-subtle)',
              fontSize: 14, fontWeight: 600, fontFamily: 'inherit', padding: 4,
              cursor: canSubmit ? 'pointer' : 'default',
            }}
          >
            {saving ? t('pwSubmitting') : t('save')}
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', padding: '0 4px 16px', lineHeight: 1.5 }}>
          {t('pwSheetSub')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <PhField
            id="ph-pw-cur"
            label={t('currentPassword')}
            value={current}
            placeholder={t('pwPlaceholderCurrent')}
            show={showCur}
            onToggleShow={() => setShowCur((s) => !s)}
            onChange={(v) => { setCurrent(v); setError(null); }}
            autoComplete="current-password"
          />

          <div>
            <PhField
              id="ph-pw-new"
              label={t('newPassword')}
              value={next}
              placeholder={t('pwPlaceholderNew')}
              show={showNew}
              onToggleShow={() => setShowNew((s) => !s)}
              onChange={setNext}
              autoComplete="new-password"
            />
            <div style={{ padding: '0 4px' }}>
              <PasswordMeter password={next} labels={pwStrengthLabels(t)} />
              {(newTooShort || sameAsCurrent) && (
                <div style={{ fontSize: 11.5, color: 'var(--neg)', marginTop: 6, lineHeight: 1.45 }}>
                  {sameAsCurrent ? t('pwSameAsCurrent') : t('pwTooShortHelp')}
                </div>
              )}
            </div>
          </div>

          <div>
            <PhField
              id="ph-pw-confirm"
              label={t('confirmPassword')}
              value={confirm}
              placeholder={t('pwPlaceholderConfirm')}
              show={showNew}
              onToggleShow={() => setShowNew((s) => !s)}
              onChange={setConfirm}
              autoComplete="new-password"
            />
            {confirm.length > 0 && (
              <div
                style={{
                  marginTop: 6, padding: '0 4px',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  fontSize: 11.5, fontWeight: 500,
                  color: confirmMismatch ? 'var(--neg)' : 'var(--pos)',
                }}
              >
                <Icon name={confirmMismatch ? 'x' : 'check'} size={11} />
                {confirmMismatch ? t('pwMatchOff') : t('pwMatchOk')}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div
            style={{
              marginTop: 14, padding: '10px 12px', borderRadius: 10,
              background: 'var(--neg-soft, rgba(220, 50, 50, 0.07))',
              color: 'var(--neg)',
              fontSize: 12.5, fontWeight: 500,
              border: '1px solid var(--neg)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <Icon name="alert" size={13} />
            {error}
          </div>
        )}

        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 8,
            marginTop: 18, padding: '10px 12px',
            background: 'var(--accent-soft)', borderRadius: 10,
            fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.5,
          }}
        >
          <Icon name="shield" size={13} style={{ marginTop: 2, flexShrink: 0, color: 'var(--accent-strong)' }} />
          <span>{t('pwSessionsBody')}</span>
        </div>
      </div>
    </>
  );
}

type FieldProps = {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  show: boolean;
  onToggleShow: () => void;
  onChange: (v: string) => void;
  autoComplete: string;
};

function PhField({ id, label, value, placeholder, show, onToggleShow, onChange, autoComplete }: FieldProps) {
  const { t } = useT();
  return (
    <div>
      <label
        htmlFor={id}
        style={{
          display: 'block', fontSize: 11.5, fontWeight: 500,
          color: 'var(--fg-subtle)', textTransform: 'uppercase',
          letterSpacing: '0.06em', padding: '0 4px 6px',
        }}
      >
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%',
            padding: '14px 70px 14px 14px',
            fontSize: 15,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            color: 'var(--fg)',
            fontFamily: 'inherit',
            outline: 'none',
            transition: 'border-color 0.15s',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
        />
        <button
          type="button"
          onClick={onToggleShow}
          tabIndex={-1}
          style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11, fontWeight: 500, color: 'var(--fg-subtle)',
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '6px 10px', borderRadius: 6, fontFamily: 'inherit',
          }}
        >
          <Icon name="eye" size={12} />
          {show ? t('pwHide') : t('pwShow')}
        </button>
      </div>
    </div>
  );
}
