import { useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { coordinatorApi, type FleetAccount, type FleetCity, type WorkerState } from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import {
  isUnstampedBuild, reloginIsAutomatic, reloginWouldBeAutomatic, splitHighlights, vaultAccountIdFor,
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
// re-login, and set the credentials Re-login signs in with.

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

// ─── Edit credentials ─────────────────────────────────────────────────────────
// What a worker signs in with when Re-login runs, set from here instead of
// `rsc vault set-account` on the VM. Secrets are write-only end to end: the
// form shows whether one is stored and never its value; a box left blank keeps
// what is stored; "clear" sends an explicit null. Saving refreshes the fleet
// view, so the stored-secret badges and the Re-login dialog follow at once.

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

function EditCredentialsModal({ account: w, onClose, onSaved }: {
  account: FleetAccount; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useT();
  const acct = w.account;
  const accountId = vaultAccountIdFor(w);
  const passwordStored = Boolean(acct?.secrets.password);
  const totpStored = Boolean(acct?.secrets.totp_secret);
  const [login, setLogin] = useState(acct?.fb_username ?? '');
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [clearTotp, setClearTotp] = useState(false);
  const [allowPw, setAllowPw] = useState(acct?.allow_password_login ?? false);
  const [busy, setBusy] = useState(false);

  // What will be true once this form is saved, so the note below is a
  // promise the worker can keep.
  const passwordAfter = clearPassword ? false : (password.length > 0 || passwordStored);
  const automatic = reloginWouldBeAutomatic(allowPw, passwordAfter);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const secrets: Partial<Record<'password' | 'totp_secret', string | null>> = {};
    if (clearPassword) secrets.password = null;
    else if (password) secrets.password = password;
    if (clearTotp) secrets.totp_secret = null;
    else if (totp.trim()) secrets.totp_secret = totp.trim();
    setBusy(true);
    coordinatorApi.saveAccount(accountId, {
      worker_id: w.worker_id,
      fb_username: login.trim(),
      allow_password_login: allowPw,
      secrets,
    })
      .then(() => {
        showSuccessToast(t('fbcCredSaved', { id: w.worker_id }));
        onSaved();
      })
      .catch(handleFetchError)
      .finally(() => setBusy(false));
  };

  const field = (label: string, hint: string | undefined, control: ReactNode) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>{label}</span>
      {control}
      {hint && <span className="muted" style={{ fontSize: 11.5 }}>{hint}</span>}
    </label>
  );
  const secretBox = (
    value: string, setValue: (v: string) => void, stored: boolean,
    clear: boolean, setClear: (v: boolean) => void, autoComplete: string,
  ) => (
    <>
      <input type="password" className="input" value={value} autoComplete={autoComplete}
        placeholder={stored ? t('fbcCredStored') : t('fbcCredNotStored')}
        disabled={clear} onChange={e => setValue(e.target.value)} />
      {stored && (
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
          <input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)} />
          {t('fbcCredClear')}
        </label>
      )}
    </>
  );

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 480 }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{t('fbcCredTitle', { id: w.worker_id })}</div>
          </div>
        </div>
        <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-muted)' }}>{t('fbcCredIntro')}</p>
          {!acct && (
            <div className="card-note" style={{ padding: '10px 12px' }}>
              <Icon name="info" size={16} />
              <span>{t('fbcCredNewAccount', { id: accountId })}</span>
            </div>
          )}
          {field(t('fbcCredLogin'), t('fbcCredLoginHint'),
            <input type="text" className="input" value={login} autoComplete="off"
              onChange={e => setLogin(e.target.value)} />)}
          {field(t('fbcCredPassword'), undefined,
            secretBox(password, setPassword, passwordStored, clearPassword, setClearPassword, 'new-password'))}
          {field(t('fbcCredTotp'), t('fbcCredTotpHint'),
            secretBox(totp, setTotp, totpStored, clearTotp, setClearTotp, 'off'))}
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}>
              <input type="checkbox" checked={allowPw} onChange={e => setAllowPw(e.target.checked)} />
              {t('fbcCredAllowPw')}
            </span>
            <span className="muted" style={{ fontSize: 11.5 }}>{t('fbcCredAllowPwHint')}</span>
          </label>
          <div className="card-note" style={{ padding: '10px 12px' }}>
            <Icon name={automatic ? 'check' : 'info'} size={16} />
            <span>{automatic ? t('fbcCredWillBeAutomatic') : t('fbcCredWillBeManual')}</span>
          </div>
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{t('save')}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CityChip({ city, hits, terms, tone }: {
  city: FleetCity; hits: Map<string, CityHits>; terms: readonly string[]; tone: 'accent' | 'muted';
}) {
  const { t } = useT();
  const hit = hits.get(city.slug);
  const title = [
    city.slug,
    city.radius_km ? `${city.radius_km} km` : null,
    hit ? t('fbcCityHint', { sent: hit.sent, days: HITS_DAYS }) : null,
  ].filter(Boolean).join(' · ');
  return (
    <span className={`chip ${tone}`} title={title}>
      <span><Hi text={city.name} terms={terms} /></span>
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
