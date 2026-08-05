import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { itemTypes, addItemType, type ItemType } from '../lib/lookups';

/**
 * The type classifier for `Other` lines: pick a type, or create one and pick
 * it in the same gesture.
 *
 * Deliberately NOT the shared Combobox, whose contract is "the typed text is
 * the value verbatim, nothing is validated against the option list". That is
 * right for capacity and brand, and wrong here — free text is precisely what
 * this field exists to replace. What's typed is only a search until it's
 * either picked or created, so the vocabulary can't quietly re-fragment into
 * "CPU" / "cpu" / "Cpu".
 */
export function ItemTypePicker({
  value, onChange, disabled = false, invalid = false, onError,
}: {
  value: string | null | undefined;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  onError?: (msg: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const committed = (value ?? '').trim();
  // Closed, the field reads as the committed label; open, it's a search box.
  const shown = open ? query : committed;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  });

  const close = () => { setOpen(false); setQuery(''); setActive(-1); };

  const q = query.trim().toLowerCase();
  const filtered = q ? itemTypes.filter(l => l.name.toLowerCase().includes(q)) : itemTypes;
  const exact = itemTypes.some(l => l.name.toLowerCase() === q);
  const offerCreate = !!q && !exact;

  useEffect(() => { setActive(-1); }, [q, open]);

  const pick = (l: ItemType) => { onChange(l.name); close(); };

  const create = async () => {
    const name = query.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const label = await api.post<ItemType>('/api/item-types', { name });
      addItemType(label);
      onChange(label.name);
      close();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : t('itpCreateFailed'));
    } finally {
      setCreating(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { close(); return; }
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
    if (e.key === 'Enter') {
      // Always swallowed: an Enter that escaped this field would reach the
      // surrounding order form, which reads it as a submit.
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (active >= 0 && active < filtered.length) pick(filtered[active]);
      else if (offerCreate) void create();
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        className="input"
        value={shown}
        disabled={disabled}
        placeholder={t('itpPlaceholder')}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { if (!disabled) { setQuery(''); setOpen(true); } }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        style={{
          paddingRight: 30,
          borderColor: invalid ? 'var(--neg)' : undefined,
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={open ? t('itpClose') : t('itpOpen')}
        onMouseDown={e => {
          e.preventDefault();
          if (open) close();
          else { inputRef.current?.focus(); setQuery(''); setOpen(true); }
        }}
        style={{
          position: 'absolute', right: 4, top: 0, bottom: 0, width: 28,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', background: 'transparent',
          cursor: disabled ? 'default' : 'pointer', padding: 0,
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
          {/* Creating is a different act from picking — it adds a word to the
              vocabulary everyone will see — so the row is styled to read as an
              action, not as one more option in the list. */}
          {offerCreate && (
            <button
              type="button"
              disabled={creating}
              onMouseDown={e => { e.preventDefault(); void create(); }}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 12px',
                border: 'none', background: 'var(--bg-soft)',
                cursor: creating ? 'progress' : 'pointer',
                borderBottom: '1px solid var(--border)', fontFamily: 'inherit',
                color: 'var(--accent-strong)', display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12.5, fontWeight: 500,
              }}
            >
              <Icon name="plus" size={13} />
              {creating ? t('itpCreating') : t('itpCreate', { value: query.trim() })}
            </button>
          )}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map((l, i) => {
              const selected = l.name === committed;
              const highlit = i === active;
              return (
                <button
                  key={l.id}
                  type="button"
                  onMouseDown={e => { e.preventDefault(); pick(l); }}
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
                  <span>{l.name}</span>
                  {selected && <Icon name="check" size={13} style={{ color: 'var(--accent)' }} />}
                </button>
              );
            })}
            {filtered.length === 0 && !offerCreate && (
              <div style={{ padding: 16, fontSize: 12.5, color: 'var(--fg-subtle)', textAlign: 'center' }}>
                {t('itpEmpty')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
