import { Icon } from './Icon';
import { useT } from '../lib/i18n';

type Props = {
  onClose: () => void;
};

const VERSION = '2026.4.2';
const BUILD = 'mobile.r1';
const SUPPORT_EMAIL = 'support@recycleservers.io';

export function PhAboutSheet({ onClose }: Props) {
  const { t } = useT();
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onClose} />
      <div className="ph-sheet" style={{ paddingBottom: 24 }}>
        <div className="ph-sheet-grabber" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 14px' }}>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('aboutSheetTitle')}</div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--accent-strong)', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', padding: 4, cursor: 'pointer' }}
          >
            {t('aboutClose')}
          </button>
        </div>

        <div className="ph-card" style={{ padding: '4px 0' }}>
          <Row label={t('aboutVersion')} value={VERSION} />
          <Row label={t('aboutBuild')} value={BUILD} divider={false} />
        </div>

        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            marginTop: 12, padding: '12px 14px',
            background: 'var(--bg-elev)', border: '1px solid var(--border)',
            borderRadius: 12, textDecoration: 'none', color: 'var(--fg)',
          }}
        >
          <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent-soft)', display: 'grid', placeItems: 'center', color: 'var(--accent-strong)' }}>
            <Icon name="mail" size={15} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t('aboutSupport')}</div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{SUPPORT_EMAIL}</div>
          </div>
          <Icon name="chevronRight" size={14} style={{ color: 'var(--fg-subtle)' }} />
        </a>
      </div>
    </>
  );
}

function Row({ label, value, divider = true }: { label: string; value: string; divider?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 14px',
      borderBottom: divider ? '1px solid var(--border)' : 'none',
    }}>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
