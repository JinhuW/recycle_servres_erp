import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import type { Lang } from '../lib/types';

type DemoAccount = { id: string; email: string; name: string; initials: string; role: 'manager' | 'purchaser'; team: string | null };

type Props = { initialPicking?: boolean; variant?: 'mobile' | 'desktop' };

// Compact EN/中 toggle pinned to the top-right of the desktop login screen,
// matching design/login.jsx (the desktop shell has no sidebar at sign-in).
function DesktopLanguageToggle() {
  const { lang, setLang, t } = useT();
  const opts: { v: Lang; label: string }[] = [
    { v: 'en', label: 'EN' },
    { v: 'zh', label: '中' },
  ];
  return (
    <div
      role="group"
      aria-label={t('languageLabel')}
      style={{
        position: 'absolute', top: 18, right: 18,
        display: 'inline-flex', alignItems: 'center',
        background: 'var(--bg-elev)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 2, fontSize: 11.5, fontWeight: 600,
      }}
    >
      {opts.map(o => {
        const active = lang === o.v;
        return (
          <button
            key={o.v}
            onClick={() => setLang(o.v)}
            aria-pressed={active}
            style={{
              border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              padding: '4px 10px', borderRadius: 6, minWidth: 28,
              background: active ? 'var(--bg-soft)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-subtle)',
              fontSize: 11.5, fontWeight: 600,
              letterSpacing: o.v === 'zh' ? 0 : '0.04em',
            }}
            title={o.v === 'en' ? 'English' : '简体中文'}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

export function Login({ initialPicking = false, variant = 'mobile' }: Props) {
  const { t } = useT();
  const { login } = useAuth();
  const [picking, setPicking] = useState(initialPicking);
  const [email, setEmail] = useState('marcus@recycleservers.io');
  const [password, setPassword] = useState('demo');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);

  // Load demo accounts when the user lands on the picker (so the avatars are
  // accurate to the real seed, not a hard-coded list).
  useEffect(() => {
    if (!picking || accounts.length > 0) return;
    api.get<{ users: DemoAccount[] }>('/api/auth/demo-accounts')
      .then(r => {
        // Desktop picker mirrors the design: one manager + one purchaser
        // demo seat. Mobile picker shows purchasers only.
        if (variant === 'desktop') {
          const mgr = r.users.find(u => u.role === 'manager');
          const purchaser = r.users.find(u => u.role === 'purchaser');
          setAccounts([mgr, purchaser].filter(Boolean) as DemoAccount[]);
        } else {
          setAccounts(r.users.filter(u => u.role === 'purchaser').slice(0, 4));
        }
      })
      .catch(() => {/* swallow — keep the picker usable */});
  }, [picking, accounts.length, variant]);

  const submitEmail = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
      setSubmitting(false);
    }
  };

  const loginAs = async (account: DemoAccount) => {
    setError(null);
    setSubmitting(true);
    try {
      await login(account.email, 'demo');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
      setSubmitting(false);
    }
  };

  return variant === 'desktop'
    ? renderDesktop()
    : renderMobile();

  // ── Desktop variant — matches design/login.jsx ────────────────────────────
  function renderDesktop() {
    return (
      <div className="login-shell" style={{ position: 'relative' }}>
        <DesktopLanguageToggle />
        <div className="login-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
            <div className="brand-mark" style={{ width: 40, height: 40, fontSize: 16 }}>RS</div>
            <div>
              <div style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{t('appBrand')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('inventoryProfit')}</div>
            </div>
          </div>

          {!picking ? (
            <>
              <h1 style={{ fontSize: 22, margin: '0 0 4px', letterSpacing: '-0.02em' }}>{t('signInTitle')}</h1>
              <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '0 0 22px' }}>{t('signInSub')}</p>

              <div className="col" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="field">
                  <label className="label">{t('workEmail')}</label>
                  <input
                    className="input"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@recycleservers.io"
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                </div>
                <div className="field">
                  <label className="label">{t('password')}</label>
                  <input
                    className="input"
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={t('passwordPh')}
                  />
                </div>

                {error && (
                  <div style={{ padding: '10px 12px', background: 'var(--neg-soft)', color: 'var(--neg)', borderRadius: 10, fontSize: 12.5 }}>
                    {error}
                  </div>
                )}

                <button
                  className="btn accent lg"
                  style={{ justifyContent: 'center', marginTop: 6 }}
                  onClick={submitEmail}
                  disabled={submitting}
                >
                  {submitting ? '…' : t('continue')} <Icon name="arrow" size={14} />
                </button>
              </div>

              <button
                onClick={() => setPicking(true)}
                style={{
                  marginTop: 14, fontSize: 12.5, color: 'var(--accent-strong)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontWeight: 500, display: 'block', marginLeft: 'auto', marginRight: 'auto',
                }}
              >
                {t('continueAs')} →
              </button>

              <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--fg-subtle)', marginTop: 18 }}>
                {t('ssoNote')}
              </div>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 20, margin: '0 0 4px', letterSpacing: '-0.02em' }}>{t('continueAs')}</h1>
              <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '0 0 18px' }}>{t('continueAsSub')}</p>

              {error && (
                <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--neg-soft)', color: 'var(--neg)', borderRadius: 10, fontSize: 12.5 }}>
                  {error}
                </div>
              )}

              <div className="col" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {accounts.length === 0 && (
                  <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', padding: 14 }}>{t('loadingAccounts')}</div>
                )}
                {accounts.map(u => (
                  <button
                    key={u.id}
                    className="card"
                    style={{
                      padding: 14, display: 'flex', alignItems: 'center', gap: 12,
                      cursor: 'pointer', textAlign: 'left', background: 'var(--bg-elev)',
                      borderRadius: 10, border: '1px solid var(--border)', fontFamily: 'inherit',
                    }}
                    onClick={() => loginAs(u)}
                    disabled={submitting}
                  >
                    <div className="avatar lg">{u.initials}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{u.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                        {u.role === 'manager' ? t('managerFullAccess') : t('purchaserOwn')}
                      </div>
                    </div>
                    <span className="chip">
                      <Icon name={u.role === 'manager' ? 'shield' : 'user'} size={12} />
                      {u.role === 'manager' ? t('role_admin') : t('role_purchaser')}
                    </span>
                  </button>
                ))}
              </div>
              <button
                className="btn ghost"
                style={{ marginTop: 12, fontSize: 12 }}
                onClick={() => setPicking(false)}
              >
                <Icon name="chevronLeft" size={12} /> {t('back')}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Mobile variant — preserved from the existing phone implementation ─────
  function renderMobile() {
    return (
      <div className="phone-app">
        <div className="ph-login-shell">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 30 }}>
            <div className="brand-mark" style={{ width: 44, height: 44, fontSize: 18 }}>RS</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16 }}>{t('appBrand')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('brandSub')}</div>
            </div>
          </div>

          {!picking ? (
            <>
              <h1 style={{ fontSize: 28, margin: '0 0 4px', letterSpacing: '-0.025em', fontWeight: 600 }}>{t('signIn')}</h1>
              <p style={{ fontSize: 13.5, color: 'var(--fg-subtle)', margin: '0 0 24px' }}>{t('signInSub')}</p>

              <div className="ph-field" style={{ marginTop: 0 }}>
                <label>{t('workEmail')}</label>
                <input className="input" value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="off" autoCorrect="off" />
              </div>
              <div className="ph-field">
                <label>{t('password')}</label>
                <input className="input" type="password" placeholder={t('passwordPh')} value={password} onChange={e => setPassword(e.target.value)} />
              </div>

              {error && (
                <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--neg-soft)', color: 'var(--neg)', borderRadius: 10, fontSize: 12.5 }}>
                  {error}
                </div>
              )}

              <button
                className="ph-btn accent"
                style={{ marginTop: 18, height: 50, fontSize: 14, flex: 'none', width: '100%' }}
                onClick={submitEmail}
                disabled={submitting}
              >
                {submitting ? '…' : t('continue')} <Icon name="arrow" size={13} />
              </button>

              <button
                onClick={() => setPicking(true)}
                style={{ marginTop: 14, fontSize: 12.5, color: 'var(--accent-strong)', background: 'none', border: 'none', alignSelf: 'center', fontWeight: 500 }}
              >
                {t('continueAs')} →
              </button>

              <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--fg-subtle)', marginTop: 18 }}>
                {t('ssoNote')}
              </div>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 22, margin: '0 0 4px', letterSpacing: '-0.02em', fontWeight: 600 }}>{t('continueAs')}</h1>
              <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '0 0 18px' }}>{t('continueAsSub')}</p>

              {error && (
                <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--neg-soft)', color: 'var(--neg)', borderRadius: 10, fontSize: 12.5 }}>
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {accounts.length === 0 && (
                  <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', padding: 14 }}>{t('loadingAccounts')}</div>
                )}
                {accounts.map(u => (
                  <button key={u.id} className="ph-cat-card" disabled={submitting} onClick={() => loginAs(u)}>
                    <div className="avatar lg">{u.initials}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{u.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                        {u.role === 'manager' ? t('managerFullAccess') : t('purchaserOwn')}
                      </div>
                    </div>
                    <span className="chip">
                      <Icon name={u.role === 'manager' ? 'shield' : 'user'} size={12} />
                      {u.role === 'manager' ? t('role_admin') : t('role_purchaser')}
                    </span>
                  </button>
                ))}
              </div>
              <button onClick={() => setPicking(false)} style={{ marginTop: 12, fontSize: 12, color: 'var(--fg-muted)', background: 'none', border: 'none', alignSelf: 'flex-start' }}>
                <Icon name="chevronLeft" size={11} /> {t('signInBack')}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }
}
