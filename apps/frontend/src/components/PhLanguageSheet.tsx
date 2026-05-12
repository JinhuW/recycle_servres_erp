import { useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import type { Lang } from '../lib/types';

type Props = { onClose: (picked: Lang | null) => void };

const LS_KEY = 'rs.langFollowSystem';

function systemLang(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const n = (navigator.language || 'en').toLowerCase();
  return n.startsWith('zh') ? 'zh' : 'en';
}

export function PhLanguageSheet({ onClose }: Props) {
  const { lang, setLang, t } = useT();
  const [draft, setDraft] = useState<Lang>(lang);
  const [followSystem, setFollowSystem] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_KEY) === '1'; } catch { return false; }
  });

  const apply = () => {
    try { localStorage.setItem(LS_KEY, followSystem ? '1' : '0'); } catch { /* ignore */ }
    const final: Lang = followSystem ? systemLang() : draft;
    setLang(final);
    onClose(final);
  };

  const options: { id: Lang; title: string; sub: string; flag: JSX.Element }[] = [
    {
      id: 'en', title: 'English', sub: 'United States',
      flag: (
        <svg viewBox="0 0 36 24" width="32" height="22" style={{ borderRadius: 4, display: 'block' }}>
          <rect width="36" height="24" fill="#B22234" />
          {[1,3,5,7,9,11].map(i => <rect key={i} y={i * (24/13)} width="36" height={24/13} fill="white" />)}
          <rect width="16" height={24/13 * 7} fill="#3C3B6E" />
        </svg>
      ),
    },
    {
      id: 'zh', title: '简体中文', sub: 'Chinese (Simplified) · 中国大陆',
      flag: (
        <svg viewBox="0 0 36 24" width="32" height="22" style={{ borderRadius: 4, display: 'block' }}>
          <rect width="36" height="24" fill="#DE2910" />
          <g fill="#FFDE00">
            <polygon points="7,4 8.2,7.2 11.6,7.2 8.9,9.3 9.9,12.5 7,10.5 4.1,12.5 5.1,9.3 2.4,7.2 5.8,7.2" />
            <polygon points="14,2.5 14.7,4 16.2,4 15,5 15.5,6.5 14,5.5 12.5,6.5 13,5 11.8,4 13.3,4" transform="scale(0.6) translate(9,1)" />
            <polygon points="14,2.5 14.7,4 16.2,4 15,5 15.5,6.5 14,5.5 12.5,6.5 13,5 11.8,4 13.3,4" transform="scale(0.6) translate(11,4)" />
            <polygon points="14,2.5 14.7,4 16.2,4 15,5 15.5,6.5 14,5.5 12.5,6.5 13,5 11.8,4 13.3,4" transform="scale(0.6) translate(11,7.5)" />
            <polygon points="14,2.5 14.7,4 16.2,4 15,5 15.5,6.5 14,5.5 12.5,6.5 13,5 11.8,4 13.3,4" transform="scale(0.6) translate(9,11)" />
          </g>
        </svg>
      ),
    },
  ];

  return (
    <>
      <div className="ph-sheet-backdrop" onClick={() => onClose(null)} />
      <div className="ph-sheet ph-lang-sheet">
        <div className="ph-sheet-grabber" />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 6px' }}>
          <button
            onClick={() => onClose(null)}
            style={{ background: 'transparent', border: 'none', color: 'var(--fg-muted)', fontSize: 14, fontFamily: 'inherit', padding: 4, cursor: 'pointer' }}
          >
            {t('cancel')}
          </button>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('langTitle')}</div>
          <button
            onClick={apply}
            disabled={!followSystem && draft === lang}
            style={{
              background: 'transparent', border: 'none',
              color: (!followSystem && draft === lang) ? 'var(--fg-subtle)' : 'var(--accent-strong)',
              fontSize: 14, fontWeight: 600, fontFamily: 'inherit', padding: 4,
              cursor: (!followSystem && draft === lang) ? 'default' : 'pointer',
            }}
          >
            {t('langDone')}
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', padding: '0 4px 14px', lineHeight: 1.5 }}>
          {t('langSubtitle')}
        </div>

        <div className="ph-lang-row" style={{ marginBottom: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--bg-soft)', display: 'grid', placeItems: 'center', color: 'var(--fg-muted)', flexShrink: 0 }}>
            <Icon name="settings" size={16} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{t('langSystem')}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{t('langSystemSub')}</div>
          </div>
          <button
            onClick={() => setFollowSystem(!followSystem)}
            className={'ph-switch ' + (followSystem ? 'on' : '')}
            aria-label="Follow system"
          >
            <span className="ph-switch-knob" />
          </button>
        </div>

        <div className={'ph-lang-list' + (followSystem ? ' disabled' : '')}>
          {options.map((o, i) => {
            const selected = draft === o.id;
            return (
              <button
                key={o.id}
                disabled={followSystem}
                onClick={() => setDraft(o.id)}
                className={'ph-lang-row option' + (selected ? ' selected' : '')}
                style={{ borderBottom: i < options.length - 1 ? '1px solid var(--border)' : 'none' }}
              >
                <div className="ph-lang-flag">{o.flag}</div>
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.005em' }}>{o.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{o.sub}</div>
                </div>
                <div className={'ph-lang-radio' + (selected ? ' on' : '')}>
                  {selected && <Icon name="check" size={13} />}
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, padding: '0 4px', fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.5 }}>
          <Icon name="info" size={13} style={{ marginTop: 2, flexShrink: 0, color: 'var(--fg-subtle)' }} />
          <span>{t('langApplyNote')}</span>
        </div>
      </div>
    </>
  );
}
