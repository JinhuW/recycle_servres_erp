import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { coordinatorApi, type FleetAccount, type FleetCity, type WorkerState } from '../../lib/coordinator';
import { ApiError } from '../../lib/api';
import { handleFetchError, showSuccessToast, showWarnToast } from '../../lib/errorToast';
import {
  PREVIOUS_FATES, cookieHealth, heldByWorker, installCandidates, poolApi,
  type PoolAccount, type PreviousFate,
} from '../../lib/facebookPool';
import {
  isUnstampedBuild, reloginIsAutomatic, searchesPerDay, splitHighlights, vaultAccountIdFor,
  type AccountLiveness, type CityHits,
} from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import type { Translate } from '../../lib/orderPresentation';
import { fleetWatchPath, hrefFor, onLinkClick } from '../../lib/route';

// ─── Fleet building blocks ────────────────────────────────────────────────────
// The pieces the fleet list (FleetWorkers.tsx), the worker page
// (FleetWorker.tsx) and the viewer share: highlighted text, state and
// liveness chips, a city chip with its alert count, the build chip, and the
// three actions the control plane can take today — watch the browser, queue a
// re-login, and assign the pool account Re-login signs in with.

export const HITS_DAYS = 7;

// A run of text with the search terms wrapped in <mark>.
export function Hi({ text, terms }: { text: string; terms: readonly string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {splitHighlights(text, terms).map((run, i) =>
        run.hit ? <mark key={i}>{run.text}</mark> : <span key={i}>{run.text}</span>)}
    </>
  );
}

export const LIVENESS_CHIP: Record<AccountLiveness, { chip: string; key: string }> = {
  live: { chip: 'chip pos', key: 'fbcLive' },
  stale: { chip: 'chip warn', key: 'fbcStale' },
  dead: { chip: 'chip neg', key: 'fbcDead' },
  unknown: { chip: 'chip muted', key: 'fbcNeverReported' },
  none: { chip: 'chip muted', key: 'fbcNotDeployed' },
};

export const STATE_CHIP: Record<WorkerState, string> = {
  HEALTHY: 'chip pos',
  DEGRADED: 'chip warn',
  SESSION_EXPIRED: 'chip warn',
  CHALLENGE_2FA: 'chip accent',
  CHALLENGE_EMAIL: 'chip accent',
  CHALLENGE_CAPTCHA: 'chip accent',
  CHECKPOINT: 'chip accent',
  DEAD: 'chip neg',
};

// The control plane can add states faster than this UI ships, so an unknown
// one falls back to its raw name rather than a blank cell.
export function stateLabel(t: Translate, state: WorkerState | string): string {
  const key = `fbcState_${state}`;
  const label = t(key);
  return label === key ? state : label;
}

export function fmtDays(t: Translate, days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return t('fbcSessionExpired');
  if (days < 1) return t('fbcHoursLeft', { n: Math.round(days * 24) });
  return t('fbcSessionDays', { n: Math.round(days) });
}

// ─── Watch & re-login ─────────────────────────────────────────────────────────
// "Watch" opens the ERP's own viewer for a worker's browser (FleetWatch.tsx),
// relayed through the backend — so it appears only for a worker the facade
// can bridge to. An in-app link: ⌘/ctrl-click opens it in its own tab.

export function WatchButton({ workerId, className = 'btn sm' }: { workerId: string; className?: string }) {
  const { t } = useT();
  const path = fleetWatchPath(workerId);
  return (
    <a className={className} href={hrefFor(path)} onClick={onLinkClick(path)} title={t('fbcWatchHint')}>
      <Icon name="eye" size={13} />
      {t('fbcWatchBrowser')}
    </a>
  );
}

// Queues a Facebook re-login for one worker, after a confirm that says what it
// will do: the worker re-enters its username, password and 2FA code from the
// vault on its next cycle.
export function ReloginButton({ workerId, account, onQueued, className = 'btn sm' }: {
  workerId: string;
  // The worker's fleet row, to say up front whether the login can finish by
  // itself. Unknown (undefined) reads as "not automatic", the safe claim.
  account?: FleetAccount | null;
  onQueued?: () => void;
  className?: string;
}) {
  const { t } = useT();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);

  const confirm = () => {
    setBusy(true);
    coordinatorApi.relogin(workerId)
      .then(() => {
        setAsking(false);
        setQueued(true);
        showSuccessToast(t('fbcReloginQueued', { id: workerId }));
        onQueued?.();
        setTimeout(() => setQueued(false), 4000);
      })
      .catch(handleFetchError)
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button type="button" className={className} disabled={busy || queued}
        title={t('fbcReloginHint')}
        onClick={e => { e.stopPropagation(); setAsking(true); }}>
        <Icon name="refresh" size={13} />
        {queued ? t('fbcReloginDone') : t('fbcRelogin')}
      </button>
      {asking && (
        <Modal onClose={() => { if (!busy) setAsking(false); }} shellStyle={{ maxWidth: 440 }}>
          <div className="modal-head">
            <div>
              <div className="modal-title">{t('fbcReloginTitle', { id: workerId })}</div>
            </div>
          </div>
          <div className="modal-body">
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-muted)' }}>
              {reloginIsAutomatic(account) ? t('fbcReloginBody') : t('fbcReloginManualBody')}
            </p>
            {!reloginIsAutomatic(account) && (
              <div className="card-note" style={{ marginTop: 12, padding: '10px 12px' }}>
                <Icon name="info" size={16} />
                <span>{t('fbcReloginManualNote', { id: workerId })}</span>
              </div>
            )}
          </div>
          <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" disabled={busy} onClick={() => setAsking(false)}>{t('cancel')}</button>
            <button type="button" className="btn primary" disabled={busy} onClick={confirm}>{t('fbcRelogin')}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ─── Assign account ───────────────────────────────────────────────────────────
// What a worker signs in with comes from the account pool: the manager picks a
// spare and the backend writes its login into the worker's vault, marks it
// Fleet and queues Re-login (`/api/facebook-pool/:no/assign`). Nothing is typed
// here, so the pool and the vault can't drift. A worker that already holds a
// pool account needs a decision about where that one goes — there is no
// default, because "it broke" and "we're rotating" end in different places.

export function EditCredentialsButton({ account, onSaved, className = 'btn sm' }: {
  account: FleetAccount;
  onSaved?: () => void;
  className?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} title={t('fbcEditCredsHint')}
        onClick={e => { e.stopPropagation(); setOpen(true); }}>
        <Icon name="edit" size={13} />
        {t('fbcEditCreds')}
      </button>
      {open && (
        <EditCredentialsModal account={account} onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onSaved?.(); }} />
      )}
    </>
  );
}

const FATE_KEYS: Record<PreviousFate, string> = {
  available: 'fbcCredFateAvailable',
  problem: 'fbcCredFateProblem',
  retired: 'fbcCredFateRetired',
};

const POOL_REFUSALS = new Set(['fpWorkerTaken', 'fpNoPassword', 'fpAssignRetired', 'fpAssignHeld']);
const COOKIE_PROBLEM = { missing: 'fpCookieMissing', mismatch: 'fpCookieMismatch', unknown: 'fpCookieUnknown' } as const;

function EditCredentialsModal({ account: w, onClose, onSaved }: {
  account: FleetAccount; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useT();
  const acct = w.account;
  const accountId = vaultAccountIdFor(w);
  const [pool, setPool] = useState<PoolAccount[] | null>(null);
  const [query, setQuery] = useState('');
  const [pick, setPick] = useState<number | null>(null);
  const [fate, setFate] = useState<PreviousFate | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => poolApi.snapshot().then(s => setPool(s.accounts));
  useEffect(() => {
    reload().catch(e => { handleFetchError(e); setPool([]); });
  }, []);

  const held = pool ? heldByWorker(pool, w.worker_id) : undefined;
  const candidates = pool ? installCandidates(pool, query) : [];
  const picked = candidates.find(a => a.no === pick);
  const ready = !!picked && (!held || fate !== null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ready || !picked) return;
    setBusy(true);
    poolApi.assign(picked.no, w.worker_id, acct ? accountId : undefined, held ? fate ?? undefined : undefined)
      .then(() => {
        showSuccessToast(t('fpAssignedToast', { n: picked.no, id: w.worker_id }));
        onSaved();
      })
      .catch(err => {
        // The pool moved under the dialog: say why and show it as it is now,
        // so the question about the worker's current account can appear.
        const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
        if (err instanceof ApiError && err.status === 409 && code && POOL_REFUSALS.has(code)) {
          showWarnToast(t(code));
          setPick(null);
          void reload().catch(() => undefined);
        } else handleFetchError(err);
      })
      .finally(() => setBusy(false));
  };

  const current = held
    ? `#${held.no} · ${held.email || held.uid}`
    : acct?.fb_username ? t('fbcCredNotFromPool', { login: acct.fb_username }) : t('fbcCredNone');

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 640 }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{t('fbcCredTitle', { id: w.worker_id })}</div>
          </div>
        </div>
        <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-muted)' }}>{t('fbcCredIntro')}</p>
          <div style={{ fontSize: 13.5 }}>
            <span className="muted">{t('fbcCredCurrent')}</span> {current}
          </div>
          {!acct && (
            <div className="card-note" style={{ padding: '10px 12px' }}>
              <Icon name="info" size={16} />
              <span>{t('fbcCredNewAccount', { id: accountId })}</span>
            </div>
          )}
          <input type="search" className="input" value={query} placeholder={t('fbcCredSearch')}
            onChange={e => setQuery(e.target.value)} />
          <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            {pool === null ? (
              <div className="muted" style={{ padding: 12, fontSize: 13 }}>{t('fbcCredLoading')}</div>
            ) : candidates.length === 0 ? (
              <div className="muted" style={{ padding: 12, fontSize: 13 }}>{t('fbcCredNoSpares')}</div>
            ) : (
              <table className="table" style={{ width: '100%' }}>
                <tbody>
                  {candidates.map(a => {
                    const cookie = cookieHealth(a);
                    return (
                      <tr key={a.no} onClick={() => setPick(a.no)} style={{ cursor: 'pointer' }}>
                        <td style={{ width: 28 }}>
                          <input type="radio" name="pool-account" checked={pick === a.no}
                            onChange={() => setPick(a.no)} aria-label={`#${a.no}`} />
                        </td>
                        <td className="mono">#{a.no}</td>
                        <td>
                          <div>{a.email || a.uid}</div>
                          {a.email && <div className="mono muted" style={{ fontSize: 11.5 }}>{a.uid}</div>}
                        </td>
                        <td>
                          <span className={`chip ${a.totp ? 'pos' : 'muted'}`}>{a.totp ? '2FA' : t('fbcCredNo2fa')}</span>
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {cookie.kind === 'fresh' || cookie.kind === 'stale'
                            ? t('fbcCredCookieAge', { days: cookie.days })
                            : cookie.kind === 'none' ? t('fbcCredNoCookie') : t(COOKIE_PROBLEM[cookie.kind])}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>{a.batch}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {picked && held && (
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 6 }}>
              <legend style={{ fontSize: 13.5, marginBottom: 6 }}>
                {t('fbcCredFateQuestion', { n: held.no })}
              </legend>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {PREVIOUS_FATES.map(f => (
                  <label key={f} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}>
                    <input type="radio" name="previous-fate" checked={fate === f} onChange={() => setFate(f)} />
                    {t(FATE_KEYS[f])}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="card-note" style={{ padding: '10px 12px' }}>
            <Icon name="info" size={16} />
            <span>{t('fbcCredReloginNote')}</span>
          </div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !ready}>{t('fbcCredAssign')}</button>
        </div>
      </form>
    </Modal>
  );
}

// `runsPerDay` is the worker's `start_at` count: a busy city is marked with
// how many of those times it is searched, a once-a-day city is left plain.
export function CityChip({ city, hits, terms, tone, runsPerDay }: {
  city: FleetCity; hits: Map<string, CityHits>; terms: readonly string[]; tone: 'accent' | 'muted';
  runsPerDay?: number | null;
}) {
  const { t } = useT();
  const hit = hits.get(city.slug);
  const times = searchesPerDay(city, runsPerDay);
  const title = [
    city.slug,
    city.radius_km ? `${city.radius_km} km` : null,
    hit ? t('fbcCityHint', { sent: hit.sent, days: HITS_DAYS }) : null,
    times ? t(city.pin ? 'fbcCityTimesPinned' : 'fbcCityTimes', { n: times }) : null,
  ].filter(Boolean).join(' · ');
  return (
    <span className={`chip ${tone}`} title={title}>
      <span><Hi text={city.name} terms={terms} /></span>
      {times !== null && times > 1 && <span className="mono" style={{ fontSize: 10.5, opacity: 0.8 }}>{times}×</span>}
      {hit && hit.sent > 0 && <span className="n">{hit.sent}</span>}
    </span>
  );
}

// A worker's build next to the coordinator's: the same build is quiet, a
// different one is flagged, so a container left on an old image stands out.
export function BuildChip({ health, coordinatorVersion }: {
  health: FleetAccount['health']; coordinatorVersion: string | null;
}) {
  const { t } = useT();
  if (!health) return <span className="muted">—</span>;
  const v = health.version;
  if (!v) return <span className="chip muted" title={t('fbcBuildPreHint')}>{t('fbcBuildPre')}</span>;
  // Not a mismatch, just an image built without its identity — quiet, not amber.
  if (isUnstampedBuild(v)) {
    return <span className="chip muted" title={t('fbcBuildUnstampedHint')}>{t('fbcBuildUnstamped')}</span>;
  }
  const same = Boolean(coordinatorVersion && v.startsWith(coordinatorVersion));
  return (
    <span className={`chip ${same ? 'muted' : 'warn'} mono fl-build`}
      title={`${v} — ${same ? t('fbcBuildSame') : t('fbcBuildDiffers', { v: coordinatorVersion ?? '?' })}`}>
      {v}
    </span>
  );
}
