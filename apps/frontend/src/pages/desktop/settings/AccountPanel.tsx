import { useState } from 'react';
import { ApiError, api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { useT } from '../../../lib/i18n';
import { Icon } from '../../../components/Icon';
import { PasswordMeter } from '../../../components/PasswordMeter';
import { pwStrengthLabels } from '../../../lib/passwordI18n';
import { SettingsHeader, type ToastFn } from './_shared';

// The desktop "Account" panel: identity card + password-change form +
// sessions note. Validation matches the backend: 8+ char min, must differ
// from current. Confirmation is client-only — the API only takes the
// current + new pair.

export function AccountPanel({ showToast }: { showToast?: ToastFn }) {
  const { t } = useT();
  const { user } = useAuth();

  const [current, setCurrent] = useState('');
  const [next, setNext]       = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);

  if (!user) return null;

  const newTooShort   = next.length > 0 && next.length < 8;
  const sameAsCurrent = next.length > 0 && current.length > 0 && next === current;
  const confirmMismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    current.length > 0 &&
    next.length >= 8 &&
    next === confirm &&
    next !== current &&
    !saving;

  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await api.post('/api/me/password', { currentPassword: current, newPassword: next });
      showToast?.(t('pwSuccess'), 'success');
      reset();
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 403 ? t('pwErrorWrongCurrent')
        : err instanceof ApiError && err.status === 429 ? t('pwErrorTooManyAttempts')
        : t('pwErrorGeneric');
      setError(msg);
      showToast?.(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SettingsHeader title={t('accountPanelTitle')} sub={t('accountPanelSub')} />

      {/* Identity card */}
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('accountIdentityTitle')}</div>
          </div>
        </div>
        <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div className="avatar" style={{ width: 56, height: 56, fontSize: 18 }}>
            {user.initials}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.005em' }}>
              {user.name}
            </div>
            <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {user.email}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 24, flexShrink: 0 }}>
            <Meta label={t('accountIdentityRole')} value={user.role === 'manager' ? t('role_manager') : t('role_purchaser')} />
            {user.team && <Meta label={t('memFieldTeam')} value={user.team} />}
          </div>
        </div>
      </div>

      {/* Change-password card */}
      <form
        className="card"
        style={{ marginTop: 'var(--gap)' }}
        onSubmit={submit}
        autoComplete="off"
      >
        <div className="card-head">
          <div>
            <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="lock" size={13} style={{ color: 'var(--accent-strong)' }} />
              {t('changePassword')}
            </div>
            <div className="card-sub" style={{ marginTop: 2 }}>{t('changePasswordSub')}</div>
          </div>
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 16, maxWidth: 480 }}>
          <div className="field">
            <label className="label" htmlFor="acc-pw-cur">{t('currentPassword')}</label>
            <div className="pw-input">
              <input
                id="acc-pw-cur"
                className="input"
                type={showCur ? 'text' : 'password'}
                value={current}
                placeholder={t('pwPlaceholderCurrent')}
                autoComplete="current-password"
                onChange={(e) => { setCurrent(e.target.value); setError(null); }}
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowCur((s) => !s)}
                tabIndex={-1}
              >
                <Icon name="eye" size={12} />
                {showCur ? t('pwHide') : t('pwShow')}
              </button>
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="acc-pw-new">{t('newPassword')}</label>
            <div className="pw-input">
              <input
                id="acc-pw-new"
                className="input"
                type={showNew ? 'text' : 'password'}
                value={next}
                placeholder={t('pwPlaceholderNew')}
                autoComplete="new-password"
                onChange={(e) => setNext(e.target.value)}
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowNew((s) => !s)}
                tabIndex={-1}
              >
                <Icon name="eye" size={12} />
                {showNew ? t('pwHide') : t('pwShow')}
              </button>
            </div>
            <PasswordMeter password={next} labels={pwStrengthLabels(t)} />
            {(newTooShort || sameAsCurrent) ? (
              <div className="help" style={{ color: 'var(--neg)' }}>
                {sameAsCurrent ? t('pwSameAsCurrent') : t('pwTooShortHelp')}
              </div>
            ) : (
              <div className="help">{t('pwTooShortHelp')}</div>
            )}
          </div>

          <div className="field">
            <label className="label" htmlFor="acc-pw-confirm">{t('confirmPassword')}</label>
            <input
              id="acc-pw-confirm"
              className="input"
              type={showNew ? 'text' : 'password'}
              value={confirm}
              placeholder={t('pwPlaceholderConfirm')}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
            />
            {confirm.length > 0 && (
              <div
                style={{
                  marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 5,
                  fontSize: 11.5, fontWeight: 500,
                  color: confirmMismatch ? 'var(--neg)' : 'var(--pos)',
                }}
              >
                <Icon name={confirmMismatch ? 'x' : 'check'} size={11} />
                {confirmMismatch ? t('pwMatchOff') : t('pwMatchOk')}
              </div>
            )}
          </div>

          {error && (
            <div
              style={{
                padding: '10px 12px', borderRadius: 8,
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

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="btn"
              onClick={reset}
              disabled={saving || (!current && !next && !confirm)}
            >
              {t('cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={!canSubmit}>
              {saving ? t('pwSubmitting') : t('pwSubmit')}
            </button>
          </div>
        </div>
      </form>

      {/* Sessions note */}
      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-body" style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div
            style={{
              width: 36, height: 36, borderRadius: 9,
              background: 'var(--accent-soft)', color: 'var(--accent-strong)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}
          >
            <Icon name="shield" size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('pwSessionsTitle')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 3, lineHeight: 1.5 }}>
              {t('pwSessionsBody')}
            </div>
          </div>
        </div>
      </div>

    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500, marginTop: 3 }}>{value}</div>
    </div>
  );
}
