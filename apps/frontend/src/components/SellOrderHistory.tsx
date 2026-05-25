import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { api } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { fmtDate, relTime, fmtUSD } from '../lib/format';
import { useT } from '../lib/i18n';
import type { SellOrderEvent } from '../lib/types';

type Props = {
  sellOrderId: string;
  // Bump this to force a refresh after a save commits new events.
  refreshKey?: number;
};

const KIND_ICON: Record<SellOrderEvent['kind'], IconName> = {
  created:             'plus',
  status_changed:      'flag',
  line_added:          'plus',
  line_removed:        'trash',
  line_edited:         'edit',
  meta_changed:        'settings',
  status_meta_changed: 'paperclip',
  archived:            'box',
  unarchived:          'rotate',
  closed:              'x',
  reopened:            'rotate',
};

type Tone = 'pos' | 'info' | 'warn' | 'muted';
const KIND_TONE: Record<SellOrderEvent['kind'], Tone> = {
  created:             'pos',
  status_changed:      'info',
  line_added:          'pos',
  line_removed:        'warn',
  line_edited:         'info',
  meta_changed:        'muted',
  status_meta_changed: 'muted',
  archived:            'muted',
  unarchived:          'info',
  closed:              'warn',
  reopened:            'info',
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
  Draft:               'Draft',
  Shipped:             'Shipped',
  'Awaiting payment':  'Awaiting payment',
  Done:                'Done',
  Closed:              'Closed',
};

// Friendly labels for the fields we surface on line_edited / meta_changed /
// status_meta_changed events. Anything not listed falls back to the raw key.
const FIELD_LABEL: Record<string, string> = {
  notes:              'Notes',
  customer_id:        'Customer',
  qty:                'Qty',
  unit_price:         'Unit price',
  condition:          'Condition',
  category:           'Category',
  label:              'Label',
  sub_label:          'Sub-label',
  part_number:        'Part number',
  warehouse_id:       'Warehouse',
  inventory_id:       'Inventory line',
  note:               'Status note',
  attachment_added:   'Attachment added',
  attachment_removed: 'Attachment removed',
};

const MONEY_FIELDS = new Set(['unit_price']);

function renderValue(field: string, v: unknown, locale: string): string {
  if (v == null || v === '') return '—';
  if (MONEY_FIELDS.has(field) && typeof v === 'number') return fmtUSD(v, locale);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function summarize(event: SellOrderEvent, locale: string): React.ReactNode {
  const d = event.detail as Record<string, unknown>;
  switch (event.kind) {
    case 'created':
      return (
        <>
          Created (
          {(d.source === 'vendor_bid')
            ? <>from vendor bid <b>{String(d.vendorBidId ?? '')}</b></>
            : <>by {event.actor?.name ?? 'manager'}</>}
          ){typeof d.lineCount === 'number' ? <> · {d.lineCount} line{d.lineCount === 1 ? '' : 's'}</> : null}
        </>
      );
    case 'status_changed': {
      const from = LIFECYCLE_LABEL[String(d.from)] ?? String(d.from);
      const to   = LIFECYCLE_LABEL[String(d.to)]   ?? String(d.to);
      return <>Status: <b>{from}</b> → <b>{to}</b></>;
    }
    case 'meta_changed': {
      const changes = (d.changes as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
      return (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {changes.map((c, i) => (
            <li key={i}>
              <b>{FIELD_LABEL[c.field] ?? c.field}</b>: {renderValue(c.field, c.from, locale)} → {renderValue(c.field, c.to, locale)}
            </li>
          ))}
        </ul>
      );
    }
    case 'line_added':
    case 'line_removed': {
      const snap = (d.snapshot as Record<string, unknown>) ?? {};
      const verb = event.kind === 'line_added' ? 'Added line' : 'Removed line';
      return (
        <>
          {verb}: <b>{String(snap.label ?? '—')}</b>
          {snap.qty != null ? <> · qty {String(snap.qty)}</> : null}
          {snap.unit_price != null && typeof snap.unit_price === 'number'
            ? <> · {fmtUSD(snap.unit_price, locale)}</>
            : null}
        </>
      );
    }
    case 'line_edited': {
      const changes = (d.changes as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
      const invId = String(d.inventoryId ?? '');
      return (
        <>
          <div>Edited line {invId ? <code>{invId}</code> : null}</div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {changes.map((c, i) => (
              <li key={i}>
                <b>{FIELD_LABEL[c.field] ?? c.field}</b>: {renderValue(c.field, c.from, locale)} → {renderValue(c.field, c.to, locale)}
              </li>
            ))}
          </ul>
        </>
      );
    }
    case 'status_meta_changed': {
      const status = LIFECYCLE_LABEL[String(d.status)] ?? String(d.status);
      const field  = String(d.field);
      const label  = FIELD_LABEL[field] ?? field;
      if (field === 'note') {
        return <>{label} on <b>{status}</b>: {renderValue('note', d.to, locale)}</>;
      }
      return <>{label} on <b>{status}</b>: {String(d.filename ?? '')}</>;
    }
    case 'archived':   return <>Archived</>;
    case 'unarchived': return <>Unarchived</>;
    case 'closed': {
      const note = d.note ? <> · "{String(d.note)}"</> : null;
      return <>Closed (reason: <code>{String(d.reasonId ?? '')}</code>){note}</>;
    }
    case 'reopened': {
      const note = d.note ? <> · "{String(d.note)}"</> : null;
      return <>Reopened{note}</>;
    }
  }
}

export function SellOrderHistory({ sellOrderId, refreshKey }: Props) {
  const { lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [events, setEvents] = useState<SellOrderEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ events: SellOrderEvent[] }>(`/api/sell-orders/${sellOrderId}/events`)
      .then(r => { if (!cancelled) setEvents(r.events); })
      .catch(e => handleFetchError(e));
    return () => { cancelled = true; };
  }, [sellOrderId, refreshKey]);

  if (events === null) return <div style={{ color: 'var(--fg-subtle)' }}>Loading…</div>;
  if (events.length === 0) return <div style={{ color: 'var(--fg-subtle)' }}>No activity yet.</div>;

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
      {events.map(e => {
        const tone = KIND_TONE[e.kind];
        return (
          <li key={e.id} style={{ display: 'grid', gridTemplateColumns: '32px 1fr auto', gap: 12, alignItems: 'start' }}>
            <span style={{
              width: 32, height: 32, borderRadius: '50%',
              background: TONE_BG[tone], color: TONE_FG[tone],
              display: 'grid', placeItems: 'center',
            }}>
              <Icon name={KIND_ICON[e.kind]} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div>{summarize(e, locale)}</div>
              {e.actor ? (
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                  by {e.actor.name}
                </div>
              ) : null}
            </div>
            <time title={fmtDate(e.createdAt, locale)} style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {relTime(e.createdAt, locale)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
