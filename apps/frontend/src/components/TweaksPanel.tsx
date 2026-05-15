import { useState } from 'react';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { useTweaks } from '../lib/tweaks';
import { Icon } from './Icon';

// Floating developer/admin affordance to toggle density, role-preview, and
// language. Mirrors the design's TweaksPanelMount (app.jsx:312-350) but as a
// compact popover anchored to the bottom-right of the desktop shell.
export function TweaksPanel() {
  const [open, setOpen] = useState(false);
  const { t, lang, setLang } = useT();
  const { user } = useAuth();
  const { density, setDensity, rolePreview, setRolePreview } = useTweaks();

  return (
    <>
      <button
        className="tweaks-fab"
        onClick={() => setOpen((v) => !v)}
        title={t('tweaks')}
        aria-expanded={open}
      >
        <Icon name="settings" size={16} />
      </button>
      {open && (
        <div className="tweaks-pop" role="dialog" aria-label={t('tweaks')}>
          <div className="tweaks-pop-head">
            <span>{t('tweaks')}</span>
            <button className="btn ghost icon-only sm" onClick={() => setOpen(false)} title={t('cancel')}>
              <Icon name="x" size={14} />
            </button>
          </div>

          <TweakRadio
            label={t('languageLabel')}
            value={lang}
            onChange={(v) => setLang(v as 'en' | 'zh')}
            options={[
              { value: 'en', label: 'English' },
              { value: 'zh', label: '中文' },
            ]}
          />

          <TweakRadio
            label={t('density')}
            value={density}
            onChange={(v) => setDensity(v as 'comfortable' | 'compact')}
            options={[
              { value: 'comfortable', label: t('comfortable') },
              { value: 'compact', label: t('compact') },
            ]}
          />

          {user?.role === 'manager' && (
            <TweakRadio
              label={t('previewAs')}
              value={rolePreview}
              onChange={(v) => setRolePreview(v as 'actual' | 'as_purchaser')}
              options={[
                { value: 'actual', label: t('managerYou') },
                { value: 'as_purchaser', label: t('role_purchaser') },
              ]}
            />
          )}
        </div>
      )}
    </>
  );
}

function TweakRadio<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="tweak-section">
      <div className="tweak-label">{label}</div>
      <div className="seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            className={o.value === value ? 'active' : ''}
            onClick={() => onChange(o.value)}
            aria-pressed={o.value === value}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
