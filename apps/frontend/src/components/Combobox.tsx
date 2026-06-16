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
  // Keyboard-highlighted option; shared with hover so both drive one cursor.
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
  const offerCustom = !!q && !exact;

  // Keep the highlight in range as the filtered list shrinks/grows.
  useEffect(() => { setActive(-1); }, [q, open]);

  const choose = (v: string) => { onChange(v); setOpen(false); setActive(-1); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { setOpen(true); return; }
      if (!filtered.length) return;
      e.preventDefault();
      setActive(i => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return (next + filtered.length) % filtered.length;
      });
      return;
    }
    if (e.key === 'Enter' && open) {
      // Commit the highlighted preset; otherwise the typed value already is the
      // value, so just close. Either way, don't submit the surrounding form.
      e.preventDefault();
      if (active >= 0 && active < filtered.length) choose(filtered[active]);
      else setOpen(false);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        className={className}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        style={{ paddingRight: 30 }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? 'Close options' : 'Open options'}
        onMouseDown={e => {
          // Toggle without stealing focus from the input.
          e.preventDefault();
          if (open) setOpen(false);
          else { inputRef.current?.focus(); setOpen(true); }
        }}
        style={{
          position: 'absolute', right: 4, top: 0, bottom: 0, width: 28,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
          color: 'var(--fg-subtle)',
        }}
      >
        <Icon
          name="chevronDown"
          size={13}
          style={{ transition: 'transform 0.15s ease', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 12px 28px rgba(15,23,42,0.14)', zIndex: 50, overflow: 'hidden',
        }}>
          {/* Explicit affordance that a typed value the catalog doesn't carry
              is accepted as-is — mirrors the Customer picker's "Add new" row. */}
          {offerCustom && (
            <button
              type="button"
              onMouseDown={e => { e.preventDefault(); setOpen(false); }}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 12px',
                border: 'none', background: 'var(--bg-soft)', cursor: 'pointer',
                borderBottom: '1px solid var(--border)', fontFamily: 'inherit',
                color: 'var(--accent-strong)', display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12.5, fontWeight: 500,
              }}
            >
              <Icon name="plus" size={13} />
              {t('comboUseCustom', { value: (value ?? '').trim() })}
            </button>
          )}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map((o, i) => {
              const selected = o === value;
              const highlit = i === active;
              return (
                <button
                  key={o}
                  type="button"
                  // mousedown (not click) so the option registers before the
                  // input blurs and the menu unmounts.
                  onMouseDown={e => { e.preventDefault(); choose(o); }}
                  onMouseEnter={() => setActive(i)}
                  style={{
                    width: '100%', textAlign: 'left', padding: '9px 12px',
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    borderBottom: i === filtered.length - 1 ? 'none' : '1px solid var(--border)',
                    background: highlit ? 'var(--bg-soft)' : 'transparent',
                    color: selected ? 'var(--accent-strong)' : 'var(--fg)',
                    fontWeight: selected ? 500 : 400,
                  }}
                >
                  <span>{o}</span>
                  {selected && <Icon name="check" size={13} style={{ color: 'var(--accent)' }} />}
                </button>
              );
            })}
            {filtered.length === 0 && !offerCustom && (
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
