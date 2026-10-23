import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { coordinatorApi, type FleetAccount, type FleetDoc, type QueueCityState } from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import { queueCityName, queueRound, queueSummary, type RoundCell } from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import type { Translate } from '../../lib/orderPresentation';
import '../../styles/facebookPool.css';

// ─── The city queue ───────────────────────────────────────────────────────────
// Enrolled workers ask the coordinator for each city instead of walking their
// own lists. Today's round opens the Fleet tab: one mark per city per item, in
// the order the round runs, so "is today's work done?" is answered before the
// worker list is read. The worker page says what one worker took and moves it
// in or out of the queue.

const CELL_TITLE: Record<QueueCityState, string> = {
  searched: 'fbcRoundCellSearched',
  leased: 'fbcRoundCellLeased',
  due: 'fbcRoundCellDue',
  later: 'fbcRoundCellLater',
  held: 'fbcRoundCellHeld',
};

const KEY_ORDER: readonly QueueCityState[] = ['searched', 'leased', 'due', 'later', 'held'];
const KEY_LABEL: Record<QueueCityState, string> = {
  searched: 'fbcRoundKeySearched',
  leased: 'fbcRoundKeyLeased',
  due: 'fbcRoundKeyDue',
  later: 'fbcRoundKeyLater',
  held: 'fbcRoundKeyHeld',
};

// A time today reads as a clock; any other day names the day too.
function when(at: string | null, locale: string): string {
  if (!at) return '';
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function cellTitle(t: Translate, c: RoundCell, locale: string): string {
  return t(CELL_TITLE[c.state], { city: c.name, time: when(c.at, locale), by: c.by ?? '—' });
}

function roundSentence(t: Translate, counts: ReturnType<typeof queueRound>['counts']): string {
  const { queue, searched, leased, due, later, held } = counts;
  const parts = [searched === queue && queue > 0
    ? t('fbcRoundDone', { n: queue })
    : t('fbcRoundCounts', { searched, queue })];
  if (searched !== queue || queue === 0) {
    if (leased) parts.push(t('fbcRoundLeased', { n: leased }));
    if (due) parts.push(t('fbcRoundDue', { n: due }));
    if (later) parts.push(t('fbcRoundLater', { n: later }));
  }
  const sentence = parts.join(', ') + '.';
  return held ? `${sentence} ${t('fbcRoundHeld', { n: held })}` : sentence;
}

export function RoundCard({ fleet, onSaved }: { fleet: FleetDoc | null; onSaved: () => void }) {
  const { t, locale } = useT();
  const [asking, setAsking] = useState(false);
  const queue = fleet?.queue;
  const summary = fleet ? queueSummary(fleet) : null;
  if (!fleet || !queue || !summary) return null;

  const items = Object.keys(queue.items);
  const outside = summary.workers - summary.pulling - summary.waiting;
  // Who pulls, who waits on a redeploy, who is outside: each worker counted once.
  const who = summary.everyone && summary.waiting === 0
    ? t('fbcRoundSubEveryone')
    : summary.pulling === 0 && summary.waiting === 0
      ? t('fbcRoundSubNone')
      : [
        summary.pulling ? t('fbcRoundPulling', { n: summary.pulling }) : t('fbcRoundPullingNone'),
        summary.waiting ? t('fbcRoundWaiting', { n: summary.waiting }) : '',
        outside ? t('fbcRoundOutside', { n: outside }) : '',
      ].filter(Boolean).join(' ');
  const s = queue.settings;
  const rules = t(s.per_day === null ? 'fbcRoundRulesTiers' : s.per_day === 1 ? 'fbcRoundRulesOnce' : 'fbcRoundRules', {
    n: s.per_day ?? 0,
    hours: Math.round((s.budget_minutes / 60) * 10) / 10,
    window: s.window_hours,
  });
  const queueCities = queue.cities.filter(c => items.some(i => c.items[i]?.state !== 'held'));

  return (
    <section className="card ff-round" aria-labelledby="ff-round-title">
      <div className="card-head">
        <h2 className="card-title" id="ff-round-title">{t('fbcRoundTitle')}</h2>
        <button type="button" className="btn sm" onClick={() => setAsking(true)}>
          {t(summary.everyone ? 'fbcQueueNoOne' : 'fbcQueueEveryone')}
        </button>
      </div>
      <div className="ff-round-body">
        <p className="ff-round-lede">
          {who}
          <span className="ff-round-rules"> {rules}</span>
        </p>
        {queue.cities.length === 0 || items.length === 0
          ? <p className="fp-muted">{t('fbcRoundNoRoster')}</p>
          : <>
            {items.map(item => {
              const { cells, counts } = queueRound(queue, item);
              const open = cells.filter(c => c.state !== 'held');
              const kept = cells.filter(c => c.state === 'held');
              return (
                <div key={item} className="ff-round-item">
                  <span className="mono ff-round-name">{item}</span>
                  <div className="ff-round-board" aria-hidden>
                    <span className="ff-round-cells">
                      {open.map(c => <i key={c.slug} className={`ff-round-${c.state}`} title={cellTitle(t, c, locale)} />)}
                    </span>
                    {/* Not part of the round: one mark for all of them, so the
                        board stays about the cities the queue is working. */}
                    {kept.length > 0 && (
                      <span className="ff-round-kept" title={t('fbcRoundHeld', { n: kept.length })}>
                        <i className="ff-round-held" />{kept.length}
                      </span>
                    )}
                  </div>
                  <p className="ff-round-count">{roundSentence(t, counts)}</p>
                </div>
              );
            })}
            <ul className="ff-round-key" aria-hidden>
              {KEY_ORDER.map(k => <li key={k}><i className={`ff-round-${k}`} />{t(KEY_LABEL[k])}</li>)}
            </ul>
            {queueCities.length > 0 && (
              <details className="ff-round-cities">
                <summary>{t('fbcRoundCities', { n: queueCities.length })}</summary>
                <div className="fp-table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>{t('fbcRoundColCity')}</th>{items.map(i => <th key={i} className="mono">{i}</th>)}</tr>
                    </thead>
                    <tbody>
                      {queueCities.map(c => (
                        <tr key={c.slug}>
                          <td>{c.name ?? c.slug}</td>
                          {items.map(i => {
                            const at = c.items[i];
                            return <td key={i} className={`ff-round-at ff-round-at-${at?.state ?? 'due'}`}>
                              {at ? t(`fbcRoundAt_${at.state}`, { time: when(at.at, locale), by: at.by ?? '—' }) : t('fbcRoundAt_due')}
                            </td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </>}
      </div>
      {asking && (
        <EveryoneModal everyone={summary.everyone} older={summary.older}
          onClose={() => setAsking(false)} onSaved={() => { setAsking(false); onSaved(); }} />
      )}
    </section>
  );
}

function EveryoneModal({ everyone, older, onClose, onSaved }: {
  everyone: boolean;
  older: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const joining = !everyone;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await coordinatorApi.setEveryoneQueue(joining);
      showSuccessToast(t(joining ? 'fbcQueueEveryoneDone' : 'fbcQueueNoOneDone'));
      onSaved();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 480 }}>
      <div className="modal-head">
        <div><div className="modal-title">{t(joining ? 'fbcQueueEveryoneTitle' : 'fbcQueueNoOneTitle')}</div></div>
      </div>
      <div className="modal-body">
        <p>{t(joining ? 'fbcQueueEveryoneBody' : 'fbcQueueNoOneBody')}</p>
        {joining && older > 0 && <p className="fp-warn">{t('fbcQueueEveryoneOlder', { n: older })}</p>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button type="button" className="btn primary" onClick={confirm} disabled={busy}>
          {t(joining ? 'fbcQueueEveryoneConfirm' : 'fbcQueueNoOneConfirm')}
        </button>
      </div>
    </Modal>
  );
}

// The chip after an enrolled worker's name in the list.
export function QueueChip({ worker: w }: { worker: FleetAccount }) {
  const { t } = useT();
  const q = w.queue;
  if (!q?.enrolled) return null;
  return q.capable
    ? <span className="chip accent" title={t('fbcQueueChipTitle')}>{t('fbcQueueChip')}</span>
    : <span className="chip warn" title={t('fbcQueueChipOldTitle', { version: q.version ?? t('fbcQueueUnknownVersion') })}>
      {t('fbcQueueChipOld')}
    </span>;
}

/** The worker page's "City queue" row. */
export function QueueField({ worker: w, fleet }: { worker: FleetAccount; fleet: FleetDoc }) {
  const { t } = useT();
  const q = w.queue;
  if (!q) return null;
  if (q.quarantined) {
    return <span><span className="chip warn">{t('fbcQueueQuarantined')}</span> {t('fbcQueueQuarantinedNote')}</span>;
  }
  if (!q.enrolled) {
    return <span className="fp-muted">
      {t(q.capable ? 'fbcQueueOut' : 'fbcQueueOutOld', { version: q.version ?? t('fbcQueueUnknownVersion') })}
    </span>;
  }
  if (!q.capable) {
    return <span className="fp-warn">{t('fbcQueueInOld', { version: q.version ?? t('fbcQueueUnknownVersion') })}</span>;
  }
  const now = q.open[0];
  return (
    <span>
      {t('fbcQueueIn', { minutes: q.minutes_today, budget: q.budget_minutes, n: q.handed_today })}
      {now && <> {t('fbcQueueNow', { city: queueCityName(fleet, now.city), item: now.item })}</>}
    </span>
  );
}

/** Move one worker into the queue, or back to its own list. */
export function QueueButton({ worker: w, onSaved }: { worker: FleetAccount; onSaved: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const q = w.queue;
  if (!q) return null;
  const joining = !q.enrolled;
  const blocked = joining && !q.capable;

  async function toggle() {
    if (busy || blocked) return;
    setBusy(true);
    try {
      await coordinatorApi.setWorkerQueue(w.worker_id, joining);
      showSuccessToast(t(joining ? 'fbcQueueJoined' : 'fbcQueueLeft', { id: w.worker_id }));
      onSaved();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn" onClick={toggle} disabled={busy || blocked}
      title={blocked ? t('fbcQueueJoinOld', { version: q.version ?? t('fbcQueueUnknownVersion') }) : undefined}>
      {t(joining ? 'fbcQueueJoin' : 'fbcQueueLeave')}
    </button>
  );
}
