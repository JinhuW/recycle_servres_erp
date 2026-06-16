import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';

/**
 * A single field that is both a dropdown and a free-text input: type any value,
 * or pick a preset from the menu. Styled to match the sell-order Customer
 * picker. Used for catalog fields whose real-world set outruns the catalog
 * (drive capacity / brand) — purchasers must be able to enter a value the
 * preset list doesn't carry. The typed/picked text is the value verbatim;
 * nothing is validated against the option list.
 */
export function Combobox({
  value, options, onChange, placeholder, className = 'input',
}: {
  value: string | null | undefined;
  options: readonly string[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close when focus/click leaves the widget.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Filter the menu by what's typed; an exact match (just picked) shows the
  // full list again so presets stay reachable.
  const q = (value ?? '').trim().toLowerCase();
  const exact = options.some(o => o.toLowerCase() === q);
  const filtered = q && !exact ? options.filter(o => o.toLowerCase().includes(q)) : options;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        className={className}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        style={{ paddingRight: 30 }}
      />
      <Icon
        name="chevronDown"
        size={13}
        style={{
          position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--fg-subtle)', pointerEvents: 'none',
        }}
      />
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 12px 28px rgba(15,23,42,0.14)', zIndex: 50, overflow: 'hidden',
        }}>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map(o => (
              <button
                key={o}
                type="button"
                // mousedown (not click) so the option registers before the
                // input blurs and the menu unmounts.
                onMouseDown={e => { e.preventDefault(); onChange(o); setOpen(false); }}
                style={{
                  width: '100%', textAlign: 'left', padding: '9px 12px',
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13, display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between', borderBottom: '1px solid var(--border)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-soft)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span>{o}</span>
                {o === value && <Icon name="check" size={13} style={{ color: 'var(--accent)' }} />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: 16, fontSize: 12.5, color: 'var(--fg-subtle)', textAlign: 'center' }}>
                {t('sodNoMatches')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
