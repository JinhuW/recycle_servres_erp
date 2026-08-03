import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTIVITY_ACTIONS, type ActivityAction, type ActivityArea,
} from '@recycle-erp/shared';
import { Icon, type IconName } from '../../components/Icon';
import { ListSkeleton } from '../../components/Skeleton';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDate, fmtUSD } from '../../lib/format';
import { useT } from '../../lib/i18n';

// The global audit register — every change made across all four ledgers, in
// one record. Read-only; the source tables are append-only by trigger.
//
// Deliberately not the dot-and-rail timeline used by OrderActivityLog and
// DesktopActivityDrawer: at full width those can't be scanned by actor and the
// diff ends up buried in a card body. Here the five lanes stay aligned so a
// column of price movements can be read straight down.

type Actor = { id: string; name: string | null; initials: string | null };
type Event = {
  id: string;
  area: ActivityArea;
  createdAt: string;
  kind: string;
  action: ActivityAction;
  target: string;
  targetRef: string | null;
  detail: Record<string, unknown>;
  actor: Actor | null;
};
type Feed = { events: Event[]; counts: Record<string, number>; nextCursor: string | null };
type Member = { id: string; name: string };

const AREAS: { id: 'all' | ActivityArea; tKey: string }[] = [
  { id: 'all',   tKey: 'acAreaAll' },
  { id: 'po',    tKey: 'acAreaPo' },
  { id: 'so',    tKey: 'acAreaSo' },
  { id: 'inv',   tKey: 'acAreaInv' },
  { id: 'price', tKey: 'acAreaPrice' },
];

const ACTION_TKEY: Record<ActivityAction, string> = {
  created: 'acActCreated', status: 'acActStatus', edited: 'acActEdited',
  added: 'acActAdded', removed: 'acActRemoved', priced: 'acActPriced',
  moved: 'acActMoved', archived: 'acActArchived', note: 'acActNote',
};

// Chip tone per action, reusing the .chip classes from tokens.css.
const ACTION_TONE: Record<ActivityAction, string> = {
  created: 'pos', status: 'info', edited: '', added: 'pos', removed: 'neg',
  priced: 'warn', moved: 'info', archived: '', note: '',
};

const RANGES: { days: number; tKey: string }[] = [
  { days: 0, tKey: 'acRangeAll' },
  { days: 1, tKey: 'acRangeToday' },
  { days: 3, tKey: 'acRange3' },
  { days: 7, tKey: 'acRange7' },
];

// Field labels shared with OrderActivityLog's vocabulary — the two panels
// describe the same underlying diffs, so they must not disagree.
const FIELD_LABEL: Record<string, string> = {
  sell_price: 'Sell price', qty: 'Qty', unit_cost: 'Unit cost', unit_price: 'Unit price',
  brand: 'Brand', capacity: 'Capacity', type: 'Type', generation: 'Generation',
  classification: 'Classification', rank: 'Rank', speed: 'Speed', interface: 'Interface',
  form_factor: 'Form factor', description: 'Description', part_number: 'Part number',
  serial_number: 'Serial number', chip_number: 'Chip number', condition: 'Condition',
  health: 'Health', rpm: 'RPM', notes: 'Notes', warehouse_id: 'Warehouse',
  payment: 'Payment', total_cost: 'Goods total', commission_rate: 'Commission rate',
  other_fees: 'Other fees', other_fees_note: 'Other fees note',
  customer_id: 'Customer', currency_code: 'Currency', payment_received_by: 'Payment received by',
  label: 'Label', sub_label: 'Sub-label', inventory_id: 'Inventory item', status: 'Status',
};
const MONEY_FIELDS = new Set(['sell_price', 'unit_cost', 'unit_price', 'total_cost', 'price', 'other_fees']);

type Change = { field: string; from: unknown; to: unknown };

function renderValue(field: string, v: unknown, locale: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'commission_rate' && typeof v === 'number') return (v * 100).toFixed(2) + '%';
  if (MONEY_FIELDS.has(field) && typeof v === 'number') return fmtUSD(v, locale);
  return String(v);
}

type T = (key: string, vars?: Record<string, string | number>) => string;

// Reduce an event to the one line the Change lane shows. Returns either a
// field diff (rendered as struck-old → solid-new) or a plain sentence.
function summarise(e: Event, locale: string, t: T): { diff?: Change; note?: string; plain?: string } {
  const d = e.detail;
  const changes = Array.isArray(d.changes) ? (d.changes as Change[]) : null;
  if (changes?.length) {
    return {
      diff: changes[0],
      note: changes.length > 1
        ? t('acAndMore', { n: changes.length - 1 })
        : (d.partNumber as string) || undefined,
    };
  }
  if (e.area === 'price') {
    return {
      diff: { field: 'price', from: null, to: d.price },
      note: [d.source, d.note].filter(Boolean).join(' · ') || undefined,
    };
  }
  // status_meta_changed carries a note or an attachment, not a from/to pair —
  // rendering it as a diff prints "attachment_added → —".
  if (e.kind === 'status_meta_changed') {
    if (d.field === 'note') return { plain: String(d.to ?? ''), note: String(d.status ?? '') };
    return {
      plain: t(d.field === 'attachment_removed' ? 'acFileRemoved' : 'acFileAdded'),
      note: String(d.filename ?? ''),
    };
  }
  if (d.field !== undefined && (d.from !== undefined || d.to !== undefined)) {
    return { diff: { field: String(d.field), from: d.from, to: d.to } };
  }
  if (d.from !== undefined && d.to !== undefined) {
    return { diff: { field: '', from: d.from, to: d.to } };
  }
  // Rows synthesised by migration 0076 counted their lines at backfill time,
  // not at creation, so those numbers contradict the line events beneath them.
  // Show the category alone, exactly as OrderActivityLog does.
  if (e.kind === 'created') {
    if (d.backfilled) return { plain: String(d.category ?? '') };
    return { plain: [
      d.category,
      t('acNLines', { n: (d.lineCount as number) ?? 0 }),
      d.qty ? t('acNUnits', { n: d.qty as number }) : null,
    ].filter(Boolean).join(' · ') };
  }
  if (e.kind === 'submitted') {
    return { plain: [
      t('acNLines', { n: (d.lineCount as number) ?? 0 }),
      t('acNUnits', { n: (d.qty as number) ?? 0 }),
      fmtUSD((d.totalCost as number) ?? 0, locale),
    ].join(' · ') };
  }
  if (d.partNumber) {
    return { plain: [d.partNumber, d.qty ? t('acQty', { n: d.qty as number }) : null]
      .filter(Boolean).join(' · ') };
  }
  if (d.filename) return { plain: String(d.filename) };
  return { plain: '' };
}

const AREA_ICON: Record<ActivityArea, IconName> = {
  po: 'file', so: 'tag', inv: 'inventory', price: 'trending',
};

export function DesktopActivity() {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const [area, setArea] = useState<'all' | ActivityArea>('all');
  const [action, setAction] = useState<'' | ActivityAction>('');
  const [actor, setActor] = useState('');
  const [days, setDays] = useState(0);
  const [search, setSearch] = useState('');

  const [feed, setFeed] = useState<Feed | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Guards against a slow first request landing after a faster later one and
  // overwriting it with stale rows.
  const reqId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const params = useCallback((cursor?: string) => {
    const p = new URLSearchParams();
    if (area !== 'all') p.set('area', area);
    if (action) p.set('action', action);
    if (actor) p.set('actor', actor);
    if (search.trim()) p.set('q', search.trim());
    if (days) {
      const from = new Date();
      from.setDate(from.getDate() - (days - 1));
      from.setHours(0, 0, 0, 0);
      p.set('since', from.toISOString());
    }
    if (cursor) p.set('cursor', cursor);
    return p;
  }, [area, action, actor, search, days]);

  useEffect(() => {
    api.get<{ items: Member[] }>('/api/members')
      .then(r => setMembers(r.items))
      .catch(handleFetchError);
  }, []);

  useEffect(() => {
    const id = ++reqId.current;
    const handle = setTimeout(() => {
      setFeed(null);
      setOpen(new Set());
      api.get<Feed>(`/api/activity?${params()}`)
        .then(r => { if (id === reqId.current) setFeed(r); })
        .catch(handleFetchError);
    }, 200);
    return () => clearTimeout(handle);
  }, [params]);

  const loadMore = useCallback(() => {
    if (!feed?.nextCursor || loadingMore) return;
    const id = reqId.current;
    setLoadingMore(true);
    api.get<Feed>(`/api/activity?${params(feed.nextCursor)}`)
      // A filter change mid-flight bumps reqId and resets the feed; dropping
      // the response here stops an older page appending under new filters.
      .then(r => { if (id === reqId.current) setFeed(prev => prev && ({
        ...r, events: [...prev.events, ...r.events],
      })); })
      .catch(handleFetchError)
      .finally(() => setLoadingMore(false));
  }, [feed?.nextCursor, loadingMore, params]);

  // Auto-load the next page when the end of the list scrolls into the
  // register. rootMargin starts the fetch a screenful early so the rows are
  // usually already there by the time you reach the bottom.
  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root || !feed?.nextCursor) return;
    const io = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { root, rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, feed?.nextCursor]);

  const reset = () => {
    setArea('all'); setAction(''); setActor(''); setDays(0); setSearch('');
  };

  // Group by local day so the register gets its page-break rules.
  const groups = useMemo(() => {
    const out: { key: string; date: Date; events: Event[] }[] = [];
    for (const e of feed?.events ?? []) {
      const d = new Date(e.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const last = out[out.length - 1];
      if (last?.key === key) last.events.push(e);
      else out.push({ key, date: d, events: [e] });
    }
    return out;
  }, [feed]);

  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('acTitle')}</h1>
          <div className="page-sub">{t('acSub')}</div>
        </div>
        <span className="chip info">
          <Icon name="lock" size={10} /> {t('acImmutable')}
        </span>
      </div>

      <div className="ac-deck">
        <div className="ac-areas" role="group" aria-label={t('acFilterByArea')}>
          {AREAS.map(a => (
            <button
              key={a.id}
              type="button"
              className="ac-area"
              data-area={a.id}
              aria-pressed={area === a.id}
              onClick={() => setArea(a.id)}
            >
              <span className="ac-bar" />
              {t(a.tKey)}
              <span className="ac-n">{feed?.counts[a.id] ?? '—'}</span>
            </button>
          ))}
        </div>

        <div className="ac-controls">
          <div className="ac-search">
            <Icon name="search" size={13} />
            <input
              className="input"
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('acSearchPlaceholder')}
              aria-label={t('acSearchPlaceholder')}
            />
          </div>
          <select
            className="select" value={actor} aria-label={t('acFilterByPerson')}
            onChange={e => setActor(e.target.value)}
          >
            <option value="">{t('acAnyone')}</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select
            className="select" value={action} aria-label={t('acFilterByAction')}
            onChange={e => setAction(e.target.value as '' | ActivityAction)}
          >
            <option value="">{t('acAnyAction')}</option>
            {ACTIVITY_ACTIONS.map(a => (
              <option key={a} value={a}>{t(ACTION_TKEY[a])}</option>
            ))}
          </select>
          <select
            className="select" value={days} aria-label={t('acFilterByRange')}
            onChange={e => setDays(Number(e.target.value))}
          >
            {RANGES.map(r => <option key={r.days} value={r.days}>{t(r.tKey)}</option>)}
          </select>
          <button type="button" className="ac-reset" onClick={reset}>{t('acClear')}</button>
        </div>
      </div>

      <div className="ac-register">
        <div className="ac-scroll" ref={scrollRef}>
          <div className="ac-inner">
            <div className="ac-lanes" aria-hidden="true">
              <span />
              <span>{t('acLaneTime')}</span>
              <span>{t('acLanePerson')}</span>
              <span>{t('acLaneRecord')}</span>
              <span>{t('acLaneAction')}</span>
              <span>{t('acLaneChange')}</span>
            </div>

            {feed === null && <ListSkeleton rows={8} />}

            {feed !== null && groups.length === 0 && (
              <div className="ac-empty">
                <div className="ac-big">{t('acEmptyTitle')}</div>
                {t('acEmptyHint')}
              </div>
            )}

            {groups.map(g => (
              <div key={g.key}>
                <div className="ac-day">
                  {fmtDate(g.date, locale)}
                  <span className="ac-line" />
                  <span className="ac-n">
                    {g.events.length} {g.events.length === 1 ? t('acEvent') : t('acEvents')}
                  </span>
                </div>
                {g.events.map(e => {
                  const s = summarise(e, locale, t);
                  const isOpen = open.has(e.id);
                  const time = new Date(e.createdAt)
                    .toLocaleTimeString(locale, { hour12: false });
                  return (
                    <div key={e.id}>
                      <button
                        type="button"
                        className="ac-row"
                        data-area={e.area}
                        aria-expanded={isOpen}
                        onClick={() => toggle(e.id)}
                      >
                        <span className="ac-stripe" />
                        <span className="ac-t">{time}</span>
                        <span className="ac-who">
                          <span className="avatar sm" style={{ width: 20, height: 20, fontSize: 9 }}>
                            {e.actor?.initials ?? '—'}
                          </span>
                          <span>{e.actor?.name ?? t('acUnattributed')}</span>
                        </span>
                        <span className={'ac-target' + (e.area === 'inv' || e.area === 'price' ? ' ac-dim' : '')}>
                          {e.target}
                        </span>
                        <span className={'chip ' + ACTION_TONE[e.action]} style={{ width: 'fit-content' }}>
                          {t(ACTION_TKEY[e.action])}
                        </span>
                        <span className="ac-change">
                          {s.diff ? (
                            <>
                              {s.diff.field && (
                                <span className="ac-k">{FIELD_LABEL[s.diff.field] ?? s.diff.field} </span>
                              )}
                              {s.diff.from !== null && s.diff.from !== undefined && (
                                <span className="ac-was">{renderValue(s.diff.field, s.diff.from, locale)}</span>
                              )}
                              <span className="ac-arr">→</span>
                              <span className="ac-now">{renderValue(s.diff.field, s.diff.to, locale)}</span>
                              {s.note && <span className="ac-more">{s.note}</span>}
                            </>
                          ) : (
                            <>
                              <span className="ac-plain">{s.plain}</span>
                              {s.note && <span className="ac-more">{s.note}</span>}
                            </>
                          )}
                        </span>
                      </button>

                      {isOpen && (
                        <div className="ac-detail">
                          <div className="ac-detail-inner">
                            <div className="ac-detail-grid">
                              <Field k={t('acLaneRecord')} v={e.target} />
                              <Field k={t('acFieldArea')} v={t(AREAS.find(a => a.id === e.area)!.tKey)} />
                              <Field k={t('acFieldKind')} v={e.kind} />
                              <Field k={t('acLanePerson')} v={e.actor?.name ?? t('acUnattributed')} />
                              <Field
                                k={t('acFieldWhen')}
                                v={new Date(e.createdAt).toLocaleString(locale, {
                                  dateStyle: 'medium', timeStyle: 'medium',
                                })}
                              />
                            </div>
                            {Array.isArray(e.detail.changes) && (
                              <div className="ac-diffs">
                                {(e.detail.changes as Change[]).map((c, i) => (
                                  <div key={i}>
                                    <span className="ac-k">{FIELD_LABEL[c.field] ?? c.field}: </span>
                                    <span className="ac-was">{renderValue(c.field, c.from, locale)}</span>
                                    <span className="ac-arr">→</span>
                                    <span className="ac-now">{renderValue(c.field, c.to, locale)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div>
                              <a
                                className="btn sm"
                                href={
                                  e.area === 'po'  ? `/purchase-orders/${e.targetRef}`
                                  : e.area === 'so' ? `/sell-orders/${e.targetRef}`
                                  : e.area === 'inv' ? `/inventory/${e.targetRef}`
                                  : '/market'
                                }
                              >
                                <Icon name={AREA_ICON[e.area]} size={12} />
                                {t('acOpenRecord')}
                              </a>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {feed?.nextCursor && (
              <div className="ac-more-row" aria-live="polite">
                {loadingMore && <span className="busy-spinner" />}
                <span>{loadingMore ? t('acLoading') : t('acScrollForMore')}</span>
              </div>
            )}
            {/* Sits after the last row so the observer fires as the tail of
                the list comes into view, not when the page first renders. */}
            <div ref={sentinelRef} className="ac-sentinel" aria-hidden="true" />
          </div>
        </div>

        <div className="ac-foot">
          <Icon name="shield" size={11} />
          <span>
            {feed
              ? `${feed.events.length} / ${feed.counts.all} ${t('acEvents')}`
              : t('acLoading')}
          </span>
          <span style={{ marginLeft: 'auto' }}>{t('acAppendOnly')}</span>
        </div>
      </div>

      <div className="ac-note">
        <b>{t('acLegendTitle')}</b> {t('acLegendBody')}
        <div className="ac-legend">
          {AREAS.filter(a => a.id !== 'all').map(a => (
            <span key={a.id}>
              <i style={{ background: {
                po: 'var(--info)', so: 'var(--accent)',
                inv: 'oklch(0.72 0.13 75)', price: 'oklch(0.55 0.16 295)',
              }[a.id as ActivityArea] }} />
              {t(a.tKey)}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="ac-field">
      <span className="ac-field-k">{k}</span>
      <span className="ac-field-v">{v}</span>
    </div>
  );
}
