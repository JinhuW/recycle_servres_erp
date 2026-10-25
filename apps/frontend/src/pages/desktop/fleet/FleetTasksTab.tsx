import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { FormSkeleton, TableSkeleton } from '../../../components/Skeleton';
import {
  fleetApi, fleetErrorCode, type FleetCity, type FleetCityLogTask, type FleetItem, type FleetSettings, type FleetSlot, type FleetTask,
  type FleetTaskEvent, type FleetWorker,
} from '../../../lib/fleet';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { fleetTabPath, hrefFor, onLinkClick } from '../../../lib/route';
import {
  averageTaskSeconds, BELT_WINDOW_H, beltAxis, beltRow, beltSummary, dueLabel, EMPTY_TASK_FILTER, easternClock, filterTasks, homeWorkerOf,
  lastDoneSearch, logByItem, roundStartPreview, sortTasks, withCityNames, workersBusy,
  type BeltMark, type BeltRow, type TaskFilter, type Translate,
} from './fleetBoard';
import { agoLabel, Clock, EmptyRow, UnavailableCard, useFleetPoll, WorkerLink } from './shared';

// ─── Tasks ────────────────────────────────────────────────────────────────────
// What the fleet is working through. The belt: one row per enabled item on a
// 24-hour window centred on now, in Eastern time, with the searches done to
// the left, the overdue stack at now, the running ones just right of it and
// the waiting ones at their due time. Under it the task table with a state
// segment, an item select, a search box and a range, and beside it the log
// of the city a row was clicked on. "Search a city now" and "Start the round
// now" are the tab's actions.

const RANGES = [
  { key: '24h', hours: 24 }, { key: '7d', hours: 24 * 7 }, { key: 'today', hours: 0 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];
const LOG_HOURS = 24 * 7;
const TABLE_MAX = 60;

const STATE_SEG = ['', 'leased', 'ready', 'done', 'cancelled', 'expired'] as const;
const STATE_SEG_KEY: Record<(typeof STATE_SEG)[number], string> = {
  '': 'fleetSegAll', leased: 'fleetSegRunning', ready: 'fleetSegDue', done: 'fleetSegDone', cancelled: 'fleetSegCancelled', expired: 'fleetSegExpired',
};

type Data = { cities: FleetCity[]; items: FleetItem[]; tasks: FleetTask[]; workers: FleetWorker[]; slots: FleetSlot[]; settings: FleetSettings | null };

function sinceFor(range: RangeKey, now: number): string {
  if (range === 'today') return new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const hours = RANGES.find(r => r.key === range)!.hours;
  return new Date(now - hours * 3_600_000).toISOString();
}

export function FleetTasksTab() {
  const { t } = useT();
  const [range, setRange] = useState<RangeKey>('24h');
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const { data, reload } = useFleetPoll<Data>(() => {
    const since = sinceFor(rangeRef.current, Date.now());
    return Promise.all([
      fleetApi.cities(), fleetApi.items(),
      // The range reaches back from now; every waiting task is read as well,
      // so a long-overdue one is on the belt whatever the range.
      Promise.all([fleetApi.tasks({ since }), fleetApi.tasks({ state: 'ready' })]).then(([a, b]) => {
        const seen = new Set(a.map(x => x.id));
        return [...a, ...b.filter(x => !seen.has(x.id))];
      }),
      fleetApi.workers(), fleetApi.slots(),
      fleetApi.settings().catch(() => null),
    ]).then(([cities, items, tasks, workers, slots, settings]) =>
      ({ cities, items, tasks: withCityNames(tasks, cities), workers, slots, settings }));
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    reload();
  }, [range, reload]);
  const [starting, setStarting] = useState(false);
  const [searching, setSearching] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>(EMPTY_TASK_FILTER);
  const [selected, setSelected] = useState<string | null>(null);

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const items = data?.items.filter(i => i.enabled).map(i => i.name) ?? [];
  const freshHours = data?.settings?.start_fresh_hours ?? 2;
  const city = data && selected ? data.cities.find(c => c.slug === selected) ?? null : null;

  return (
    <div className="fp-pool">
      <div className="fleet-tab-head">
        <p className="fleet-lede">{t('fleetTasksLede')}</p>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setSearching('')} disabled={!data || items.length === 0}>{t('fleetSearchCityNow')}</button>
          <button type="button" className="btn primary" onClick={() => setStarting(true)} disabled={!data}>{t('fleetRoundStart')}</button>
        </div>
      </div>
      <section className="card fleet-card" aria-label={t('fleetBeltTitle')}>
        <div className="card-body">
          {data === null ? <FormSkeleton fields={2} withHeader={false} />
            : <Belt tasks={data.tasks} items={items} workers={data.workers} cityCount={data.cities.filter(c => c.enabled).length} />}
        </div>
      </section>
      <div className="fleet-split">
        <section className="card fleet-card" aria-label={t('fleetTasksTitle')}>
          {data === null ? <TableSkeleton rows={6} cols={8} />
            : <TaskTable tasks={data.tasks} items={items} filter={filter} onFilter={setFilter} range={range} onRange={setRange}
                selected={selected} onSelect={setSelected} />}
        </section>
        <CityLogAside city={city} items={items} slots={data?.slots ?? []} onSearchNow={slug => setSearching(slug)} />
      </div>
      {starting && data && (
        <StartRoundDialog cities={data.cities} items={items} freshHours={freshHours}
          onClose={() => setStarting(false)} onDone={() => { setStarting(false); reload(); }} />
      )}
      {searching !== null && data && (
        <SearchNowDialog cities={data.cities} items={items} tasks={data.tasks} initial={searching}
          onClose={() => setSearching(null)} onDone={() => { setSearching(null); reload(); }} />
      )}
    </div>
  );
}

// ─── The belt ─────────────────────────────────────────────────────────────────

const MARK_SHOWN = 7;
const TITLE_MAX = 12;

function markTitle(t: Translate, m: BeltMark, locale: string, now: number): string {
  const lines = m.tasks.slice(0, TITLE_MAX).map(task => {
    const city = task.city_name ?? task.city;
    if (m.kind === 'done') {
      return t('fleetBeltDoneTitle', {
        city, time: easternClock(task.done_at, locale, now), by: task.worker_id ?? '—',
        cards: task.result?.cards ?? 0, alerts: task.result?.alerted ?? 0,
      });
    }
    if (m.kind === 'leased') return t('fleetBeltLeasedTitle', { city, by: task.worker_id ?? '—', time: easternClock(task.leased_at, locale, now) });
    return t('fleetBeltLaterTitle', { city, time: easternClock(task.due_at, locale, now) });
  });
  if (m.tasks.length > TITLE_MAX) lines.push('…');
  return lines.join('\n');
}

export function Belt({ tasks, items, workers, cityCount, now = Date.now() }: {
  tasks: readonly FleetTask[]; items: readonly string[]; workers: readonly FleetWorker[]; cityCount: number; now?: number;
}) {
  const { t, locale } = useT();
  const rows: BeltRow[] = useMemo(() => items.map(item => beltRow(tasks, item, now)), [tasks, items, now]);
  const summary = beltSummary(rows, workersBusy(workers, now), averageTaskSeconds(tasks, now));
  const axis = beltAxis(now, locale);
  const windowStart = easternClock(new Date(now - BELT_WINDOW_H * 3_600_000).toISOString(), locale, now);
  const windowEnd = easternClock(new Date(now + BELT_WINDOW_H * 3_600_000).toISOString(), locale, now);
  if (items.length === 0) return <p className="fp-muted">{t('fleetBoardNoCities')}</p>;
  // The sentence: who is searching, what is due and how long that takes, what
  // was done and what comes next.
  const sentence = [
    summary.idle === 0 ? t('fleetBeltBusy', { n: summary.busy }) : t('fleetBeltBusyIdle', { n: summary.busy, idle: summary.idle }),
    summary.due === 0 ? t('fleetBeltNothingDue') : t('fleetBeltDue', { n: summary.due, minutes: summary.clearMinutes }),
    t('fleetBeltDoneLater', { done: summary.done, later: summary.later, hours: BELT_WINDOW_H }),
  ].join(' ');
  return (
    <>
      <div className="fleet-belt-head">
        <p className="fleet-belt-sentence">{sentence}</p>
        <span className="card-sub">{t('fleetBeltSub')}</span>
      </div>
      <div className="fleet-belt">
        {rows.map(r => {
          const total = cityCount;
          return (
            <div key={r.item} className="fleet-belt-row">
              <div className="fleet-belt-label">
                <span className="mono fleet-belt-item">{r.item}</span>
                <small>
                  {t('fleetBeltRowDone', { done: r.counts.done, total, since: windowStart })}<br />
                  {t('fleetBeltRowOpen', { leased: r.counts.leased, due: r.counts.due, later: r.counts.later, until: windowEnd })}
                </small>
              </div>
              <div className="fleet-belt-track">
                {[-9, -6, -3, 3, 6, 9].map(h => <i key={h} className="fleet-belt-grid" style={{ left: `${(h + BELT_WINDOW_H) / (2 * BELT_WINDOW_H) * 100}%` }} />)}
                <i className="fleet-belt-now" style={{ left: '50%' }} />
                {r.marks.map(m => {
                  const n = m.tasks.length;
                  const shown = Math.min(n, MARK_SHOWN);
                  return (
                    <span key={m.key} className={`fleet-bucket fleet-bucket-${m.kind}`} style={{ left: `${m.left}%` }} title={markTitle(t, m, locale, now)}>
                      {Array.from({ length: shown }, (_, i) => <i key={i} />)}
                      {n > shown && <span className="fleet-bucket-more">+{n - shown}</span>}
                    </span>
                  );
                })}
                {r.counts.due > 0 && (
                  <span className="fleet-wall" title={r.due.slice(0, TITLE_MAX).map(x =>
                    t('fleetBeltDueTitle', { city: x.city_name ?? x.city, time: easternClock(x.due_at, locale, now) })
                    + (x.priority >= 100 ? ` · ${t('fleetReason_manual')}` : '')).join('\n')}>
                    <span className="fleet-wall-n">{t('fleetBeltDueNow', { n: r.counts.due })}</span>
                    <span className="fleet-wall-bar" style={{ height: `${Math.min(70, 6 + r.counts.due * 4)}px` }} />
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div />
        <div className="fleet-belt-axis">
          {axis.map(a => <span key={a.label + a.left} style={{ left: `${a.left}%` }}>{a.label}</span>)}
          <span className="fleet-belt-nowlbl" style={{ left: '50%' }}>{t('fleetBeltNow', { time: easternClock(new Date(now).toISOString(), locale, now) })}</span>
        </div>
      </div>
      <ul className="fleet-belt-key" aria-hidden>
        <li><i className="fleet-key-done" />{t('fleetKeySearched')}</li>
        <li><i className="fleet-key-leased" />{t('fleetKeyRunning')}</li>
        <li><i className="fleet-key-due" />{t('fleetKeyDueWaiting')}</li>
        <li><i className="fleet-key-later" />{t('fleetKeyDueLater')}</li>
      </ul>
    </>
  );
}

// ─── The task table ───────────────────────────────────────────────────────────

const STATE_CHIP: Record<string, string> = {
  leased: 'chip info', ready: 'chip warn', later: 'chip muted', done: 'chip pos', cancelled: 'chip muted', expired: 'chip neg',
};

function StateChip({ task, now }: { task: FleetTask; now: number }) {
  const { t } = useT();
  const later = task.state === 'ready' && Date.parse(task.due_at) > now;
  const cls = later ? 'later' : task.state;
  return (
    <span className="fleet-chips">
      <span className={STATE_CHIP[cls]}>{t(later ? 'fleetState_later' : `fleetState_${task.state}`)}</span>
      {task.priority >= 100 && (task.state === 'ready' || task.state === 'leased') && <span className="chip warn">{t('fleetTaskFront')}</span>}
    </span>
  );
}

const mmss = (seconds: number) => `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;

export function TaskTable({ tasks, items, filter, onFilter, range, onRange, selected, onSelect, now = Date.now() }: {
  tasks: readonly FleetTask[]; items: readonly string[]; filter: TaskFilter; onFilter: (f: TaskFilter) => void;
  range: RangeKey; onRange: (r: RangeKey) => void; selected: string | null; onSelect: (slug: string) => void; now?: number;
}) {
  const { t, locale } = useT();
  const rows = useMemo(() => sortTasks(filterTasks(tasks, filter, now), now), [tasks, filter, now]);
  const shown = rows.slice(0, TABLE_MAX);
  const set = (patch: Partial<TaskFilter>) => onFilter({ ...filter, ...patch });
  const doneDay = tasks.filter(x => x.state === 'done' && x.done_at && now - Date.parse(x.done_at) < 86_400_000).length;
  return (
    <>
      <div className="fp-toolbar fleet-toolbar">
        <div className="seg fleet-seg" role="group" aria-label={t('fleetColState')}>
          {STATE_SEG.map(s => (
            <button key={s} type="button" className={filter.state === s ? 'active' : undefined} onClick={() => set({ state: s })}>{t(STATE_SEG_KEY[s])}</button>
          ))}
        </div>
        <select className="input fleet-select" value={filter.item} aria-label={t('fleetColItem')} onChange={e => set({ item: e.target.value })}>
          <option value="">{t('fleetFilterAnyItem')}</option>
          {items.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={filter.q} autoComplete="off" placeholder={t('fleetSearchTasks')}
            aria-label={t('fleetSearchTasks')} onChange={e => set({ q: e.target.value })} />
        </label>
        <select className="input fleet-select" value={range} aria-label={t('fleetRange')} onChange={e => onRange(e.target.value as RangeKey)}>
          {RANGES.map(r => <option key={r.key} value={r.key}>{t(`fleetRange_${r.key}`)}</option>)}
        </select>
      </div>
      <div className="fp-table-wrap fleet-table-cap">
        <table className="fp-table fleet-table fleet-tasks">
          <thead>
            <tr>
              <th>{t('fleetColCity')}</th>
              <th>{t('fleetColItem')}</th>
              <th>{t('fleetColState')}</th>
              <th>{t('fleetColDue')}</th>
              <th>{t('fleetColWorker')}</th>
              <th className="num">{t('fleetColTook')}</th>
              <th className="num">{t('fleetColCards')}</th>
              <th className="num">{t('fleetColAlerts')}</th>
              <th>{t('fleetColWhy')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <EmptyRow cols={9}>{t('fleetTasksNone')}</EmptyRow>}
            {shown.map(task => {
              const name = task.city_name ?? task.city;
              const sub = task.state === 'ready'
                ? (Date.parse(task.due_at) <= now ? agoLabel(t, task.due_at, now) : dueLabel(t, task.due_at, now))
                : task.state === 'leased' ? t('fleetStartedAt', { time: easternClock(task.leased_at ?? task.due_at, locale, now) })
                : task.state === 'done' ? t('fleetDoneAt', { time: easternClock(task.done_at, locale, now) })
                : task.done_at ? t('fleetEndedAt', { time: easternClock(task.done_at, locale, now) }) : '';
              const took = task.state === 'leased' && task.leased_at
                ? <span className="chip info mono">{mmss((now - Date.parse(task.leased_at)) / 1000)}</span>
                : typeof task.result?.seconds === 'number' ? mmss(task.result.seconds) : '';
              return (
                <tr key={task.id} className={task.city === selected ? 'fleet-row-sel' : undefined} onClick={() => onSelect(task.city)}
                  title={t('fleetCityLogOpen', { city: name })}>
                  <td>
                    <span className="fp-holder">
                      <button type="button" className="fleet-city-name fleet-city-pick" onClick={e => { e.stopPropagation(); onSelect(task.city); }}>{name}</button>
                      {task.kind !== 'search' && <small className="mono">{t(`fleetKind_${task.kind}`)}</small>}
                    </span>
                  </td>
                  <td className="mono">{task.item}</td>
                  <td><StateChip task={task} now={now} /></td>
                  <td>
                    <span className="fp-holder">
                      <Clock at={task.due_at} now={now} />
                      {sub && <small>{sub}</small>}
                    </span>
                  </td>
                  <td>
                    {task.worker_id ? (
                      <span className="fp-holder">
                        <WorkerLink id={task.worker_id} />
                        {task.account_no !== null && <small>{t('fleetAccountN', { no: task.account_no })}</small>}
                      </span>
                    ) : <span className="fp-muted">—</span>}
                  </td>
                  <td className="num">{took}</td>
                  <td className="num">{task.result?.cards ?? ''}</td>
                  <td className="num">{task.result?.alerted ? <b className="fleet-alerted">{task.result.alerted}</b> : task.result?.alerted === 0 ? '0' : ''}</td>
                  <td className="fp-muted">{task.reason ? t(`fleetReason_${task.reason}`) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="fp-table-foot fleet-foot">
        <span>{t('fleetTasksFoot', { shown: shown.length, n: rows.length, done: doneDay })}</span>
        <span>{t('fleetTasksFootHint')}</span>
      </div>
    </>
  );
}

// ─── The city log aside ───────────────────────────────────────────────────────

type LogState = FleetCityLogTask[] | 'failed' | null;

const EVENT_KEY: Record<FleetTaskEvent['kind'], string> = {
  handed: 'fleetEvent_handed', started: 'fleetEvent_started', searched: 'fleetEvent_searched', finished: 'fleetEvent_finished',
  stopped: 'fleetEvent_stopped', released: 'fleetEvent_released', expired: 'fleetEvent_expired', done: 'fleetEvent_done',
};

// An event's detail is whatever the worker sent; it reads as "key value" pairs.
function detailText(detail: Record<string, unknown> | null): string {
  if (!detail) return '';
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(', ');
}

export function CityLogAside({ city, items, slots, onSearchNow, now = Date.now() }: {
  city: FleetCity | null; items: readonly string[]; slots: readonly FleetSlot[]; onSearchNow: (slug: string) => void; now?: number;
}) {
  const { t, locale } = useT();
  const [log, setLog] = useState<LogState>(null);
  const slug = city?.slug ?? null;
  useEffect(() => {
    if (!slug) { setLog(null); return; }
    let live = true;
    setLog(null);
    const read = () => fleetApi.cityLog({ city: slug, hours: LOG_HOURS })
      .then(tasks => { if (live) setLog(tasks); })
      .catch(() => { if (live) setLog('failed'); });
    read();
    const timer = setInterval(() => { if (!document.hidden) read(); }, 10_000);
    return () => { live = false; clearInterval(timer); };
  }, [slug]);
  if (!city) {
    return (
      <aside className="card fleet-log fleet-log-empty" aria-label={t('fleetCityLog')}>
        <div className="card-body fp-muted">{t('fleetCityLogPick')}</div>
      </aside>
    );
  }
  const home = homeWorkerOf(slots, city.slug);
  const groups = Array.isArray(log) ? logByItem(log, items) : [];
  const perDay = city.per_day ?? null;
  return (
    <aside className="card fleet-log" aria-label={t('fleetCityLog')}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{city.name}</h2>
          <span className="card-sub mono">{city.slug}</span>
        </div>
        <div className="fleet-actions">
          <button type="button" className="btn sm" onClick={() => onSearchNow(city.slug)} disabled={!city.enabled}>{t('fleetSearchNow')}</button>
          <a className="btn sm ghost" href={hrefFor(fleetTabPath('cities'))} onClick={onLinkClick(fleetTabPath('cities'))}>{t('fleetCityEdit')}</a>
        </div>
      </div>
      <div className="fleet-log-note">
        {home
          ? t('fleetLogHome', { worker: home.worker_id ?? '—', no: home.account_no })
          : t('fleetLogNoHome')}
        {city.region && <> {t('fleetLogRegion', { region: city.region })}</>}
        {' '}{perDay ? t('fleetLogPerDay', { n: perDay }) : t('fleetLogPerDayDefault')}
      </div>
      <div className="fleet-log-tasks">
        {log === null && <div className="card-body"><FormSkeleton fields={2} withHeader={false} /></div>}
        {log === 'failed' && <p className="fp-warn card-body">{t('fleetCityLogFailed')}</p>}
        {Array.isArray(log) && groups.every(g => g.tasks.length === 0) && <p className="fp-muted card-body">{t('fleetCityLogNone')}</p>}
        {groups.flatMap(g => g.tasks).map(task => (
          <div key={task.id} className="fleet-log-task">
            <div className="fleet-log-task-head">
              <span className="mono fleet-log-item">{task.item}</span>
              <StateChip task={task} now={now} />
            </div>
            <ul className="fleet-events">
              {task.state === 'ready' && (
                <li><span className="fleet-event-t">{easternClock(task.due_at, locale, now)}</span>
                  <span>{t(Date.parse(task.due_at) <= now ? 'fleetLogDueWaiting' : 'fleetLogNextSearch')}</span></li>
              )}
              {task.events.map(ev => (
                <li key={ev.id}>
                  <span className="fleet-event-t">{easternClock(ev.at, locale, now)}</span>
                  <span>
                    {t(EVENT_KEY[ev.kind] ?? ev.kind)}
                    {ev.kind === 'handed' && ev.worker_id && <> · <span className="mono">{ev.worker_id}</span></>}
                    {detailText(ev.detail) && <span className="fp-muted"> · {detailText(ev.detail)}</span>}
                  </span>
                </li>
              ))}
              {task.state === 'leased' && <li className="fleet-event-live"><span className="fleet-event-t">{t('fleetLogNow')}</span><span>{t('fleetLogRunning')}</span></li>}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

// Start the round now. The preview is worked out here from the same rule the
// backend applies, so the dialog says what will happen before it does; the
// answer's counts (started, skipped) go into the toast.
export function StartRoundDialog({ cities, items, freshHours, onClose, onDone, now = Date.now() }: {
  cities: readonly FleetCity[]; items: readonly string[]; freshHours: number; onClose: () => void; onDone: () => void; now?: number;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => roundStartPreview(cities, items, freshHours, now), [cities, items, freshHours, now]);
  const total = Object.values(preview).reduce((n, p) => n + p.due, 0);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { started, skipped } = await fleetApi.startRound();
      showSuccessToast(t(skipped ? 'fleetRoundStartedSkipped' : 'fleetRoundStarted', { n: started, skipped }));
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 500 }}>
      <div className="modal-head"><div><div className="modal-title">{t('fleetRoundStartTitle')}</div></div></div>
      <div className="modal-body ff-round-start">
        <p>{t('fleetRoundStartBody', { hours: freshHours })}</p>
        <ul className="ff-round-start-due">
          {items.map(item => {
            const p = preview[item];
            return <li key={item}><span className="mono">{item}</span> {t('fleetRoundStartItem', { due: p.due, ready: p.ready, skipped: p.skipped })}</li>;
          })}
        </ul>
        <p className="fp-muted">{t('fleetRoundStartNote')}</p>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button type="button" className="btn primary" onClick={confirm} disabled={busy || total === 0}>{t('fleetRoundStartConfirm', { n: total })}</button>
      </div>
    </Modal>
  );
}

// Search a city now: one manual task per chosen item, at the front of the
// queue. A pair a worker is searching right now answers 409 exists; that item
// is already being done, so only the other refusals count.
export function SearchNowDialog({ cities, items, tasks, initial, onClose, onDone, now = Date.now() }: {
  cities: readonly FleetCity[]; items: readonly string[]; tasks: readonly FleetTask[]; initial: string;
  onClose: () => void; onDone: () => void; now?: number;
}) {
  const { t, locale } = useT();
  const enabled = useMemo(() => cities.filter(c => c.enabled).sort((a, b) => a.name.localeCompare(b.name)), [cities]);
  const [slug, setSlug] = useState(initial || enabled[0]?.slug || '');
  const [item, setItem] = useState<string>(items.length === 1 ? items[0] : 'both');
  const [busy, setBusy] = useState(false);
  const city = enabled.find(c => c.slug === slug) ?? null;
  const chosen = item === 'both' ? items : [item];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!city || busy) return;
    setBusy(true);
    try {
      const out = await Promise.allSettled(chosen.map(i => fleetApi.searchNow(city.slug, i)));
      const failed = out.find((r): r is PromiseRejectedResult => r.status === 'rejected' && fleetErrorCode(r.reason) !== 'exists');
      if (failed) throw failed.reason;
      showSuccessToast(t('fleetSearchNowDone', { city: city.name }));
      onDone();
    } catch (err) {
      handleFetchError(err);
      setBusy(false);
    }
  };
  const hint = city && chosen.length === 1 ? (() => {
    const last = lastDoneSearch(tasks, city.slug, chosen[0]);
    const open = city.open_tasks.find(x => x.item === chosen[0] && x.kind === 'search');
    if (!last && !open) return t('fleetSearchNowNever', { city: city.name, item: chosen[0] });
    return t('fleetSearchNowLast', {
      city: city.name, item: chosen[0],
      last: last ? t('fleetSearchNowLastBy', { ago: agoLabel(t, last.done_at, now), by: last.worker_id ?? '—' }) : t('fleetSearchNowNeverShort'),
      next: open ? (open.state === 'leased' ? t('fleetSearchNowRunning', { by: open.worker_id ?? '—' }) : easternClock(open.due_at, locale, now)) : '—',
    });
  })() : null;
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 480 }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{t('fleetSearchCityNow')}</div>
            <div className="modal-sub">{t('fleetSearchNowSub')}</div>
          </div>
        </div>
        <div className="modal-body fleet-form">
          <label className="fleet-field">
            <span>{t('fleetColCity')}</span>
            <select className="input" value={slug} onChange={e => setSlug(e.target.value)} autoFocus>
              {enabled.map(c => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select>
          </label>
          <div className="fleet-field">
            <span>{t('fleetColItem')}</span>
            <div className="seg fleet-seg" role="group">
              {items.map(i => <button key={i} type="button" className={item === i ? 'active' : undefined} onClick={() => setItem(i)}>{i}</button>)}
              {items.length > 1 && <button type="button" className={item === 'both' ? 'active' : undefined} onClick={() => setItem('both')}>{t('fleetSearchNowBoth')}</button>}
            </div>
          </div>
          {hint && <p className="fp-muted">{hint}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !city}>{t('fleetSearchNow')}</button>
        </div>
      </form>
    </Modal>
  );
}
