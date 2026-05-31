import type { Category } from '../lib/types';

// Minimal shape shared by OrderLine and DraftLine — only the spec fields the
// chips render, so both order-view and draft-edit screens can feed their rows
// straight in without a mapping step.
type SpecLine = {
  category: Category;
  classification?: string | null;
  rank?: string | null;
  speed?: string | null;
  formFactor?: string | null;
  interface?: string | null;
  health?: number | null;
  condition?: string | null;
};

type Chip = { label: string; key: string; accent?: boolean };

// `accent` chips carry the spec a buyer actually scans for at a glance — RAM
// rank + speed — so they get the colored pill; the rest stay quiet.
function chipsFor(l: SpecLine): Chip[] {
  if (l.category === 'RAM') {
    return [
      l.classification && { key: 'class', label: l.classification },
      l.rank && { key: 'rank', label: l.rank, accent: true },
      l.speed && { key: 'speed', label: l.speed + 'MHz', accent: true },
    ].filter(Boolean) as Chip[];
  }
  if (l.category === 'SSD') {
    return [
      l.formFactor && { key: 'ff', label: l.formFactor },
      l.health != null && { key: 'health', label: l.health + '%' },
      l.condition && { key: 'cond', label: l.condition },
    ].filter(Boolean) as Chip[];
  }
  if (l.category === 'HDD') {
    return [
      l.interface && { key: 'if', label: l.interface },
      l.formFactor && { key: 'ff', label: l.formFactor },
      l.health != null && { key: 'health', label: l.health + '%' },
      l.condition && { key: 'cond', label: l.condition },
    ].filter(Boolean) as Chip[];
  }
  return [];
}

export function lineHasSpecChips(line: SpecLine): boolean {
  return chipsFor(line).length > 0;
}

export function LineSpecChips({ line }: { line: SpecLine }) {
  const chips = chipsFor(line);
  if (chips.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
      {chips.map(c => (
        <span
          key={c.key}
          style={{
            fontSize: 10.5,
            lineHeight: 1.5,
            padding: '0 7px',
            borderRadius: 999,
            fontWeight: c.accent ? 600 : 500,
            fontVariantNumeric: 'tabular-nums',
            color: c.accent ? 'var(--accent-strong)' : 'var(--fg-subtle)',
            background: c.accent ? 'var(--accent-soft)' : 'var(--bg-soft)',
            border: '1px solid ' + (c.accent
              ? 'color-mix(in oklch, var(--accent) 28%, transparent)'
              : 'var(--border)'),
          }}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
