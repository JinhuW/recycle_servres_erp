import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import type { Category } from '../lib/types';

type Props = {
  onPick: (cat: Category) => void;
  onClose: () => void;
};

export function PhCategorySheet({ onPick, onClose }: Props) {
  const { t } = useT();
  const cats: { id: Category; label: string; icon: 'chip' | 'drive' | 'box'; sub: string; tag: string; cls: string }[] = [
    { id: 'RAM',   label: 'RAM',   icon: 'chip',  sub: t('catRamSub'),   tag: t('aiLabelCapture'), cls: '' },
    { id: 'SSD',   label: 'SSD',   icon: 'drive', sub: t('catSsdSub'),   tag: t('manualEntry'),    cls: 'ssd' },
    { id: 'Other', label: 'Other', icon: 'box',   sub: t('catOtherSub'), tag: t('manualEntry'),    cls: 'other' },
  ];
  return (
    <>
      <div className="ph-sheet-backdrop" onClick={onClose} />
      <div className="ph-sheet">
        <div className="ph-sheet-grabber" />
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, padding: '0 4px 10px' }}>
          {t('pickCategory')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cats.map(c => (
            <button key={c.id} className="ph-cat-card" onClick={() => onPick(c.id)}>
              <div className={'ph-cat-icon ' + c.cls}><Icon name={c.icon} size={22} /></div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{c.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{c.sub}</div>
              </div>
              <span className={'chip ' + (c.id === 'RAM' ? 'pos' : '')} style={{ fontSize: 10 }}>
                {c.id === 'RAM' && <Icon name="sparkles" size={9} />} {c.tag}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
