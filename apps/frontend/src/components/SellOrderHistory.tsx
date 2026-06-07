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

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// Translate backend lifecycle enum values to user-facing labels. Unknown
// values fall through to the raw string so a new backend state still renders.
const LIFECYCLE_KEY: Record<string, string> = {
  Draft:              'lifecycleDraft',
  Shipped:            'lifecycleShipped',
  'Awaiting payment': 'lifecycleAwaiting',
  Done:               'lifecycleDone',
  Closed:             'lifecycleClosed',
};
function lifecycleLabel(t: TFn, raw: string): string {
  const k = LIFECYCLE_KEY[raw];
  return k ? t(k) : raw;
}

const FIELD_KEY: Record<string, string> = {
  notes:              'fieldNotes',
  customer_id:        'fieldCustomer',
  qty:                'fieldQty',
  unit_price:         'fieldUnitPrice',
  condition:          'fieldCondition',
  category:           'fieldCategory',
  label:              'fieldLabel',
  sub_label:          'fieldSubLabel',
  part_number:        'fieldPartNumber',
  warehouse_id:       'fieldWarehouse',
  inventory_id:       'fieldInventoryLine',
  note:               'fieldStatusNote',
  attachment_added:   'fieldAttachmentAdded',
  attachment_removed: 'fieldAttachmentRemoved',
};
function fieldLabel(t: TFn, raw: string): string {
  const k = FIELD_KEY[raw];
  return k ? t(k) : raw;
}

const MONEY_FIELDS = new Set(['unit_price']);

function renderValue(field: string, v: unknown, locale: string): string {
  if (v == null || v === '') return '—';
  if (MONEY_FIELDS.has(field) && typeof v === 'number') return fmtUSD(v, locale);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function summarize(event: SellOrderEvent, locale: string, t: TFn): React.ReactNode {
  const d = event.detail as Record<string, unknown>;
  switch (event.kind) {
    case 'created':
      return (
        <>
          {t('historyCreatedPrefix')} (
          {(d.source === 'vendor_bid')
            ? <>
                {t('historyFromVendorBid', { id: String(d.vendorBidId ?? '') })}
                {typeof d.currency === 'string' && d.currency !== 'USD' && typeof d.fxRateToUsd === 'number'
                  ? <> — {d.currency} at fx {(1 / d.fxRateToUsd).toFixed(4)}{typeof d.fxSource === 'string' ? <> ({d.fxSource})</> : null}</>
                  : null}
              </>
            : <>{t('historyByActor', { name: event.actor?.name ?? t('historyDefaultManager') })}</>}
          ){typeof d.lineCount === 'number'
              ? <> · {d.lineCount === 1
                  ? t('historyLineCountOne', { n: d.lineCount })
                  : t('historyLineCountMany', { n: d.lineCount })}</>
              : null}
        </>
      );
    case 'status_changed': {
      const from = lifecycleLabel(t, String(d.from));
      const to   = lifecycleLabel(t, String(d.to));
      return <>{t('historyStatusLabel')}: <b>{from}</b> → <b>{to}</b></>;
    }
    case 'meta_changed': {
      const changes = (d.changes as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
      return (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {changes.map((c, i) => (
            <li key={i}>
              <b>{fieldLabel(t, c.field)}</b>: {renderValue(c.field, c.from, locale)} → {renderValue(c.field, c.to, locale)}
            </li>
          ))}
        </ul>
      );
    }
    case 'line_added':
    case 'line_removed': {
      const snap = (d.snapshot as Record<string, unknown>) ?? {};
      const verb = event.kind === 'line_added' ? t('historyAddedLine') : t('historyRemovedLine');
      return (
        <>
          {verb}: <b>{String(snap.label ?? '—')}</b>
          {snap.qty != null ? <> · {t('qtyShort', { n: String(snap.qty) })}</> : null}
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
          <div>{t('historyEditedLine')} {invId ? <code>{invId}</code> : null}</div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {changes.map((c, i) => (
              <li key={i}>
                <b>{fieldLabel(t, c.field)}</b>: {renderValue(c.field, c.from, locale)} → {renderValue(c.field, c.to, locale)}
              </li>
            ))}
          </ul>
        </>
      );
    }
    case 'status_meta_changed': {
      const status = lifecycleLabel(t, String(d.status));
      const field  = String(d.field);
      const label  = fieldLabel(t, field);
      if (field === 'note') {
        return <>{label} {t('historyStatusMetaOn')} <b>{status}</b>: {renderValue('note', d.to, locale)}</>;
      }
      return <>{label} {t('historyStatusMetaOn')} <b>{status}</b>: {String(d.filename ?? '')}</>;
    }
    case 'archived':   return <>{t('historyArchived')}</>;
    case 'unarchived': return <>{t('historyUnarchived')}</>;
    case 'closed': {
      const note = d.note ? <> · "{String(d.note)}"</> : null;
      return <>{t('historyClosedReason', { id: String(d.reasonId ?? '') })}{note}</>;
    }
    case 'reopened': {
      const note = d.note ? <> · "{String(d.note)}"</> : null;
      return <>{t('historyReopened')}{note}</>;
    }
  }
}

export function SellOrderHistory({ sellOrderId, refreshKey }: Props) {
  const { lang, t } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [events, setEvents] = useState<SellOrderEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ events: SellOrderEvent[] }>(`/api/sell-orders/${sellOrderId}/events`)
      .then(r => { if (!cancelled) setEvents(r.events); })
      .catch(e => handleFetchError(e));
    return () => { cancelled = true; };
  }, [sellOrderId, refreshKey]);

  if (events === null) return <div style={{ color: 'var(--fg-subtle)' }}>{t('historyLoading')}</div>;
  if (events.length === 0) return <div style={{ color: 'var(--fg-subtle)' }}>{t('historyEmpty')}</div>;

  // The API returns events oldest-first (chronological); show the timeline
  // newest-first so the latest activity for the order sits at the top.
  const ordered = [...events].reverse();

  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
      {ordered.map(e => {
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
              <div>{summarize(e, locale, t)}</div>
              {e.actor ? (
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                  {t('historyByActorLine', { name: e.actor.name })}
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
