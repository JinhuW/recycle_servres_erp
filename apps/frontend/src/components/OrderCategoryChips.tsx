import { categoryTone } from '../lib/lookups';
import type { Category } from '../lib/types';

// One chip per category an order holds. A PO may mix them, so the row is driven
// by `order.categories` rather than the derived `order.category` scalar — that
// scalar reads 'Mixed', which tells you there is more than one but not which.

type Props = {
  categories: readonly Category[];
  /** Chips to render before collapsing the rest into a +N. */
  max?: number;
  /** Shown when the order has no lines yet. */
  emptyLabel?: string;
  style?: React.CSSProperties;
};

export function OrderCategoryChips({ categories, max = 2, emptyLabel = '—', style }: Props) {
  if (categories.length === 0) {
    return <span className="muted" style={{ fontSize: 12, ...style }}>{emptyLabel}</span>;
  }
  const shown = categories.slice(0, max);
  const rest = categories.length - shown.length;
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...style }}
      title={categories.join(' · ')}
    >
      {shown.map(c => (
        <span key={c} className={'chip ' + categoryTone(c).chip} style={{ minWidth: 42, justifyContent: 'center' }}>
          {c}
        </span>
      ))}
      {rest > 0 && <span className="chip">+{rest}</span>}
    </span>
  );
}
