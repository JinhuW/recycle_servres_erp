import type { ReactNode } from 'react';

export type SortDir = 'asc' | 'desc' | null;
export type SortState = { col: string; dir: SortDir };

function SortCaret({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <svg
      width="9" height="11" viewBox="0 0 9 11"
      style={{ flexShrink: 0, opacity: active ? 1 : 0.32 }}
      aria-hidden="true"
    >
      <path d="M4.5 1.5 L1.5 4.5 H7.5 Z" fill={active && dir === 'asc'  ? 'var(--accent-strong)' : 'currentColor'} />
      <path d="M4.5 9.5 L7.5 6.5 H1.5 Z" fill={active && dir === 'desc' ? 'var(--accent-strong)' : 'currentColor'} />
    </svg>
  );
}

export function SortTh({ col, sort, onSort, align, className, title, children }: {
  col: string;
  sort: SortState;
  onSort: (col: string) => void;
  align?: 'right';
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const active = sort.col === col && sort.dir !== null;
  const cls = [align === 'right' ? 'num' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <th
      onClick={() => onSort(col)}
      className={cls || undefined}
      title={title}
      aria-sort={!active ? undefined : sort.dir === 'asc' ? 'ascending' : 'descending'}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: active ? 'var(--fg)' : undefined }}>
        {children}
        <SortCaret active={active} dir={sort.dir} />
      </span>
    </th>
  );
}
