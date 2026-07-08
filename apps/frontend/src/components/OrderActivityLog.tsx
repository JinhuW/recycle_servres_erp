import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { api } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { fmtDate, relTime, fmtUSD } from '../lib/format';
import { useT } from '../lib/i18n';
import type { OrderEvent, OrderEventChange } from '../lib/types';

type Props = {
  orderId: string;
  // Bump this to force a refresh after a save commits new events.
  refreshKey?: number;
};

const KIND_ICON: Record<OrderEvent['kind'], IconName> = {
  submitted:    'inventory',
  advanced:     'flag',
  line_added:   'plus',
  line_removed: 'trash',
  line_edited:  'edit',
  meta_changed: 'settings',
  status_meta_changed: 'paperclip',
  archived:     'box',
  unarchived:   'rotate',
};

type Tone = 'pos' | 'info' | 'warn' | 'muted';
const KIND_TONE: Record<OrderEvent['kind'], Tone> = {
  submitted:    'pos',
  advanced:     'info',
  line_added:   'pos',
  line_removed: 'warn',
  line_edited:  'info',
  meta_changed: 'muted',
  status_meta_changed: 'muted',
  archived:     'muted',
  unarchived:   'info',
};

// Tone palette mirrors the .chip rules in tokens.css so the bubbles read as
// part of the existing visual language. Background is the "soft" wash, the
// icon takes the "strong" hue for contrast.
const TONE_BG: Record<Tone, string> = {
  pos:   'var(--pos-soft)',
  info:  'var(--info-soft)',
  warn:  'var(--warn-soft)',
  muted: 'var(--bg-soft)',
};
const TONE_FG: Record<Tone, string> = {
  pos:   'var(--accent-strong)',
  info:  'oklch(0.45 0.13 250)',
  warn:  'oklch(0.45 0.13 75)',
  muted: 'var(--fg-subtle)',
};

const LIFECYCLE_LABEL: Record<string, string> = {
  draft:      'Draft',
  in_transit: 'In Transit',
  reviewing:  'Reviewing',
  done:       'Done',
};

// Friendly labels for the fields we surface on line_edited / meta_changed
// events. Anything not listed falls back to the raw db column name.
const FIELD_LABEL: Record<string, string> = {
  sell_price:      'Sell price',
  qty:             'Qty',
  unit_cost:       'Unit cost',
  brand:           'Brand',
  capacity:        'Capacity',
  type:            'Type',
  generation:      'Generation',
  classification:  'Classification',
  rank:            'Rank',
  speed:           'Speed',
  interface:       'Interface',
  form_factor:     'Form factor',
  description:     'Description',
  part_number:     'Part number',
  chip_number:     'Chip number',
  condition:       'Condition',
  health:          'Health',
  rpm:             'RPM',
  notes:           'Notes',
  warehouse_id:    'Warehouse',
  payment:         'Payment',
  total_cost:      'Total cost',
  commission_rate: 'Commission rate',
};

const MONEY_FIELDS = new Set(['sell_price', 'unit_cost', 'total_cost']);

function renderValue(field: string, v: unknown, locale: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'commission_rate' && typeof v === 'number') return (v * 100).toFixed(2) + '%';
  if (MONEY_FIELDS.has(field) && typeof v === 'number') return fmtUSD(v, locale);
  return String(v);
}

function changeLine(c: OrderEventChange, locale: string): string {
  const label = FIELD_LABEL[c.field] ?? c.field;
  return `${label}: ${renderValue(c.field, c.from, locale)} → ${renderValue(c.field, c.to, locale)}`;
}

function summary(ev: OrderEvent, locale: string): { title: string; lines: string[] } {
  const d = ev.detail as Record<string, unknown>;
  switch (ev.kind) {
    case 'submitted': {
      const lineCount = (d.lineCount as number) ?? 0;
      const qty = (d.qty as number) ?? 0;
      const total = (d.totalCost as number) ?? 0;
      return {
        title: 'Submitted for review',
        lines: [`${lineCount} line${lineCount === 1 ? '' : 's'} · ${qty} units · ${fmtUSD(total, locale)}`],
      };
    }
    case 'advanced': {
      const from = LIFECYCLE_LABEL[(d.from as string) ?? ''] ?? (d.from as string);
      const to = LIFECYCLE_LABEL[(d.to as string) ?? ''] ?? (d.to as string);
      return { title: `Advanced ${from} → ${to}`, lines: [] };
    }
    case 'line_added': {
      const pn = (d.partNumber as string) ?? '(no part number)';
      const qty = (d.qty as number) ?? 0;
      const unitCost = (d.unitCost as number) ?? 0;
      return { title: `Added line ${pn}`, lines: [`Qty ${qty} @ ${fmtUSD(unitCost, locale)}`] };
    }
    case 'line_removed': {
      const pn = (d.partNumber as string) ?? '(no part number)';
      const qty = (d.qty as number) ?? 0;
      const unitCost = (d.unitCost as number) ?? 0;
      return { title: `Removed line ${pn}`, lines: [`Was qty ${qty} @ ${fmtUSD(unitCost, locale)}`] };
    }
    case 'line_edited': {
      const pn = (d.partNumber as string) ?? '(no part number)';
      const changes = (d.changes as OrderEventChange[]) ?? [];
      return { title: `Edited line ${pn}`, lines: changes.map(c => changeLine(c, locale)) };
    }
    case 'meta_changed': {
      const changes = (d.changes as OrderEventChange[]) ?? [];
      return { title: 'Updated order details', lines: changes.map(c => changeLine(c, locale)) };
    }
    case 'status_meta_changed': {
      const status = String(d.status ?? '');
      const field = String(d.field);
      if (field === 'note') {
        return { title: `Note on ${status}`, lines: [renderValue('note', d.to, locale)] };
      }
      const verb = field === 'attachment_removed' ? 'removed' : 'added';
      return { title: `Attachment ${verb} on ${status}`, lines: [String(d.filename ?? '')] };
    }
    case 'archived': {
      return { title: 'Archived', lines: ['Hidden from the default order list'] };
    }
    case 'unarchived': {
      return { title: 'Unarchived', lines: ['Restored to the active list'] };
    }
  }
}

export function OrderActivityLog({ orderId, refreshKey = 0 }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    api.get<{ events: OrderEvent[] }>(`/api/orders/${orderId}/events`)
      .then(r => { if (alive) setEvents(r.events); })
      .catch(handleFetchError)
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [orderId, refreshKey]);

  // Newest first feels right for a long-lived order; show in reverse-chrono
  // without mutating the server's natural ASC order.
  const ordered = useMemo(() => [...events].reverse(), [events]);

  // Hide the section entirely until we've heard back. After that, render even
  // when empty so the user knows the panel exists (drafts will show empty).
  if (!loaded) return null;

  return (
    <div className="card" style={{ padding: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '14px 16px', background: 'none', border: 'none',
          fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
          borderBottom: open ? '1px solid var(--border)' : 'none',
        }}
      >
        <Icon name="clock" size={13} style={{ color: 'var(--fg-subtle)' }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{t('activity')}</span>
        <span className="mono" style={{
          fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
          background: 'var(--bg-soft)', color: 'var(--fg-subtle)',
          border: '1px solid var(--border)',
        }}>{events.length}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--fg-subtle)' }}>
          <Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} />
        </span>
      </button>

      {open && (
        <div style={{ position: 'relative', padding: '6px 0' }}>
          {/* Timeline rail — a hairline running through the column of bubbles.
              Bubbles render with a 2px solid card-bg border so they "punch
              through" the rail and read as discrete waypoints. */}
          {ordered.length > 1 && (
            <div aria-hidden style={{
              position: 'absolute',
              left: 28, // 16 (row pad) + 12 (half of 24 bubble) = 28
              top: 28, bottom: 28,
              width: 1, background: 'var(--border)',
              pointerEvents: 'none',
            }} />
          )}

          {ordered.length === 0 && (
            <div style={{ padding: '16px', fontSize: 12.5, color: 'var(--fg-subtle)' }}>
              {t('activityEmpty')}
            </div>
          )}

          {ordered.map(ev => {
            const s = summary(ev, locale);
            const tone = KIND_TONE[ev.kind];
            return (
              <div key={ev.id} style={{
                display: 'grid', gridTemplateColumns: '24px 1fr auto',
                gap: 14, padding: '10px 16px',
                alignItems: 'flex-start',
                position: 'relative',
              }}>
                <span
                  title={ev.kind}
                  style={{
                    width: 24, height: 24, borderRadius: '50%',
                    background: TONE_BG[tone],
                    border: '2px solid var(--bg-elev)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                    color: TONE_FG[tone],
                  }}
                >
                  <Icon name={KIND_ICON[ev.kind]} size={11} />
                </span>
                <div style={{ minWidth: 0, paddingTop: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg)', lineHeight: 1.35 }}>
                    {s.title}
                  </div>
                  {s.lines.length > 0 && (
                    <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none' }}>
                      {s.lines.map((ln, i) => (
                        <li key={i} className="mono" style={{
                          fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.5,
                        }}>{ln}</li>
                      ))}
                    </ul>
                  )}
                  {ev.actor && (
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>
                      {ev.actor.name}
                    </div>
                  )}
                </div>
                <div title={fmtDate(ev.createdAt, locale)} style={{
                  fontSize: 11, color: 'var(--fg-subtle)', whiteSpace: 'nowrap',
                  paddingTop: 4,
                }}>
                  {relTime(ev.createdAt, locale)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
