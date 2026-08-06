import { useT } from '../../../lib/i18n';
import { addableCategories } from '../../../lib/lookups';
import type { Category } from '../../../lib/types';

// Four equal buttons, one per category, always visible.
//
// Deliberately not a single primary labelled "Add RAM": a PO is no longer in a
// category mode, and a button that names one reads as though it were — which is
// exactly the confusion the old full-page category gate created. Equal weight
// keeps every category one click away and leaves the mixing visible at rest.
const SWATCH: Record<string, string> = {
  RAM: 'var(--info)',
  SSD: 'var(--pos)',
  HDD: 'var(--cool, oklch(0.58 0.13 305))',
  Other: 'var(--warn)',
};

export function AddLineMenu({
  onAdd,
  disabled,
}: {
  onAdd: (cat: Category) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="add-line-bar" role="group" aria-label={t('subAddLineGroup')}>
      <span className="add-line-label">{t('add')}</span>
      {addableCategories().map(cat => (
        <button
          key={cat}
          type="button"
          className="btn sm add-line-cat"
          disabled={disabled}
          title={t('subAddCatLine', { cat })}
          onClick={() => onAdd(cat as Category)}
        >
          <span className="add-line-swatch" style={{ background: SWATCH[cat] ?? 'var(--fg-subtle)' }} />
          {cat}
        </button>
      ))}
    </div>
  );
}
