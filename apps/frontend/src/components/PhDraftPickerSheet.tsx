import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { fmtUSD0, relTime } from '../lib/format';
import type { Category, OrderSummary } from '../lib/types';

type Props = {
  category: Category;
  drafts: OrderSummary[];
  onResume: (draft: OrderSummary) => void;
  onStartNew: () => void;
  onClose: () => void;
};

// Surfaces in-progress draft POs in the picked category so the next scan can
// merge into one of them instead of silently spawning a fresh draft. The
// "Start a new order" affordance preserves the old behavior when the user
// really does want a clean slate.
export function PhDraftPickerSheet({ category, drafts, onResume, onStartNew, onClose }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onClose} />
      <div className="ph-sheet">
        <div className="ph-sheet-grabber" />
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, padding: '0 4px 4px' }}>
          {t('resumeDraftTitle')}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', padding: '0 4px 12px' }}>
          {t('resumeDraftSub', { category })}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {drafts.map(d => {
            const itemsLabel = `${d.lineCount} ${d.lineCount === 1 ? t('item') : t('items')}`;
            const totalLabel = d.totalCost != null && d.totalCost > 0 ? fmtUSD0(d.totalCost, locale) : null;
            return (
              <button
                key={d.id}
                className="ph-cat-card"
                onClick={() => onResume(d)}
                style={{ textAlign: 'left' }}
              >
                <div className="ph-cat-icon" style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}>
                  <Icon name="file" size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{d.id}</span>
                    <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>· {itemsLabel}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {relTime(d.createdAt, locale)}
                    {totalLabel && ` · ${totalLabel}`}
                  </div>
                </div>
                <Icon name="chevronRight" size={14} style={{ color: 'var(--fg-subtle)' }} />
              </button>
            );
          })}
        </div>

        <button
          onClick={onStartNew}
          style={{
            marginTop: 14,
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '12px 14px',
            border: '1px dashed var(--border)',
            borderRadius: 12,
            background: 'transparent',
            color: 'var(--accent-strong)',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Icon name="plus" size={14} /> {t('startNewOrder')}
        </button>
      </div>
    </>
  );
}
