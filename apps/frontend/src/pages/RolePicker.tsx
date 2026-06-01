import { Icon } from '../components/Icon';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { useTweaks, type RolePreview } from '../lib/tweaks';

// Post-login gate for managers. The auth row stays role='manager' (the server
// keeps full trust), but the chosen rolePreview narrows the UI to the
// purchaser shell when picked. Rendered by DesktopApp / MobileApp when
// useAuth().pendingRoleChoice is true. Reload doesn't re-arm the flag — the
// stored rolePreview governs from then on; users can flip it from Settings →
// Tweaks at any time.
type Props = { variant?: 'desktop' | 'mobile' };

export function RolePicker({ variant = 'mobile' }: Props) {
  const { t } = useT();
  const { user, confirmRoleChoice } = useAuth();
  const { rolePreview, setRolePreview } = useTweaks();

  const pick = (mode: RolePreview) => {
    setRolePreview(mode);
    confirmRoleChoice();
  };

  const options: Array<{
    mode: RolePreview;
    icon: 'shield' | 'user';
    title: string;
    sub: string;
    chip: string;
  }> = [
    {
      mode: 'actual',
      icon: 'shield',
      title: t('continueAsManager'),
      sub: t('managerFullAccess'),
      chip: t('role_admin'),
    },
    {
      mode: 'as_purchaser',
      icon: 'user',
      title: t('continueAsPurchaser'),
      sub: t('purchaserOwn'),
      chip: t('role_purchaser'),
    },
  ];

  return variant === 'desktop' ? renderDesktop() : renderMobile();

  function renderDesktop() {
    return (
      <div className="login-shell" style={{ position: 'relative' }}>
        <div className="login-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
            <div className="brand-mark" style={{ width: 40, height: 40, fontSize: 16 }}>RS</div>
            <div>
              <div style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>{t('appBrand')}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('inventoryProfit')}</div>
            </div>
          </div>

          <h1 style={{ fontSize: 20, margin: '0 0 4px', letterSpacing: '-0.02em' }}>
            {t('rolePickerTitle', { name: user?.name ?? '' })}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '0 0 18px' }}>
            {t('rolePickerSub')}
          </p>

          <div className="col" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {options.map(o => {
              const active = o.mode === rolePreview;
              return (
                <button
                  key={o.mode}
                  className="card"
                  onClick={() => pick(o.mode)}
                  style={{
                    padding: 14, display: 'flex', alignItems: 'center', gap: 12,
                    cursor: 'pointer', textAlign: 'left',
                    background: active ? 'var(--accent-soft, var(--bg-elev))' : 'var(--bg-elev)',
                    borderRadius: 10,
                    border: `1px solid ${active ? 'var(--accent-strong)' : 'var(--border)'}`,
                    fontFamily: 'inherit',
                  }}
                >
                  <div className="avatar lg"><Icon name={o.icon} size={16} /></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{o.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{o.sub}</div>
                  </div>
                  <span className="chip">
                    <Icon name={o.icon} size={12} />
                    {o.chip}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--fg-subtle)', marginTop: 18 }}>
            {t('rolePickerHint')}
          </div>
        </div>
      </div>
    );
  }

  function renderMobile() {
    // Mobile is purchaser-first: lead with 'Continue as Purchaser' so it reads
    // as the default. Managers still tap 'Continue as Manager' to enter with
    // full access — the gate is never skipped.
    const mobileOrder = [
      options.find(o => o.mode === 'as_purchaser')!,
      options.find(o => o.mode === 'actual')!,
    ];
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

          <h1 style={{ fontSize: 22, margin: '0 0 4px', letterSpacing: '-0.02em', fontWeight: 600 }}>
            {t('rolePickerTitle', { name: user?.name ?? '' })}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--fg-subtle)', margin: '0 0 18px' }}>
            {t('rolePickerSub')}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {mobileOrder.map(o => {
              // Purchaser is the highlighted default on mobile regardless of any
              // previously stored preview, matching the purchaser-first intent.
              const active = o.mode === 'as_purchaser';
              return (
                <button
                  key={o.mode}
                  className="ph-cat-card"
                  onClick={() => pick(o.mode)}
                  style={{
                    border: `1px solid ${active ? 'var(--accent-strong)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-soft, var(--bg-elev))' : 'var(--bg-elev)',
                  }}
                >
                  <div className="avatar lg"><Icon name={o.icon} size={16} /></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{o.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{o.sub}</div>
                  </div>
                  <span className="chip">
                    <Icon name={o.icon} size={12} />
                    {o.chip}
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--fg-subtle)', marginTop: 18 }}>
            {t('rolePickerHint')}
          </div>
        </div>
      </div>
    );
  }
}
