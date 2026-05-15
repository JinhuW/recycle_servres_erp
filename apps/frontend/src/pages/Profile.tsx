import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { fmtUSD0 } from '../lib/format';
import { usePhScrolled } from '../lib/usePhScrolled';
import { Skeleton } from '../components/Skeleton';

type Stats = { count: number; profit: number; commission: number };

type Props = {
  onOpenLanguage: () => void;
  onOpenNotifications: () => void;
  onOpenAbout: () => void;
  onOpenSecurity: () => void;
};

export function Profile({ onOpenLanguage, onOpenNotifications, onOpenAbout, onOpenSecurity }: Props) {
  const { t, lang } = useT();
  const { user, logout } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);

  useEffect(() => {
    api.get<{ stats: Stats }>('/api/me').then(r => setStats(r.stats)).catch(console.error);
  }, []);

  if (!user) return null;

  type Item = { id: string; icon: IconName; label: string; sub: string; trailing?: JSX.Element; onClick?: () => void };
  const items: Item[] = [
    { id: 'notif', icon: 'bell', label: t('notifications'), sub: t('notificationsSub'), onClick: onOpenNotifications },
    { id: 'sec',   icon: 'lock', label: t('security'),      sub: t('securitySub'),      onClick: onOpenSecurity },
    {
      id: 'lang',  icon: 'globe', label: t('language'),     sub: lang === 'zh' ? '简体中文' : 'English',
      trailing: (
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--accent-strong)', fontWeight: 600 }}>{lang === 'zh' ? 'ZH' : 'EN'}</span>
        </span>
      ),
      onClick: onOpenLanguage,
    },
    { id: 'about', icon: 'info', label: t('about'),         sub: t('aboutSub'),         onClick: onOpenAbout },
  ];

  return (
    <>
      <PhHeader title={t('profile')} scrolled={scrolled} />
      <div className="ph-scroll" ref={scrollRef}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0 16px' }}>
          <div className="avatar xl">{user.initials}</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 12 }}>{user.name}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{user.email}</div>
        </div>

        <div className="ph-section-h"><span>{t('lifetimeStats')}</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {!stats ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="ph-kpi" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Skeleton width={60} height={10} />
                <Skeleton width={70} height={18} radius={5} />
              </div>
            ))
          ) : (
            <>
              <div className="ph-kpi"><div className="ph-kpi-label">{t('orders')}</div><div className="ph-kpi-value" style={{ fontSize: 18 }}>{stats.count}</div></div>
              <div className="ph-kpi"><div className="ph-kpi-label">{t('profit')}</div><div className="ph-kpi-value" style={{ fontSize: 18, color: 'var(--pos)' }}>{fmtUSD0(stats.profit)}</div></div>
              <div className="ph-kpi"><div className="ph-kpi-label">{t('earned')}</div><div className="ph-kpi-value" style={{ fontSize: 18 }}>{fmtUSD0(stats.commission)}</div></div>
            </>
          )}
        </div>

        <div className="ph-section-h"><span>{t('settings')}</span></div>
        <div className="ph-card" style={{ padding: '4px 0' }}>
          {items.map((it, i, arr) => (
            <div
              key={it.id}
              onClick={it.onClick}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px',
                borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
                cursor: it.onClick ? 'pointer' : 'default',
              }}
            >
              <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--bg-soft)', display: 'grid', placeItems: 'center', color: 'var(--fg-muted)' }}>
                <Icon name={it.icon} size={15} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{it.label}</div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{it.sub}</div>
              </div>
              {it.trailing}
              <Icon name="chevronRight" size={14} style={{ color: 'var(--fg-subtle)' }} />
            </div>
          ))}
        </div>

        <button onClick={logout} style={{ width: '100%', marginTop: 16, padding: 14, background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 12, color: 'var(--neg)', fontWeight: 500, fontFamily: 'inherit', fontSize: 14 }}>
          {t('signOut')}
        </button>
      </div>
    </>
  );
}
