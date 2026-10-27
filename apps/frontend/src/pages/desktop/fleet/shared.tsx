import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { ApiError } from '../../../lib/api';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { fleetApi, type FleetSlot } from '../../../lib/fleet';
import { fleetWorkerPath, hrefFor, onLinkClick } from '../../../lib/route';
import { useT } from '../../../lib/i18n';
import { budgetTone, easternClock, easternDateTime, liveness, spanLabel, type Liveness, type Translate } from './fleetBoard';

// ─── Shared by the fleet tabs ─────────────────────────────────────────────────

export const FLEET_POLL_MS = 10_000;
// The coordinator's answers are seconds to build and change slowly; the ERP's
// own tables stay on the 10 s clock.
export const COORDINATOR_POLL_MS = 30_000;

// null while loading; 'unavailable' when the backend has no fleet routes (a
// release that predates them answers 404) or the call failed. The tabs show
// their own empty state for it and never block the rest of the page.
export type Loaded<T> = T | 'unavailable' | null;

export type PollGate = { tick: () => void; reload: () => void };

/**
 * One read at a time. A tick while a read is in flight is dropped: a slow
 * upstream would otherwise stack a request per tick. A reload then is kept
 * and runs once the read lands, since it follows a write the page must show.
 */
export function pollGate(read: () => Promise<unknown>): PollGate {
  let busy = false;
  let again = false;
  const run = (): void => {
    if (busy) return;
    busy = true;
    read().catch(() => undefined).finally(() => {
      busy = false;
      if (again) {
        again = false;
        run();
      }
    });
  };
  return {
    tick: run,
    reload: () => {
      if (busy) again = true;
      else run();
    },
  };
}

/**
 * Reads `load` now and every 10 s while the tab is visible, and again the
 * moment it is shown, never while the previous read is still out. `reload`
 * re-reads after an action.
 */
export function useFleetPoll<T>(load: () => Promise<T>, ms: number = FLEET_POLL_MS): { data: Loaded<T>; reload: () => void } {
  const [data, setData] = useState<Loaded<T>>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);
  const gate = useMemo(() => pollGate(() => loadRef.current()
    .then(d => { if (alive.current) setData(d); })
    .catch(() => { if (alive.current) setData(prev => (prev === null || prev === 'unavailable' ? 'unavailable' : prev)); })), []);
  useEffect(() => {
    alive.current = true;
    gate.tick();
    const tick = () => { if (!document.hidden) gate.tick(); };
    const timer = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [gate, ms]);
  return { data, reload: gate.reload };
}

/** A fleet route that is not there yet: an older backend, or one without the tables. */
export const isNotServed = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 404 || err.status === 501 || err.status === 503);

export function UnavailableCard({ text }: { text: string }) {
  return (
    <div className="card">
      <div className="card-body fleet-unavailable">
        <Icon name="info" size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ maxWidth: '65ch' }}>{text}</span>
      </div>
    </div>
  );
}

export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return <tr><td colSpan={cols} className="fp-empty">{children}</td></tr>;
}

/** A timestamp as the office reads it, with the full date on hover. */
export function Clock({ at, now }: { at: string | null | undefined; now?: number }) {
  const { locale } = useT();
  if (!at) return <span className="fp-muted">—</span>;
  return <time dateTime={at} title={easternDateTime(at, locale)}>{easternClock(at, locale, now)}</time>;
}

const LIVENESS_CHIP: Record<Liveness, string> = { live: 'chip pos', stale: 'chip warn', dead: 'chip neg', never: 'chip muted' };
const LIVENESS_KEY: Record<Liveness, string> = {
  live: 'fleetSeenLive', stale: 'fleetSeenStale', dead: 'fleetSeenDead', never: 'fleetSeenNever',
};

export function SeenChip({ at, now }: { at: string | null | undefined; now?: number }) {
  const { t, locale } = useT();
  const lv = liveness(at, now);
  return (
    <span className={LIVENESS_CHIP[lv]} title={at ? easternDateTime(at, locale) : undefined}>
      {t(LIVENESS_KEY[lv])}{at && lv !== 'never' ? ` · ${easternClock(at, locale, now)}` : ''}
    </span>
  );
}

/** Minutes of searching against the day's budget: the Fleet tab's ring. With
 *  `unit` "searches" it counts a coordinator worker's searches of its plan. */
export function BudgetRing({ minutes, budget, unit = 'min' }: { minutes: number; budget: number; unit?: 'min' | 'searches' }) {
  const { t } = useT();
  const r = 8;
  const c = 2 * Math.PI * r;
  const frac = budget > 0 ? Math.min(minutes / budget, 1) : 0;
  const tone = budgetTone(minutes, budget);
  const title = unit === 'min' ? t('fleetBudgetOf', { minutes: Math.round(minutes), budget }) : t('fbcSearchesOf', { done: Math.round(minutes), budget });
  return (
    <span className={`ff-searches ff-ring-${tone}`} title={title}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <circle cx="11" cy="11" r={r} className="ff-ring-track" />
        {frac > 0 && (
          <circle cx="11" cy="11" r={r} className="ff-ring-fill"
            strokeDasharray={`${frac * c} ${c}`} transform="rotate(-90 11 11)" />
        )}
      </svg>
      <span className="mono"><b>{Math.round(minutes)}</b><span className="ff-ring-of">/{budget}{unit === 'min' ? ` ${t('fleetMin')}` : ''}</span></span>
    </span>
  );
}

/** "{span} ago" for a past instant, "in {span}" for a future one, or "—". */
export function agoLabel(t: Translate, at: string | null | undefined, now: number = Date.now()): string {
  if (!at) return '—';
  const diff = Math.round((now - Date.parse(at)) / 60_000);
  if (Number.isNaN(diff)) return '—';
  if (diff < 1 && diff > -1) return t('fleetJustNow');
  return diff > 0 ? t('fleetAgo', { span: spanLabel(t, diff) }) : t('fleetDueIn', { span: spanLabel(t, -diff) });
}

/** The status legend every tab's toolbar starts with: a button per bucket
 *  with its count, the pressed one the filter. */
export function Legend<K extends string>({ buckets, counts, value, onChange, label, dotClass }: {
  buckets: readonly K[]; counts: Record<K | 'all', number>; value: K | 'all'; onChange: (k: K | 'all') => void;
  label: (k: K | 'all') => string; dotClass: (k: K | 'all') => string;
}) {
  const all = ['all', ...buckets] as (K | 'all')[];
  return (
    <div className="fp-legend fleet-legend" role="group">
      {all.map(k => (
        <button key={k} type="button" className={`fp-legend-item ${dotClass(k)}`} aria-pressed={value === k}
          onClick={() => onChange(value === k && k !== 'all' ? 'all' : k)}>
          <i className="fp-dot" />
          <span>{label(k)}</span>
          <b>{counts[k]}</b>
        </button>
      ))}
    </div>
  );
}

/** A worker's reported state as a chip; an unknown state shows its raw name. */
const WORKER_STATE_CHIP: Record<string, string> = {
  HEALTHY: 'chip pos', DEGRADED: 'chip warn', SESSION_EXPIRED: 'chip neg', CHECKPOINT: 'chip neg',
  CHALLENGE_2FA: 'chip neg', CHALLENGE_EMAIL: 'chip neg', CHALLENGE_CAPTCHA: 'chip neg', DEAD: 'chip neg',
};
export function workerStateLabel(t: Translate, state: string): string {
  const key = `fbcState_${state}`;
  const label = t(key);
  return label === key ? state : label;
}
export function WorkerStateChip({ state }: { state: string }) {
  const { t } = useT();
  return <span className={WORKER_STATE_CHIP[state] ?? 'chip muted'}>{workerStateLabel(t, state)}</span>;
}

/** A worker id as a link to its page. */
export function WorkerLink({ id }: { id: string | null | undefined }) {
  if (!id) return <span className="fp-muted">—</span>;
  const path = fleetWorkerPath(id);
  return <a className="mono fleet-link" href={hrefFor(path)} onClick={onLinkClick(path)}>{id}</a>;
}

/** The chrome every tab shares: a card with a title, an optional sub line and
 *  actions on the right. */
export function TabCard({ title, sub, actions, children, className = '' }: {
  title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`card fleet-card ${className}`.trim()} aria-label={title}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{title}</h2>
          {sub !== undefined && <span className="card-sub">{sub}</span>}
        </div>
        {actions && <div className="fleet-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Confirm one destructive action; the body says what it does. */
export function ConfirmDialogBody({ title, body, confirm, busy, onClose, onConfirm, danger = false }: {
  title: string; body: ReactNode; confirm: string; busy: boolean; onClose: () => void; onConfirm: () => void; danger?: boolean;
}) {
  const { t } = useT();
  return (
    <>
      <div className="modal-head"><div><div className="modal-title">{title}</div></div></div>
      <div className="modal-body">{body}</div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button type="button" className={`btn primary${danger ? ' fleet-danger' : ''}`} onClick={onConfirm} disabled={busy}>{confirm}</button>
      </div>
    </>
  );
}

// Parking frees the account: its worker's next call is refused and the
// container exits, so a manager must mean it.
export function ParkDialog({ slot, onClose, onDone }: { slot: FleetSlot; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.parkSlot(slot.account_no);
      showSuccessToast(t('fleetParked', { no: slot.account_no }));
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetParkTitle', { no: slot.account_no })} confirm={t('fleetPark')} busy={busy} danger
        onClose={onClose} onConfirm={confirm}
        body={<>
          <p>{t('fleetParkBody', { worker: slot.worker_id ?? '—' })}</p>
          <p className="fp-warn">{t('fleetParkWarn')}</p>
        </>} />
    </Modal>
  );
}

// Unparking makes the account claimable again: the next worker that asks for
// a slot may take it, and that worker's start is a Facebook login.
export function UnparkDialog({ slot, onClose, onDone }: { slot: FleetSlot; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.unparkSlot(slot.account_no);
      showSuccessToast(t('fleetUnparked', { no: slot.account_no }));
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetUnparkTitle', { no: slot.account_no })} confirm={t('fleetUnpark')} busy={busy}
        onClose={onClose} onConfirm={confirm}
        body={<>
          <p>{t('fleetUnparkBody')}</p>
          <p className="fp-warn">{t('fleetUnparkWarn')}</p>
        </>} />
    </Modal>
  );
}

// Lifting a quarantine early lets the next worker that asks claim the account.
export function ReleaseQuarantineButton({ slot, onDone }: { slot: FleetSlot; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const release = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.releaseQuarantine(slot.account_no);
      showSuccessToast(t('fleetQuarantineReleased', { no: slot.account_no }));
      onDone();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn sm" onClick={release} disabled={busy} title={t('fleetQuarantineReleaseHint')}>
      {t('fleetQuarantineRelease')}
    </button>
  );
}
