import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';

// A collapsible panel of facet chips, each with the rows it would show:
// inventory's per-category spec filters and the WeChat price board's.

export type RefineRow = {
  key: string;
  label: string;
  // In display order.
  values: string[];
  counts: Record<string, number>;
  format?: (v: string) => string;
};

export function RefinePanel({ id, title, open, onOpen, rows, selected, onToggle, onClear }: {
  id: string;
  title: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  rows: RefineRow[];
  selected: Record<string, string[] | undefined>;
  onToggle: (key: string, value: string) => void;
  onClear: () => void;
}) {
  const { t } = useT();
  const active = rows.reduce((n, r) => n + (selected[r.key]?.length ?? 0), 0);

  // Collapse on a click anywhere outside, so the panel doesn't linger over
  // the table once the chips are dialed in. On click, not mousedown: the
  // collapse moves what's below it, and a mousedown collapse would shift the
  // row being clicked out from under the mouseup. The path, not the target:
  // unpicking a chip nothing matches removes it before this runs.
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !e.composedPath().includes(ref.current)) onOpen(false);
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open, onOpen]);

  return (
    <div ref={ref} className="inv-subfilter" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="inv-subfilter__head"
        onClick={() => onOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
      >
        <span className="inv-subfilter__chevron">
          <Icon name="chevronDown" size={13} />
        </span>
        <span className="inv-subfilter__title">{title}</span>
        {active > 0 && (
          <span className="inv-subfilter__badge">
            {t('invFiltersActive', { n: active })}
          </span>
        )}
        <span className="inv-subfilter__spacer" />
        {active > 0 && (
          <span
            className="inv-subfilter__clear"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onClear();
              }
            }}
          >
            {t('invClearAll')}
          </span>
        )}
        <span className="inv-subfilter__hint">
          {open ? t('memSecHide') : t('memSecShow')}
        </span>
      </button>
      <div id={id} className="inv-subfilter__body">
        {rows.map((row) => {
          const picked = selected[row.key] ?? [];
          // A picked value nothing matches any more stays, so it can be unpicked.
          const values = [...row.values, ...picked.filter(v => !row.values.includes(v))];
          if (values.length === 0) return null;
          return (
            <div className="inv-subfilter__row" key={row.key}>
              <div className="inv-subfilter__label">{row.label}</div>
              <div className="inv-subfilter__chips">
                {values.map((v) => {
                  const isOn = picked.includes(v);
                  const count = row.counts[v] ?? 0;
                  return (
                    <button
                      key={v}
                      type="button"
                      className={'inv-chip' + (isOn ? ' on' : '') + (count === 0 && !isOn ? ' empty' : '')}
                      onClick={() => onToggle(row.key, v)}
                      disabled={count === 0 && !isOn}
                    >
                      <span className="inv-chip__label">
                        {row.format ? row.format(v) : v}
                      </span>
                      <span className="inv-chip__count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
