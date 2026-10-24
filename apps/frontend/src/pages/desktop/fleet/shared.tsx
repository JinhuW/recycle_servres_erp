import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../../components/Icon';
import { ApiError } from '../../../lib/api';
import { fleetWorkerPath, hrefFor, onLinkClick } from '../../../lib/route';
import { useT } from '../../../lib/i18n';
import { budgetTone, easternClock, easternDateTime, liveness, type Liveness } from './fleetBoard';

// ─── Shared by the fleet tabs ─────────────────────────────────────────────────

export const FLEET_POLL_MS = 10_000;

// null while loading; 'unavailable' when the backend has no fleet routes (a
// release that predates them answers 404) or the call failed. The tabs show
// their own empty state for it and never block the rest of the page.
export type Loaded<T> = T | 'unavailable' | null;

/**
 * Reads `load` now and every 10 s while the tab is visible, and again the
 * moment it is shown. `reload` re-reads at once after an action.
 */
export function useFleetPoll<T>(load: () => Promise<T>, ms: number = FLEET_POLL_MS): { data: Loaded<T>; reload: () => void } {
  const [data, setData] = useState<Loaded<T>>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);
  const read = useCallback(() => {
    loadRef.current()
      .then(d => { if (alive.current) setData(d); })
      .catch(() => { if (alive.current) setData(prev => (prev === null || prev === 'unavailable' ? 'unavailable' : prev)); });
  }, []);
  useEffect(() => {
    alive.current = true;
    read();
    const tick = () => { if (!document.hidden) read(); };
    const timer = setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [read, ms]);
  return { data, reload: read };
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

/** Minutes of searching against the day's budget: the Fleet tab's ring. */
export function BudgetRing({ minutes, budget }: { minutes: number; budget: number }) {
  const { t } = useT();
  const r = 8;
  const c = 2 * Math.PI * r;
  const frac = budget > 0 ? Math.min(minutes / budget, 1) : 0;
  const tone = budgetTone(minutes, budget);
  return (
    <span className={`ff-searches ff-ring-${tone}`} title={t('fleetBudgetOf', { minutes: Math.round(minutes), budget })}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <circle cx="11" cy="11" r={r} className="ff-ring-track" />
        {frac > 0 && (
          <circle cx="11" cy="11" r={r} className="ff-ring-fill"
            strokeDasharray={`${frac * c} ${c}`} transform="rotate(-90 11 11)" />
        )}
      </svg>
      <span className="mono"><b>{Math.round(minutes)}</b><span className="ff-ring-of">/{budget} {t('fleetMin')}</span></span>
    </span>
  );
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
