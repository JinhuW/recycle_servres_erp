import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { FormSkeleton, TableSkeleton } from '../../../components/Skeleton';
import {
  FLEET_TASK_STATES, fleetApi, type FleetCity, type FleetCityLogTask, type FleetItem, type FleetSettings, type FleetTask,
  type FleetTaskEvent, type FleetTaskState,
} from '../../../lib/fleet';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import {
  BOARD_ORDER, boardCells, countsSentence, dueLabel, EMPTY_TASK_FILTER, easternClock, filterTasks, roundStartPreview, sortTasks, withCityNames,
  type BoardCell, type BoardState, type TaskFilter, type Translate,
} from './fleetBoard';
import { Clock, EmptyRow, TabCard, UnavailableCard, useFleetPoll, WorkerLink } from './shared';

// ─── Queue ────────────────────────────────────────────────────────────────────
// What the fleet is working on. The board gives one mark per city per item,
// in the order the round runs, so "is today's work done?" is answered before
// a row is read; the task table under it lists the tasks themselves. A city's
// name opens its log: its tasks and each one's events. "Start the round now"
// makes every waiting task due at once, except where the city was searched in
// the last few hours.

const LOG_HOURS = 24;

const CELL_KEY: Record<BoardState, string> = {
  done: 'fleetCellDone', leased: 'fleetCellLeased', due: 'fleetCellDue', later: 'fleetCellLater', cancelled: 'fleetCellCancelled',
};
const KEY_LABEL: Record<BoardState, string> = {
  done: 'fleetKeyDone', leased: 'fleetKeyLeased', due: 'fleetKeyDue', later: 'fleetKeyLater', cancelled: 'fleetKeyCancelled',
};
const STATE_CHIP: Record<FleetTaskState, string> = {
  ready: 'chip muted', leased: 'chip info', done: 'chip pos', cancelled: 'chip muted', expired: 'chip warn',
};

type Data = { cities: FleetCity[]; items: FleetItem[]; tasks: FleetTask[]; settings: FleetSettings | null };

export function FleetQueueTab() {
  const { t } = useT();
  const { data, reload } = useFleetPoll<Data>(() => {
    const since = new Date(Date.now() - LOG_HOURS * 3_600_000).toISOString();
    return Promise.all([
      fleetApi.cities(), fleetApi.items(), fleetApi.tasks({ since }),
      // The settings only feed the round-start preview; the board stands without them.
      fleetApi.settings().catch(() => null),
    ]).then(([cities, items, tasks, settings]) => ({ cities, items, tasks: withCityNames(tasks, cities), settings }));
  });
  const [starting, setStarting] = useState(false);
  const [logOf, setLogOf] = useState<{ slug: string; name: string } | null>(null);
  const [filter, setFilter] = useState<TaskFilter>(EMPTY_TASK_FILTER);

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const items = data?.items.filter(i => i.enabled).map(i => i.name) ?? [];
  const freshHours = data?.settings?.start_fresh_hours ?? 2;

  return (
    <div className="fp-pool">
      <TabCard title={t('fleetQueueTitle')} className="ff-round fleet-board-card"
        sub={data ? t('fleetQueueSub', { n: data.cities.filter(c => c.enabled).length, items: items.length }) : ''}
        actions={
          <button type="button" className="btn sm primary" onClick={() => setStarting(true)} disabled={!data}>
            <Icon name="flash" size={13} />{t('fleetRoundStart')}
          </button>
        }>
        {data === null
          ? <div className="card-body"><FormSkeleton fields={2} withHeader={false} /></div>
          : <QueueBoard cities={data.cities} tasks={data.tasks} items={items} onCity={setLogOf} />}
      </TabCard>
      <TabCard title={t('fleetTasksTitle')} sub={t('fleetTasksSub', { hours: LOG_HOURS })} className="fleet-tasks-card">
        {data === null
          ? <TableSkeleton rows={6} cols={7} />
          : <TaskTable tasks={data.tasks} items={items} filter={filter} onFilter={setFilter} onCity={setLogOf} />}
      </TabCard>
      {starting && data && (
        <StartRoundDialog cities={data.cities} items={items} freshHours={freshHours}
          onClose={() => setStarting(false)} onDone={() => { setStarting(false); reload(); }} />
      )}
      {logOf && <CityLogDialog slug={logOf.slug} name={logOf.name} onClose={() => setLogOf(null)} />}
    </div>
  );
}

function cellTitle(t: Translate, c: BoardCell, locale: string, now: number): string {
  return t(CELL_KEY[c.state], { city: c.name, time: easternClock(c.at, locale, now), by: c.by ?? '—' });
}

export function QueueBoard({ cities, tasks, items, onCity, now = Date.now() }: {
  cities: readonly FleetCity[]; tasks: readonly FleetTask[]; items: readonly string[];
  onCity: (c: { slug: string; name: string }) => void; now?: number;
}) {
  const { t, locale } = useT();
  if (items.length === 0 || cities.length === 0) {
    return <div className="card-body"><p className="fp-muted">{t('fleetBoardNoCities')}</p></div>;
  }
  return (
    <div className="ff-round-body">
      {items.map(item => {
        const { cells, counts } = boardCells(cities, tasks, item, now);
        return (
          <div key={item} className="ff-round-item">
            <span className="mono ff-round-name">{item}</span>
            <div className="ff-round-board">
              <span className="ff-round-cells">
                {cells.map(c => (
                  <button key={c.slug} type="button" className={`fleet-cell fleet-cell-${c.state}`} title={cellTitle(t, c, locale, now)}
                    aria-label={cellTitle(t, c, locale, now)} onClick={() => onCity({ slug: c.slug, name: c.name })} />
                ))}
              </span>
            </div>
            <p className="ff-round-count">{countsSentence(t, counts)}</p>
          </div>
        );
      })}
      <ul className="ff-round-key" aria-hidden>
        {BOARD_ORDER.map(k => <li key={k}><i className={`fleet-cell fleet-cell-${k}`} />{t(KEY_LABEL[k])}</li>)}
      </ul>
    </div>
  );
}

export function TaskTable({ tasks, items, filter, onFilter, onCity, now = Date.now() }: {
  tasks: readonly FleetTask[]; items: readonly string[]; filter: TaskFilter; onFilter: (f: TaskFilter) => void;
  onCity: (c: { slug: string; name: string }) => void; now?: number;
}) {
  const { t } = useT();
  const rows = useMemo(() => sortTasks(filterTasks(tasks, filter)), [tasks, filter]);
  const set = (patch: Partial<TaskFilter>) => onFilter({ ...filter, ...patch });
  const filtered = filter !== EMPTY_TASK_FILTER && Object.values(filter).some(Boolean);
  return (
    <>
      <div className="fleet-filters">
        <select className="input" value={filter.state} aria-label={t('fleetColState')} onChange={e => set({ state: e.target.value })}>
          <option value="">{t('fleetFilterAnyState')}</option>
          {FLEET_TASK_STATES.map(s => <option key={s} value={s}>{t(`fleetState_${s}`)}</option>)}
        </select>
        <select className="input" value={filter.item} aria-label={t('fleetColItem')} onChange={e => set({ item: e.target.value })}>
          <option value="">{t('fleetFilterAnyItem')}</option>
          {items.map(i => <option key={i} value={i}>{i}</option>)}
        </select>
        <input className="input" value={filter.city} placeholder={t('fleetFilterCity')} aria-label={t('fleetFilterCity')}
          onChange={e => set({ city: e.target.value })} />
        <input className="input" value={filter.worker} placeholder={t('fleetFilterWorker')} aria-label={t('fleetFilterWorker')}
          onChange={e => set({ worker: e.target.value })} />
        {filtered && <button type="button" className="btn ghost sm" onClick={() => onFilter(EMPTY_TASK_FILTER)}>{t('fleetFilterClear')}</button>}
        <span className="fp-muted fleet-filters-count">{t('fleetTasksCount', { n: rows.length })}</span>
      </div>
      <div className="fp-table-wrap">
        <table className="fp-table fleet-table">
          <thead>
            <tr>
              <th>{t('fleetColCity')}</th>
              <th>{t('fleetColItem')}</th>
              <th>{t('fleetColState')}</th>
              <th>{t('fleetColDue')}</th>
              <th>{t('fleetColWorker')}</th>
              <th>{t('fleetColWhy')}</th>
              <th className="num">{t('fleetColResult')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <EmptyRow cols={7}>{t('fleetTasksNone')}</EmptyRow>}
            {rows.map(task => <TaskRow key={task.id} task={task} onCity={onCity} now={now} />)}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TaskRow({ task, onCity, now }: { task: FleetTask; onCity: (c: { slug: string; name: string }) => void; now: number }) {
  const { t } = useT();
  const name = task.city_name ?? task.city;
  const kind = task.kind !== 'search' ? <small className="mono">{t(`fleetKind_${task.kind}`)}</small> : null;
  return (
    <tr>
      <td>
        <span className="fp-holder">
          <button type="button" className="ff-round-city" onClick={() => onCity({ slug: task.city, name })} title={t('fleetCityLogOpen', { city: name })}>{name}</button>
          {kind}
        </span>
      </td>
      <td className="mono">{task.item}</td>
      <td>
        <span className="fp-holder">
          <span className={STATE_CHIP[task.state]}>{t(`fleetState_${task.state}`)}</span>
          {task.priority >= 100 && <small>{t('fleetTaskManual')}</small>}
        </span>
      </td>
      <td>
        <span className="fp-holder">
          <Clock at={task.state === 'done' ? task.done_at : task.state === 'leased' ? task.leased_at : task.due_at} now={now} />
          {task.state === 'ready' && <small>{dueLabel(t, task.due_at, now)}</small>}
          {task.state === 'leased' && task.lease_expires_at && <small>{t('fleetLeaseUntil', { time: dueLabel(t, task.lease_expires_at, now) })}</small>}
        </span>
      </td>
      <td><WorkerLink id={task.worker_id} /></td>
      <td className="fp-muted">{task.reason ? t(`fleetReason_${task.reason}`) : '—'}</td>
      <td className="num">{resultText(t, task)}</td>
    </tr>
  );
}

function resultText(t: Translate, task: FleetTask): string {
  const r = task.result;
  if (!r) return '—';
  const parts = [];
  if (r.cards !== undefined) parts.push(t('fleetResultCards', { n: r.cards }));
  if (r.alerted !== undefined) parts.push(t('fleetResultAlerted', { n: r.alerted }));
  if (r.seconds !== undefined) parts.push(t('fleetResultMinutes', { n: Math.round(r.seconds / 60) }));
  return parts.join(' · ') || '—';
}

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

// ─── The city log ─────────────────────────────────────────────────────────────

type LogState = FleetCityLogTask[] | 'failed' | null;

function CityLogDialog({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const { t } = useT();
  const [log, setLog] = useState<LogState>(null);
  useEffect(() => {
    let live = true;
    fleetApi.cityLog({ city: slug, hours: LOG_HOURS })
      .then(tasks => { if (live) setLog(tasks); })
      .catch(() => { if (live) setLog('failed'); });
    return () => { live = false; };
  }, [slug]);
  return (
    <Modal onClose={onClose} shellStyle={{ maxWidth: 920 }}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{t('fleetCityLogTitle', { city: name })}</div>
          <div className="modal-sub">{t('fleetCityLogSub', { hours: LOG_HOURS })}</div>
        </div>
      </div>
      <div className="modal-body">
        {log === null ? <FormSkeleton fields={2} withHeader={false} />
          : log === 'failed' ? <p className="fp-warn">{t('fleetCityLogFailed')}</p>
          : log.length === 0 ? <p className="fp-muted">{t('fleetCityLogNone')}</p>
          : <CityLogTable tasks={log} />}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>{t('close')}</button>
      </div>
    </Modal>
  );
}

const EVENT_DOT: Record<FleetTaskEvent['kind'], string> = {
  handed: 'ff-tl-muted', started: 'ff-live', searched: 'ff-live', finished: 'ff-live', done: 'ff-live',
  stopped: 'ff-attention', released: 'ff-attention', expired: 'ff-offline',
};

/** One row a task, newest first, and its events under it. */
export function CityLogTable({ tasks, now = Date.now() }: { tasks: readonly FleetCityLogTask[]; now?: number }) {
  const { t, locale } = useT();
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (id: number) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const rows = useMemo(() => sortTasks(tasks) as FleetCityLogTask[], [tasks]);
  return (
    <div className="fp-table-wrap">
      <table className="fp-table ff-citylog fleet-table">
        <thead>
          <tr>
            <th aria-label={t('fleetColEvents')} />
            <th>{t('fleetColTime')}</th>
            <th>{t('fleetColItem')}</th>
            <th>{t('fleetColState')}</th>
            <th>{t('fleetColWorker')}</th>
            <th>{t('fleetColWhy')}</th>
            <th className="num">{t('fleetColResult')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(task => {
            const isOpen = open.has(task.id);
            return (
              <Fragment key={task.id}>
                <tr className={isOpen ? 'ff-open ff-tl-toggle' : 'ff-tl-toggle'} onClick={() => toggle(task.id)}>
                  <td className="ff-chev">
                    <button type="button" className="btn ghost icon sm" aria-expanded={isOpen} aria-label={t('fleetColEvents')}
                      onClick={e => { e.stopPropagation(); toggle(task.id); }}>
                      <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={13} />
                    </button>
                  </td>
                  <td>
                    <span className="fp-holder">
                      <Clock at={task.leased_at ?? task.due_at} now={now} />
                      {task.done_at && <small>{t('fleetLogEnded', { time: easternClock(task.done_at, locale, now) })}</small>}
                    </span>
                  </td>
                  <td className="mono">{task.item}</td>
                  <td><span className={STATE_CHIP[task.state]}>{t(`fleetState_${task.state}`)}</span></td>
                  <td><WorkerLink id={task.worker_id} /></td>
                  <td className="fp-muted">{task.reason ? t(`fleetReason_${task.reason}`) : '—'}</td>
                  <td className="num">{resultText(t, task)}</td>
                </tr>
                {isOpen && (
                  <tr className="ff-tl-row">
                    <td colSpan={7}>
                      <div className="ff-timeline">
                        {task.events.length === 0 && <p className="fp-muted fleet-log-empty">{t('fleetLogNoEvents')}</p>}
                        <ul className="fp-log">
                          {task.events.map(ev => (
                            <li key={ev.id}>
                              <i className={`fp-dot ${EVENT_DOT[ev.kind] ?? 'ff-tl-muted'}`} />
                              <div>
                                <span>
                                  <b>{t(`fleetEvent_${ev.kind}`)}</b>
                                  {ev.worker_id && <span className="fp-muted"> · <span className="mono">{ev.worker_id}</span></span>}
                                  {ev.detail && Object.keys(ev.detail).length > 0 && (
                                    <span className="fp-muted"> · {detailText(ev.detail)}</span>
                                  )}
                                </span>
                                <time title={ev.at}>{easternClock(ev.at, locale, now)}</time>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// An event's detail is whatever the worker sent; it reads as "key value" pairs.
function detailText(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(', ');
}
