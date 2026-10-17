import { useState, type ReactNode } from 'react';
import type { FbPoolSecretField } from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import type { FleetAccount } from '../../lib/coordinator';
import { showSuccessToast, showWarnToast } from '../../lib/errorToast';
import { poolApi, poolTotp, type PoolAccount } from '../../lib/facebookPool';
import { whoIs } from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { hrefFor, onLinkClick } from '../../lib/route';
import { PoolCode } from './accountPool/shared';
import { BuildChip, fmtDays, stateLabel } from './FleetAccounts';
import '../../styles/facebookPool.css';

// ─── The sign-in panel beside a worker's live browser ─────────────────────────
// What a manager needs to clear a login checkpoint without leaving the viewer:
// the worker's pool login and its live 2FA code, then the worker's own facts.
//
// Clipboard text does not reach the VNC session, so login, password and code
// can also be typed into the remote browser as keystrokes. noVNC drops keys
// while view-only, which is why typing waits for Take control.
//
// Secrets come from the Account pool, not the fleet vault: the vault only says
// which secrets it holds. Reveals live in state and die with the page.

type Field = 'login' | 'password' | 'uid' | 'emailPassword' | 'recovery';
type Secret = Extract<FbPoolSecretField, 'password' | 'totp' | 'emailPassword'>;

const LABELS: Record<Field, string> = {
  login: 'fbcWatchAcctLogin',
  password: 'fpPassword',
  uid: 'fpUid',
  emailPassword: 'fpEmailPassword',
  recovery: 'fpRecovery',
};

export type PoolLookup =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ok'; account: PoolAccount | null };

type Props = {
  worker: FleetAccount | null | undefined;
  coordinatorVersion: string | null;
  pool: PoolLookup;
  canType: boolean;
  onType: (text: string) => boolean;
};

export function FleetWatchAccount({ worker, coordinatorVersion, pool, canType, onType }: Props) {
  const { t, locale } = useT();
  const [revealed, setRevealed] = useState<ReadonlySet<Field>>(new Set());
  const a = pool.kind === 'ok' ? pool.account : null;
  const h = worker?.health ?? null;
  const who = worker ? whoIs(worker) : null;
  const asking = h?.state === 'CHALLENGE_2FA';

  const audit = (kind: 'copied' | 'revealed', field: Secret) => {
    if (a) void poolApi.event(a.no, kind, field).catch(() => undefined);
  };
  const valueOf = (acct: PoolAccount, field: Field) =>
    field === 'login' ? acct.email || acct.uid : acct[field];
  const secretOf = (field: Field | 'totp'): Secret | null =>
    field === 'password' || field === 'emailPassword' || field === 'totp' ? field : null;

  // A key that decodes but yields no code means crypto.subtle is missing,
  // which is an http page; say so rather than act on nothing in silence.
  const resolve = async (field: Field | 'totp'): Promise<string | null> => {
    if (!a) return null;
    if (field !== 'totp') return valueOf(a, field) || null;
    const code = await poolTotp(a.totp);
    if (!code && a.totp) showWarnToast(t('fpCodeUnavailable'));
    return code;
  };
  const label = (field: Field | 'totp') => t(field === 'totp' ? 'fpCode' : LABELS[field]);

  const copy = async (field: Field | 'totp') => {
    const value = await resolve(field);
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showSuccessToast(t('fpCopied', { field: label(field) }));
      const secret = secretOf(field);
      if (secret) audit('copied', secret);
    } catch {
      showWarnToast(t('fpCopyFailed'));
    }
  };
  const type = async (field: Field | 'totp') => {
    const value = await resolve(field);
    if (!value || !onType(value)) return;
    showSuccessToast(t('fbcWatchAcctTyped', { field: label(field) }));
    // The ledger knows only copied and revealed; a typed secret left the
    // page just as a copied one does.
    const secret = secretOf(field);
    if (secret) audit('copied', secret);
  };
  const toggleReveal = (field: Field) => {
    const shown = revealed.has(field);
    setRevealed(prev => {
      const next = new Set(prev);
      if (shown) next.delete(field); else next.add(field);
      return next;
    });
    const secret = secretOf(field);
    if (!shown && secret) audit('revealed', secret);
  };

  const typeHint = canType ? undefined : t('fbcWatchAcctTypeHint');
  const typeButton = (field: Field | 'totp') => (
    <button type="button" className="btn ghost icon sm" disabled={!canType}
      aria-label={t('fbcWatchAcctTypeField', { field: label(field) })}
      title={typeHint ?? t('fbcWatchAcctTypeField', { field: label(field) })}
      onClick={() => void type(field)}>
      <Icon name="keyboard" size={14} />
    </button>
  );
  const copyButton = (field: Field | 'totp') => (
    <button type="button" className="btn ghost icon sm"
      aria-label={t('fpCopy', { field: label(field) })} title={t('fpCopy', { field: label(field) })}
      onClick={() => void copy(field)}>
      <Icon name="copy" size={13} />
    </button>
  );

  const fieldRow = (acct: PoolAccount, field: Field, typeable: boolean) => {
    const value = valueOf(acct, field);
    if (!value && field !== 'password') return null;
    const masked = (field === 'password' || field === 'emailPassword') && !revealed.has(field);
    return (
      <div key={field}>
        <dt>{t(LABELS[field])}</dt>
        <dd title={masked ? undefined : value}>
          {masked && value ? <span className="fp-masked">••••••••••</span> : <span className="mono">{value || '—'}</span>}
        </dd>
        {value && (
          <span className="fp-row">
            {(field === 'password' || field === 'emailPassword') && (
              <button type="button" className="btn ghost icon sm"
                aria-label={t(masked ? 'fpShow' : 'fpHide', { field: t(LABELS[field]) })}
                onClick={() => toggleReveal(field)}>
                <Icon name={masked ? 'eye' : 'eyeOff'} size={14} />
              </button>
            )}
            {typeable && typeButton(field)}
            {copyButton(field)}
          </span>
        )}
      </div>
    );
  };

  const fact = (key: string, text: string, value: ReactNode) => (
    <div key={key}><dt>{text}</dt><dd>{value}</dd></div>
  );
  const muted = (text: string) => <span className="fp-muted">{text}</span>;
  const profileId = who?.userId ?? (a && /^\d+$/.test(a.uid) ? a.uid : null);

  return (
    <aside className="fl-wa" aria-label={t('fbcWatchAcctTitle')}>
      <header className="fl-wa-head">
        <span>{t('fbcWatchAcctTitle')}</span>
        {a && <a className="fl-wa-pool" href={hrefFor('/fleet/pool')} onClick={onLinkClick('/fleet/pool')}>
          {t('fbcWatchAcctFromPool', { n: a.no })}
        </a>}
      </header>

      {pool.kind === 'loading' ? (
        <p className="fl-wa-empty">{t('fbcWatchAcctLoading')}</p>
      ) : !a ? (
        <div className="fl-wa-empty">
          <p>{t(pool.kind === 'unavailable' ? 'fbcWatchAcctPoolDown' : 'fbcWatchAcctNotInPool')}</p>
          <dl className="fp-fields fl-wa-facts">
            {fact('login', t('fbcWatchAcctLogin'), who?.login ? <span className="mono">{who.login}</span> : muted(t('fbcNotInVault')))}
            {fact('secrets', t('fbcDetailSecrets'), (() => {
              const stored = Object.entries(worker?.account?.secrets ?? {}).filter(([, on]) => on).map(([k]) => k);
              return stored.length ? stored.join(', ') : muted(t('fbcNone'));
            })())}
          </dl>
          {pool.kind === 'ok' && (
            <a className="btn sm" href={hrefFor('/fleet/pool')} onClick={onLinkClick('/fleet/pool')}>
              <Icon name="key" size={13} />{t('fbcWatchAcctOpenPool')}
            </a>
          )}
        </div>
      ) : (
        <>
          <section className={`fl-wa-code${asking ? ' is-asking' : ''}`} aria-live={asking ? 'polite' : undefined}>
            <div className="fl-wa-code-label">
              {asking ? <><Icon name="alert" size={13} />{t('fbcWatchAcctAsking')}</> : t('fpCode')}
            </div>
            {a.totp ? (
              <>
                <button type="button" className="fl-wa-code-value" title={t('fbcWatchAcctTapCopy')}
                  aria-label={t('fpCopy', { field: t('fpCode') })} onClick={() => void copy('totp')}>
                  <PoolCode secret={a.totp} large />
                </button>
                <div className="fl-wa-code-actions">
                  <button type="button" className="btn sm" onClick={() => void copy('totp')}>
                    <Icon name="copy" size={13} />{t('fbcWatchAcctCopy')}
                  </button>
                  <button type="button" className="btn sm primary" disabled={!canType} title={typeHint}
                    onClick={() => void type('totp')}>
                    <Icon name="keyboard" size={14} />{t('fbcWatchAcctType')}
                  </button>
                </div>
                {!canType && <small className="fl-wa-hint">{t('fbcWatchAcctTypeHint')}</small>}
              </>
            ) : (
              <div className="fl-wa-nokey">{t('fpNoKey')}</div>
            )}
          </section>
          <dl className="fp-fields">
            {fieldRow(a, 'login', true)}
            {fieldRow(a, 'password', true)}
            {a.email && fieldRow(a, 'uid', false)}
            {fieldRow(a, 'emailPassword', false)}
            {fieldRow(a, 'recovery', false)}
            {profileId && fact('profile', t('fbcDetailFbUser'),
              <a className="mono" href={`https://www.facebook.com/profile.php?id=${encodeURIComponent(profileId)}`}
                target="_blank" rel="noopener">{profileId}</a>)}
            {a.note && fact('note', t('fpNotes'), <span className="fp-muted">{a.note}</span>)}
          </dl>
        </>
      )}

      {worker && (
        <>
          <header className="fl-wa-head fl-wa-sub"><span>{t('fbcWatchAcctWorker')}</span></header>
          <dl className="fp-fields fl-wa-facts">
            {fact('state', t('fbcWatchAcctState'), h?.state ? stateLabel(t, h.state) : muted('—'))}
            {fact('region', t('fbcWatchAcctRegion'), worker.region.name)}
            {fact('session', t('fbcColSession'), h?.session_expiry
              ? <span title={h.session_expiry}>{fmtDays(t, h.session_days_left)}</span> : muted('—'))}
            {fact('heartbeat', t('fbcWatchAcctHeartbeat'), h?.last_heartbeat_at
              ? <span title={h.last_heartbeat_at}>{relTime(h.last_heartbeat_at, locale)}</span> : muted(t('fbcNever')))}
            {fact('proxy', t('fbcDetailProxy'), worker.proxy_env ? <span className="mono">${worker.proxy_env}</span> : muted(t('fbcOwnIp')))}
            {fact('build', t('fbcColBuild'), <BuildChip health={h} coordinatorVersion={coordinatorVersion} />)}
          </dl>
        </>
      )}
    </aside>
  );
}
