import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fleetApi, type FleetAccountBrief } from '../../../lib/fleet';
import { DAY } from '../../../lib/facebookPool';
import { fmtDate } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { StatusChip } from '../accountPool/shared';
import { useFixedPopover } from '../popoverPlacement';
import { maskUid, type Translate } from './fleetBoard';
import type { FleetPoolAccount } from './fleetRows';
import { agoLabel } from './shared';

// ─── The Account cell's hover card ────────────────────────────────────────────
// What a manager needs to judge an account without leaving the table: when it
// was imported and its note, from the pool summary the tab already holds, and
// its last week of searches and its stints, fetched on the first hover.

const OPEN_DELAY_MS = 250;
// Long enough to cross the gap from the cell into the card.
const CLOSE_DELAY_MS = 150;
const FRESH_MS = 60_000;

type Load = { kind: 'loading' } | { kind: 'ok'; brief: FleetAccountBrief } | { kind: 'error' };

const cache = new Map<number, { at: number; brief: FleetAccountBrief }>();

function useBrief(no: number, open: boolean): Load {
  const [load, setLoad] = useState<Load>(() => {
    const hit = cache.get(no);
    return hit ? { kind: 'ok', brief: hit.brief } : { kind: 'loading' };
  });
  useEffect(() => {
    if (!open) return;
    const hit = cache.get(no);
    if (hit) setLoad({ kind: 'ok', brief: hit.brief });
    if (hit && Date.now() - hit.at < FRESH_MS) return;
    let cancelled = false;
    fleetApi.accountBrief(no)
      .then(brief => {
        cache.set(no, { at: Date.now(), brief });
        if (!cancelled) setLoad({ kind: 'ok', brief });
      })
      .catch(() => { if (!cancelled && !hit) setLoad({ kind: 'error' }); });
    return () => { cancelled = true; };
  }, [no, open]);
  return load;
}

export function AccountBriefCell({ no, uid, pool, children }: {
  no: number; uid: string | null; pool: FleetPoolAccount | null; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const anchor = useRef<HTMLSpanElement>(null);
  const later = (next: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = useCallback(() => { window.clearTimeout(timer.current); setOpen(false); }, []);

  return (
    <span ref={anchor} className="fleet-brief-anchor" tabIndex={0} aria-haspopup="dialog" aria-expanded={open}
      onMouseEnter={() => later(true, OPEN_DELAY_MS)} onMouseLeave={() => later(false, CLOSE_DELAY_MS)}
      onFocus={() => later(true, 0)} onBlur={() => later(false, CLOSE_DELAY_MS)}
      onKeyDown={e => { if (e.key === 'Escape') close(); }}>
      {children}
      {open && createPortal(
        <BriefPanel anchor={anchor} no={no} uid={uid} pool={pool} onClose={close}
          onEnter={() => window.clearTimeout(timer.current)} onLeave={() => later(false, CLOSE_DELAY_MS)} />,
        document.body,
      )}
    </span>
  );
}

function BriefPanel({ anchor, no, uid, pool, onClose, onEnter, onLeave }: {
  anchor: React.RefObject<HTMLSpanElement | null>; no: number; uid: string | null; pool: FleetPoolAccount | null;
  onClose: () => void; onEnter: () => void; onLeave: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const pos = useFixedPopover(anchor, panel, { align: 'left', gap: 6 }, onClose);
  const load = useBrief(no, true);
  return (
    <div ref={panel} role="dialog" className="fleet-brief" onMouseEnter={onEnter} onMouseLeave={onLeave}
      style={{
        top: pos?.top ?? 0, left: pos?.left ?? 0, maxHeight: pos?.maxHeight,
        visibility: pos && !pos.hidden ? 'visible' : 'hidden',
      }}>
      <AccountBriefCard no={no} uid={uid} pool={pool} load={load} />
    </div>
  );
}

/** The card's body, apart from the hover so a smoke test can render it. */
export function AccountBriefCard({ no, uid, pool, load, now = Date.now() }: {
  no: number; uid: string | null; pool: FleetPoolAccount | null; load: Load; now?: number;
}) {
  const { t, locale } = useT();
  return (
    <>
      <header>
        <strong>{t('fleetAccountNo', { no })}</strong>
        <span className="mono fp-muted">{maskUid(uid ?? pool?.uid)}</span>
        {pool && <StatusChip status={pool.status} />}
      </header>
      <dl>
        <dt>{t('fleetBriefImported')}</dt>
        <dd>{importedLabel(t, pool, locale, now)}</dd>
        {pool?.batch && <><dt>{t('fleetBriefBatch')}</dt><dd>{pool.batch}</dd></>}
        <dt>{t('fleetBriefNote')}</dt>
        <dd className="fleet-brief-note">{pool?.note ? pool.note : <span className="fp-muted">{t('fleetBriefNoNote')}</span>}</dd>
      </dl>
      {load.kind === 'loading' && <p className="fp-muted">{t('fleetBriefLoading')}</p>}
      {load.kind === 'error' && <p className="fp-warn">{t('fleetBriefFailed')}</p>}
      {load.kind === 'ok' && <BriefRecord brief={load.brief} now={now} />}
    </>
  );
}

function BriefRecord({ brief: b, now }: { brief: FleetAccountBrief; now: number }) {
  const { t } = useT();
  const stat = (n: number, key: string) => (
    <span><b>{n.toLocaleString()}</b> {t(key)}</span>
  );
  return (
    <dl>
      <dt>{t('fleetBriefOnWorker')}</dt>
      <dd>{b.on_worker
        ? t('fleetBriefOnWorkerSince', { worker: b.on_worker, since: agoLabel(t, b.on_worker_since, now) })
        : <span className="fp-muted">{t('fleetBriefNotOnWorker')}</span>}</dd>
      <dt>{t('fleetBriefLastDays', { n: b.days })}</dt>
      <dd>
        {b.searches === 0
          ? <span className="fp-muted">{t('fleetBriefNoSearches')}</span>
          : <span className="fleet-brief-stats">
              {stat(b.searches, 'fleetBriefSearches')}
              {stat(b.cards, 'fleetBriefCards')}
              {stat(b.opened, 'fleetBriefOpened')}
              {stat(b.alerted, 'fleetBriefAlerts')}
              {stat(Math.round(b.seconds / 60), 'fleetBriefMinutes')}
            </span>}
      </dd>
      <dt>{t('fleetBriefLastSearch')}</dt>
      <dd>{agoLabel(t, b.last_search_at, now)}</dd>
      <dt>{t('fleetBriefStints')}</dt>
      <dd className={b.problems + b.retired > 0 ? 'fp-warn' : undefined}>
        {t('fleetBriefStintsValue', { n: b.stints, problems: b.problems, retired: b.retired })}
      </dd>
    </dl>
  );
}

function importedLabel(t: Translate, pool: FleetPoolAccount | null, locale: string, now: number): ReactNode {
  if (!pool?.addedAt) return <span className="fp-muted">—</span>;
  const days = Math.max(0, Math.floor((now - pool.addedAt) / DAY));
  return t('fleetBriefImportedAt', { date: fmtDate(new Date(pool.addedAt), locale), n: days });
}
