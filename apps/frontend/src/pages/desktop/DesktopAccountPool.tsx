import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import {
  buildAccountWrite, draftFrom, filterAccounts, isValidAccountId, isValidImapPort, mailboxNeedsPassword,
  type AccountDraft, type PoolSeg,
} from '../../lib/accountPool';
import { ApiError } from '../../lib/api';
import { coordinatorApi, SECRET_FIELDS, type PoolAccount, type SecretField } from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';

// ─── Account pool ─────────────────────────────────────────────────────────────
// Every Facebook account in the coordinator's vault, assigned to a worker or
// waiting in the pool, and the dialog that creates and edits them. Secrets are
// write-only: they are typed into the dialog, sent once, and live in nothing
// but its state, which closing it discards; the list only ever learns which
// ones are stored. Deleting an account, password-login release, the proxy and
// the VNC link stay on the fleet VM.

const SEGS: readonly PoolSeg[] = ['all', 'assigned', 'pool'];
const SEG_LABEL_KEY: Record<PoolSeg, string> = {
  all: 'apSegAll', assigned: 'apSegAssigned', pool: 'apSegPool',
};

const SECRET_LABEL_KEY: Record<SecretField, string> = {
  password: 'apSecret_password',
  email: 'apSecret_email',
  email_password: 'apSecret_email_password',
  totp_secret: 'apSecret_totp_secret',
  imap_host: 'apSecret_imap_host',
  imap_port: 'apSecret_imap_port',
};

// The port says nothing on its own once the host is shown.
const LISTED_SECRETS: readonly SecretField[] = ['password', 'email', 'email_password', 'totp_secret', 'imap_host'];

type Notice = 'notConfigured' | 'unsupported';

export function DesktopAccountPool() {
  const { t, locale } = useT();
  const [accounts, setAccounts] = useState<PoolAccount[] | null>(null);
  const [workerIds, setWorkerIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState('');
  const [seg, setSeg] = useState<PoolSeg>('all');
  const [editing, setEditing] = useState<PoolAccount | 'new' | null>(null);

  const load = useCallback(() => {
    coordinatorApi.listAccounts()
      .then(setAccounts)
      .catch(err => {
        // 501 = proxy env vars unset; 404 = a fleet console (or backend) that
        // predates the account routes. Neither is something to fix from here.
        if (err instanceof ApiError && err.status === 501) { setNotice('notConfigured'); return; }
        if (err instanceof ApiError && err.status === 404) { setNotice('unsupported'); return; }
        handleFetchError(err);
      });
  }, []);

  useEffect(() => {
    load();
    // Suggestions for the worker field only; it takes any id without them.
    coordinatorApi.listWorkers()
      .then(ws => setWorkerIds(ws.map(w => w.worker_id).sort()))
      .catch(() => setWorkerIds([]));
  }, [load]);

  const shown = useMemo(() => filterAccounts(accounts ?? [], query, seg), [accounts, query, seg]);
  const inPool = (accounts ?? []).filter(a => a.worker_id === null).length;

  if (notice) {
    return (
      <>
        <PageHead />
        <div className="card">
          <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--fg-muted)' }}>
            <Icon name="info" size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ maxWidth: '65ch' }}>
              {notice === 'notConfigured' ? t('fbcNotConfigured') : t('apUnsupported')}
            </span>
          </div>
        </div>
      </>
    );
  }

  const none = <span style={{ color: 'var(--fg-subtle)' }}>—</span>;

  return (
    <>
      <PageHead>
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={query} autoComplete="off"
            placeholder={t('apSearchPlaceholder')} aria-label={t('apSearchPlaceholder')}
            onChange={e => setQuery(e.target.value)} />
        </label>
        <div className="seg" role="tablist" aria-label={t('apAccountsTitle')}>
          {SEGS.map(s => (
            <button key={s} type="button" role="tab" aria-selected={seg === s}
              className={seg === s ? 'active' : ''}
              onClick={() => setSeg(s)}>
              {t(SEG_LABEL_KEY[s])}
            </button>
          ))}
        </div>
        <button type="button" className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} />
          {t('apNewAccount')}
        </button>
      </PageHead>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('apAccountsTitle')}</div>
            <div className="card-sub">
              {accounts
                ? t('apAccountsSub', { shown: shown.length, n: accounts.length, pool: inPool })
                : '…'}
            </div>
          </div>
        </div>
        <div className="card-note">
          <Icon name="lock" size={16} />
          <span>{t('apWriteOnlyNote')}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('apColAccount')}</th>
                <th>{t('apColLogin')}</th>
                <th>{t('apColWorker')}</th>
                <th>{t('apColRegion')}</th>
                <th>{t('apColSecrets')}</th>
                <th title={t('apVmNote')}>{t('apColPasswordLogin')}</th>
                <th>{t('apColUpdated')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map(a => (
                <tr key={a.account_id}>
                  <td className="mono">{a.account_id}</td>
                  <td>{a.fb_username ?? none}</td>
                  <td>
                    {a.worker_id
                      ? <span className="mono">{a.worker_id}</span>
                      : <span className="chip info" title={t('apPoolHint')}>{t('apPool')}</span>}
                  </td>
                  <td>{a.region ?? none}</td>
                  <td>
                    <span className="fl-cities">
                      {LISTED_SECRETS.map(f => (
                        <SecretChip key={f} label={t(SECRET_LABEL_KEY[f])} stored={a.secrets[f]} />
                      ))}
                    </span>
                  </td>
                  <td>
                    {a.allow_password_login
                      ? <span className="chip warn">{t('apOn')}</span>
                      : <span style={{ color: 'var(--fg-subtle)' }}>{t('apOff')}</span>}
                  </td>
                  <td title={a.updated_at ?? undefined} style={{ whiteSpace: 'nowrap' }}>
                    {a.updated_at ? relTime(a.updated_at, locale) : none}
                  </td>
                  <td>
                    <button type="button" className="btn sm" onClick={() => setEditing(a)}>
                      <Icon name="edit" size={13} />
                      {t('apEdit')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {accounts && shown.length === 0 && (
            <div className="fl-empty">{accounts.length ? t('apEmptySearch') : t('apEmpty')}</div>
          )}
        </div>
      </div>

      {editing && (
        <AccountModal
          account={editing === 'new' ? null : editing}
          workerIds={workerIds}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            showSuccessToast(t(editing === 'new' ? 'apCreated' : 'apSaved', { id: saved.account_id }));
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function PageHead({ children }: { children?: ReactNode }) {
  const { t } = useT();
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{t('apTitle')}</h1>
        <div className="page-sub">{t('apSubtitle')}</div>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

function SecretChip({ label, stored }: { label: string; stored: boolean }) {
  const { t } = useT();
  return stored
    ? <span className="chip pos" title={t('apStored')}><Icon name="check" size={11} />{label}</span>
    : <span className="chip muted" title={t('apNotSet')} style={{ opacity: 0.55 }}>{label}</span>;
}

function AccountModal({ account, workerIds, onClose, onSaved }: {
  account: PoolAccount | null;
  workerIds: readonly string[];
  onClose: () => void;
  onSaved: (saved: PoolAccount) => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState<AccountDraft>(() => draftFrom(account));
  const [saving, setSaving] = useState(false);

  const write = account ? buildAccountWrite(draft, account) : buildAccountWrite(draft, null);
  const accountId = draft.account_id.trim();
  const workerId = draft.worker_id.trim();
  const port = draft.secrets.imap_port.trim();
  const idInvalid = !account && accountId !== '' && !isValidAccountId(accountId);
  const workerInvalid = workerId !== '' && !isValidAccountId(workerId);
  const portInvalid = !draft.clear.imap_port && port !== '' && !isValidImapPort(port);
  const needsMailboxPassword = mailboxNeedsPassword(write);
  const workerChanged = account !== null && 'worker_id' in write;
  const blocked = (account ? Object.keys(write).length === 0 : accountId === '')
    || idInvalid || workerInvalid || portInvalid || needsMailboxPassword;

  // Busy dialogs keep Escape and swallow it here, so the key cannot fall
  // through to the page underneath.
  const close = () => { if (!saving) onClose(); };

  function setField(field: 'account_id' | 'fb_username' | 'worker_id' | 'region', value: string) {
    setDraft(d => ({ ...d, [field]: value }));
  }

  function setSecret(field: SecretField, value: string) {
    setDraft(d => ({ ...d, secrets: { ...d.secrets, [field]: value } }));
  }

  function setClear(field: SecretField, on: boolean) {
    setDraft(d => ({
      ...d,
      secrets: on ? { ...d.secrets, [field]: '' } : d.secrets,
      clear: { ...d.clear, [field]: on },
    }));
  }

  function save() {
    if (blocked || saving) return;
    setSaving(true);
    const request = account
      ? coordinatorApi.updateAccount(account.account_id, buildAccountWrite(draft, account))
      : coordinatorApi.createAccount(buildAccountWrite(draft, null));
    request.then(onSaved).catch(handleFetchError).finally(() => setSaving(false));
  }

  const title = account ? t('apEditTitle') : t('apNewTitle');

  return (
    <Modal onClose={close} ariaLabel={title} shellStyle={{ width: 640 }}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{title}</div>
          {account && <div className="modal-sub mono">{account.account_id}</div>}
        </div>
      </div>
      <div className="modal-body">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div className="field">
            <label className="label" htmlFor="ap-id">{t('apFieldId')}</label>
            <input id="ap-id" className="input mono" value={draft.account_id} autoComplete="off"
              disabled={account !== null} autoFocus={account === null}
              onChange={e => setField('account_id', e.target.value)} />
            <span className="help" style={idInvalid ? { color: 'var(--neg)' } : undefined}>
              {idInvalid ? t('apIdInvalid') : account ? t('apFieldIdFixed') : t('apFieldIdHelp')}
            </span>
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-login">{t('apFieldLogin')}</label>
            <input id="ap-login" className="input" value={draft.fb_username} autoComplete="off"
              autoFocus={account !== null}
              onChange={e => setField('fb_username', e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-worker">{t('apFieldWorker')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="ap-worker" className="input mono" list="ap-worker-ids" value={draft.worker_id}
                autoComplete="off" placeholder={t('apPool')} style={{ flex: 1, minWidth: 0 }}
                onChange={e => setField('worker_id', e.target.value)} />
              {workerId !== '' && (
                <button type="button" className="btn sm" onClick={() => setField('worker_id', '')}>
                  {t('apUnassign')}
                </button>
              )}
            </div>
            <datalist id="ap-worker-ids">
              {workerIds.map(id => <option key={id} value={id} />)}
            </datalist>
            {workerInvalid
              ? <span className="help" style={{ color: 'var(--neg)' }}>{t('apWorkerInvalid')}</span>
              : workerChanged
                ? <span className="help" style={{ color: 'var(--warn-strong)' }}>{t('apWorkerChangeNote')}</span>
                : <span className="help">{t('apFieldWorkerHelp')}</span>}
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-region">{t('apFieldRegion')}</label>
            <input id="ap-region" className="input" value={draft.region} autoComplete="off"
              onChange={e => setField('region', e.target.value)} />
          </div>
        </div>

        <div>
          <div className="card-title" style={{ fontSize: 13.5 }}>{t('apSecretsTitle')}</div>
          <div className="help" style={{ marginTop: 2 }}>
            {account ? t('apSecretsHelpEdit') : t('apSecretsHelpNew')}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {SECRET_FIELDS.map(f => {
            const stored = account?.secrets[f] ?? false;
            return (
              <div className="field" key={f}>
                <label className="label" htmlFor={`ap-secret-${f}`}>
                  {t(SECRET_LABEL_KEY[f])}
                  {account && (stored
                    ? <span className="chip pos">{t('apStored')}</span>
                    : <span className="chip muted">{t('apNotSet')}</span>)}
                </label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input id={`ap-secret-${f}`} className="input" type="password" autoComplete="new-password"
                    inputMode={f === 'imap_port' ? 'numeric' : undefined}
                    value={draft.secrets[f]} disabled={draft.clear[f]}
                    placeholder={stored ? t('apKeepPlaceholder') : undefined}
                    style={{ flex: 1, minWidth: 0 }}
                    onChange={e => setSecret(f, e.target.value)} />
                  {stored && (
                    <label className="fl-watch-toggle" title={t('apClearHint')}>
                      <input type="checkbox" checked={draft.clear[f]} onChange={e => setClear(f, e.target.checked)} />
                      <span>{t('apClear')}</span>
                    </label>
                  )}
                </div>
                {f === 'imap_port' && portInvalid && (
                  <span className="help" style={{ color: 'var(--neg)' }}>{t('apPortInvalid')}</span>
                )}
              </div>
            );
          })}
        </div>
        {needsMailboxPassword && (
          <div className="help" role="alert" style={{ color: 'var(--neg)', display: 'flex', gap: 6 }}>
            <Icon name="alert" size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{t('apMailboxNeedsPassword')}</span>
          </div>
        )}

        <div style={{
          display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px',
          border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-soft)',
          fontSize: 12.5, color: 'var(--fg-muted)',
        }}>
          <Icon name="info" size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>
              {t('apPasswordLogin')}{' '}
              {account?.allow_password_login
                ? <span className="chip warn">{t('apOn')}</span>
                : <span className="chip muted">{t('apOff')}</span>}
            </span>
            <span>{t('apVmNote')}</span>
            {account && <span>{t('apWorkerChangeNote')}</span>}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={close}>{t('cancel')}</button>
        <button type="button" className="btn primary" disabled={blocked || saving} onClick={save}>
          {account ? t('save') : t('apCreate')}
        </button>
      </div>
    </Modal>
  );
}
