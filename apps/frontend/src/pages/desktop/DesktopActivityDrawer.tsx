import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { statusTone } from '../../lib/status';
import { ListSkeleton } from '../../components/Skeleton';

// Workspace-wide inventory activity log, shown as a right-side drawer.
// Ported from design/inventory.jsx#HistoryDrawer with the local SUBMISSIONS
// data swapped for an /api/inventory/events/all fetch. Read-only — the audit
// log is append-only on the backend.

type Event = {
  id: string;
  kind: 'created' | 'edited' | 'status' | 'priced' | string;
  detail: Record<string, unknown>;
  created_at: string;
  line_id: string;
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
  brand: string | null; capacity: string | null; type: string | null;
  interface: string | null; description: string | null;
  part_number: string | null;
  rpm?: number | null;
  actor_name: string | null;
  actor_initials: string | null;
};

type Filter = 'all' | 'created' | 'status' | 'edited' | 'priced' | 'transferred';

const ACTION_META: Record<string, { icon: IconName; label: string; dot: string }> = {
  created:     { icon: 'plus',  label: 'Created',     dot: 'var(--pos)' },
  status:      { icon: 'arrow', label: 'Status',      dot: 'var(--info)' },
  edited:      { icon: 'edit',  label: 'Edit',        dot: 'var(--warn)' },
  priced:      { icon: 'tag',   label: 'Priced',      dot: 'var(--accent)' },
  transferred: { icon: 'truck', label: 'Transferred', dot: 'var(--info)' },
};

export function DesktopActivityDrawer({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('kind', filter);
      if (search.trim()) params.set('q', search.trim());
      api.get<{ events: Event[] }>(`/api/inventory/events/all?${params}`)
        .then(r => setEvents(r.events))
        .catch(() => setEvents([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [filter, search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Quick counts per action for the filter pills.
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, created: 0, status: 0, edited: 0, priced: 0, transferred: 0 };
    (events ?? []).forEach(e => {
      c.all++;
      c[e.kind] = (c[e.kind] ?? 0) + 1;
    });
    return c;
  }, [events]);

  // Group by day for sticky day headers.
  const groups = useMemo(() => {
    const byDay = new Map<string, { date: Date; events: Event[] }>();
    (events ?? []).forEach(e => {
      const key = new Date(e.created_at).toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, { date: new Date(e.created_at), events: [] });
      byDay.get(key)!.events.push(e);
    });
    return [...byDay.values()];
  }, [events]);

  const itemLabel = (e: Event): string =>
      e.category === 'RAM' ? `${e.brand ?? ''} ${e.capacity ?? ''} ${e.type ?? ''}`.trim()
    : e.category === 'SSD' ? `${e.brand ?? ''} ${e.capacity ?? ''} ${e.interface ?? ''}`.trim()
    : e.category === 'HDD' ? `${e.brand ?? ''} ${e.capacity ?? ''} ${e.rpm ? e.rpm + 'rpm' : ''}`.trim()
    : (e.description ?? '—');

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      style={{ justifyItems: 'end', padding: 0 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(680px, 100vw)', height: '100vh',
          background: 'var(--bg-elev)', borderLeft: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
          boxShadow: '-24px 0 60px rgba(15,23,42,0.18)',
          animation: 'drawer-in 0.22s ease',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '18px 22px 14px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Icon name="history" size={16} style={{ color: 'var(--fg-subtle)' }} />
              <span style={{ fontSize: 15, fontWeight: 600 }}>Inventory activity log</span>
              <span className="chip info" style={{
                fontSize: 10.5,
                textTransform: 'uppercase', letterSpacing: '0.05em',
                fontWeight: 600,
              }}>
                <Icon name="lock" size={10} /> Immutable
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>
              Append-only record of every change made to inventory. Entries cannot be edited or deleted.
            </div>
          </div>
          <button className="btn icon" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* Filters */}
        <div style={{
          padding: '12px 22px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <div className="seg" style={{ flexShrink: 0 }}>
            {(['all', 'created', 'status', 'edited', 'priced', 'transferred'] as Filter[]).map(f => (
              <button
                key={f}
                className={filter === f ? 'active' : ''}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : ACTION_META[f]?.label ?? f}
                <span style={{
                  marginLeft: 6, fontSize: 10.5, padding: '1px 6px',
                  borderRadius: 999, background: 'var(--bg-soft)',
                  color: 'var(--fg-subtle)', fontWeight: 600,
                }}>{counts[f] ?? 0}</span>
              </button>
            ))}
          </div>
          <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
            <Icon name="search" size={13} style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--fg-subtle)',
            }} />
            <input
              className="input"
              placeholder="Search by item, user, part #…"
              style={{ paddingLeft: 30, height: 32, fontSize: 12.5, width: '100%' }}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Timeline */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0 24px' }}>
          {events === null && <ListSkeleton rows={6} />}
          {events !== null && groups.length === 0 && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
              <Icon name="history" size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
              <div>No events match these filters.</div>
            </div>
          )}
          {groups.map((g, gi) => (
            <div key={gi}>
              <div style={{
                position: 'sticky', top: 0, zIndex: 2,
                padding: '10px 22px 6px',
                background: 'var(--bg-elev)',
                fontSize: 11, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                color: 'var(--fg-subtle)',
                borderBottom: '1px solid var(--border)',
              }}>
                {fmtDate(g.date)}
              </div>
              <div style={{ padding: '6px 22px 12px' }}>
                {g.events.map((e, ei) => {
                  const meta = ACTION_META[e.kind] ?? ACTION_META.edited;
                  const isLast = ei === g.events.length - 1;
                  return (
                    <div key={e.id} style={{
                      position: 'relative',
                      display: 'grid', gridTemplateColumns: '28px 1fr',
                      gap: 10, paddingBottom: isLast ? 4 : 16,
                    }}>
                      {!isLast && (
                        <div style={{
                          position: 'absolute', left: 13, top: 26, bottom: -2,
                          width: 2, background: 'var(--border)',
                        }} />
                      )}
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%',
                        display: 'grid', placeItems: 'center',
                        background: 'var(--bg-elev)',
                        border: `2px solid ${meta.dot}`,
                        color: meta.dot,
                        flexShrink: 0, zIndex: 1,
                      }}>
                        <Icon name={meta.icon} size={12} stroke={2} />
                      </div>
                      <EventCard event={e} itemLabel={itemLabel(e)} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div style={{
          padding: '10px 22px', borderTop: '1px solid var(--border)',
          fontSize: 11, color: 'var(--fg-subtle)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon name="shield" size={11} />
          Audit log is immutable — events cannot be edited or deleted.
        </div>
      </div>
    </div>
  );
}

// ─── Event card ──────────────────────────────────────────────────────────────
function EventCard({ event, itemLabel }: { event: Event; itemLabel: string }) {
  const d = event.detail as Record<string, unknown>;
  const time = new Date(event.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const summary =
      event.kind === 'created'     ? 'Item created'
    : event.kind === 'status'      ? 'Status changed'
    : event.kind === 'priced'      ? 'Sell price updated'
    : event.kind === 'transferred' ? 'Transferred'
    : event.kind === 'edited'      ? `${String(d.field ?? 'Field')} updated`
    : event.kind;

  const field = String(d.field ?? '');
  const from  = d.from;
  const to    = d.to;
  const transferQty  = typeof d.qty  === 'number' ? d.qty  : null;
  const transferNote = typeof d.note === 'string' ? d.note : null;

  return (
    <div style={{
      background: 'var(--bg-soft)',
      border: '1px solid var(--border)',
      borderRadius: 8, padding: '10px 12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          {summary}
          {field === 'status' && from != null && to != null && (
            <span style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span className={'chip ' + statusTone(String(from))} style={{ fontSize: 10.5 }}>{String(from)}</span>
              <Icon name="arrow" size={11} style={{ color: 'var(--fg-subtle)' }} />
              <span className={'chip dot ' + statusTone(String(to))} style={{ fontSize: 10.5 }}>{String(to)}</span>
            </span>
          )}
          {field && field !== 'status' && from != null && to != null && (
            <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--fg-subtle)' }}>
              <span className="mono" style={{ textDecoration: 'line-through', opacity: 0.7 }}>{String(from)}</span>
              <Icon name="arrow" size={10} style={{ margin: '0 5px', verticalAlign: 'middle' }} />
              <span className="mono" style={{ color: 'var(--fg)', fontWeight: 500 }}>{String(to)}</span>
            </span>
          )}
          {event.kind === 'transferred' && from != null && to != null && (
            <span style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-subtle)' }}>
              {transferQty != null && (
                <span className="mono" style={{ color: 'var(--fg)', fontWeight: 500 }}>{transferQty} units</span>
              )}
              <span style={{ color: 'var(--border)' }}>·</span>
              <span className="mono">{String(from)}</span>
              <Icon name="arrow" size={10} style={{ color: 'var(--fg-subtle)' }} />
              <span className="mono" style={{ color: 'var(--fg)', fontWeight: 500 }}>{String(to)}</span>
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontVariantNumeric: 'tabular-nums' }}>
          {time}
        </div>
      </div>
      <div style={{
        marginTop: 8, display: 'flex', alignItems: 'center', gap: 10,
        fontSize: 11.5, color: 'var(--fg-subtle)', flexWrap: 'wrap',
      }}>
        {event.actor_initials && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="avatar sm" style={{ width: 18, height: 18, fontSize: 9 }}>
              {event.actor_initials}
            </span>
            {event.actor_name}
          </span>
        )}
        <span style={{ color: 'var(--border)' }}>·</span>
        <span className="mono" style={{ fontSize: 11 }}>{event.line_id.slice(0, 8)}</span>
        <span style={{ color: 'var(--fg-subtle)' }}>{itemLabel}</span>
        {transferNote && (
          <>
            <span style={{ color: 'var(--border)' }}>·</span>
            <span style={{ fontStyle: 'italic' }}>"{transferNote}"</span>
          </>
        )}
      </div>
    </div>
  );
}
