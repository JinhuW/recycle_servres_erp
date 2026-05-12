import { Icon, type IconName } from './Icon';
import type { Notification } from '../lib/types';
import { useT } from '../lib/i18n';

type Props = {
  items: Notification[];
  onClose: () => void;
  onMarkAllRead: () => void;
};

const TONE_BG: Record<string, string> = {
  pos:    'var(--pos-soft)',
  info:   'var(--info-soft)',
  accent: 'var(--accent-soft)',
  warn:   'var(--warn-soft)',
  muted:  'var(--bg-soft)',
};
const TONE_FG: Record<string, string> = {
  pos:    'var(--pos)',
  info:   'oklch(0.45 0.13 250)',
  accent: 'var(--accent-strong)',
  warn:   'oklch(0.5 0.15 75)',
  muted:  'var(--fg-muted)',
};

function relTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  const days = Math.round(h / 24);
  if (days < 7) return days + 'd';
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

export function PhNotificationsSheet({ items, onClose, onMarkAllRead }: Props) {
  const { t } = useT();
  const unreadCount = items.filter(n => n.unread).length;
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onClose} />
      <div className="ph-sheet" style={{ maxHeight: '78%', display: 'flex', flexDirection: 'column', paddingBottom: 12 }}>
        <div className="ph-sheet-grabber" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 14px' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('notifTitle')}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {unreadCount > 0 ? t('notifNUnread', { n: unreadCount }) : t('notifAllCaught')}
            </div>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={onMarkAllRead}
              style={{
                background: 'transparent', border: 'none',
                color: 'var(--accent-strong)', fontSize: 12.5, fontWeight: 600,
                fontFamily: 'inherit', padding: 4, cursor: 'pointer',
              }}
            >
              {t('notifMarkAllRead')}
            </button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
          {items.map((n, i) => (
            <div
              key={n.id}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '12px 6px',
                borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none',
                position: 'relative',
              }}
            >
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: TONE_BG[n.tone] || TONE_BG.muted,
                color: TONE_FG[n.tone] || TONE_FG.muted,
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}>
                <Icon name={n.icon as IconName} size={16} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div style={{
                    fontSize: 13.5, fontWeight: n.unread ? 600 : 500,
                    letterSpacing: '-0.005em', flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {n.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {relTime(n.time)}
                  </div>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 3, lineHeight: 1.45 }}>
                  {n.body}
                </div>
              </div>
              {n.unread && (
                <span style={{
                  position: 'absolute', left: -2, top: 22,
                  width: 6, height: 6, borderRadius: 999,
                  background: 'var(--accent)',
                }} />
              )}
            </div>
          ))}
        </div>

        <div style={{
          textAlign: 'center', fontSize: 11.5, color: 'var(--fg-subtle)',
          padding: '12px 0 4px', borderTop: '1px solid var(--border)', marginTop: 4,
        }}>
          {t('notifManageHint')}
        </div>
      </div>
    </>
  );
}
