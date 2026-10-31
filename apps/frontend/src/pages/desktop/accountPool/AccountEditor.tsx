import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import type { Challenge, FleetDoc } from '../../../lib/coordinator';
import {
  assignWorker,
  emptyPoolDraft,
  POOL_STATUSES,
  totpKey,
  validatePoolDraft,
  type PoolAccount,
  type PoolDraft,
  type PoolActivity,
} from '../../../lib/facebookPool';
import { fleetStatus, parkedWorkers, retiredAt, whoIs } from '../../../lib/fleetView';
import { relTime } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { StatusChip as WorkerStatusChip } from '../FleetWorkers';
import { CloseButton, CookieLabel, SessionSummary, STATUS_KEYS, StatusChip } from './shared';

export function AccountEditor({
  account,
  accounts,
  activity,
  fleet,
  challenges,
  onClose,
  onSave,
  onSendLogin,
  onRemove,
  onRetire,
}: {
  account: PoolAccount | null;
  accounts: PoolAccount[];
  activity: PoolActivity[];
  fleet: FleetDoc | null;
  challenges: Challenge[] | null;
  onClose: () => void;
  onSave: (draft: PoolDraft) => void;
  onSendLogin: (workerId: string) => void;
  onRemove: () => void;
  onRetire: () => void;
}) {
  const { t, locale } = useT();
  const [draft, setDraft] = useState<PoolDraft>(() =>
    account ? { ...account } : emptyPoolDraft(),
  );
  const [errors, setErrors] = useState<string[]>([]);
  // The errors sit atop a long drawer whose Save is at the foot; unseen, a
  // refused save reads as a dead button.
  const errorsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (errors.length) errorsRef.current?.scrollIntoView({ block: 'nearest' });
  }, [errors]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  // With the fleet loaded, a worker is picked rather than typed, and Fleet is
  // what picking one means; without it the status and holder stay manual.
  const workers = fleet?.workers ?? null;
  const workerId = draft.status === 'fleet' ? draft.holder : null;
  const worker = workers?.find((w) => w.worker_id === workerId);
  const holderStatuses = workers ? ['taken', 'problem'] : ['taken', 'fleet', 'problem'];
  // A worker runs one login: one held elsewhere is shown but not offered.
  const heldBy = new Map(
    accounts
      .filter((a) => a.status === 'fleet' && a.holder && a.no !== account?.no)
      .map((a) => [a.holder as string, a.no]),
  );
  const field = (
    name: keyof PoolDraft,
    label: string,
    { secret = false, full = false, help = '', type = 'text' } = {},
  ) => (
    <label className={`fp-field ${full ? 'fp-full' : ''}`}>
      <span>{t(label)}</span>
      <span className="fp-secret">
        <input
          className={`input ${name === 'uid' || name === 'totp' ? 'mono' : ''}`}
          autoFocus={name === 'uid'}
          autoComplete="off"
          spellCheck={false}
          type={secret && !revealed.has(name) ? 'password' : type}
          inputMode={name === 'uid' ? 'numeric' : undefined}
          value={draft[name] ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, [name]: e.target.value }))}
        />
        {secret && (
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t(revealed.has(name) ? 'fpHide' : 'fpShow', { field: t(label) })}
            onClick={() =>
              setRevealed((prev) => {
                const next = new Set(prev);
                next.has(name) ? next.delete(name) : next.add(name);
                return next;
              })
            }
          >
            <Icon name={revealed.has(name) ? 'eyeOff' : 'eye'} size={14} />
          </button>
        )}
      </span>
      {help && <small>{t(help)}</small>}
    </label>
  );
  return (
    <Modal
      onClose={onClose}
      shellClassName="fp-dialog fp-drawer"
      ariaLabel={t(account ? 'fpSave' : 'fpAdd')}
    >
      <form
        className="fp-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          const normalized = {
            ...draft,
            uid: draft.uid.trim(),
            email: draft.email.trim(),
            recovery: draft.recovery.trim(),
            cookie: draft.cookie.trim(),
            totp: totpKey(draft.totp),
            holder: draft.holder?.trim() || null,
          };
          const issues = validatePoolDraft(normalized, accounts, account?.no, account?.cookie);
          setErrors(issues);
          if (!issues.length) onSave(normalized);
        }}
      >
        <div className="modal-head">
          <div>
            <div className="card-sub">{account ? `#${account.no}` : t('fpAdd')}</div>
            <h2 className="modal-title">{account?.uid ?? t('fpAdd')}</h2>
          </div>
          <div className="fp-row">
            {account && <StatusChip status={account.status} />}
            <CloseButton onClose={onClose} />
          </div>
        </div>
        <div className="modal-body">
          {errors.length > 0 && (
            <div className="fp-errors" role="alert" ref={errorsRef}>
              {errors.map((key) => (
                <div key={key}>{t(key)}</div>
              ))}
            </div>
          )}
          <h3 className="fp-section-label">{t('fpLogin')}</h3>
          <div className="fp-form-grid">
            {field('uid', 'fpUid', { full: true, help: 'fpUidHelp' })}
            {field('password', 'fpPassword', { secret: true })}
            {field('totp', 'fpKey', { secret: true, help: 'fpKeyHelp' })}
          </div>
          <h3 className="fp-section-label">{t('fpEmail')}</h3>
          <div className="fp-form-grid">
            {field('email', 'fpEmail', { type: 'email' })}
            {field('emailPassword', 'fpEmailPassword', { secret: true })}
            {field('recovery', 'fpRecovery', { full: true, type: 'email' })}
          </div>
          <h3 className="fp-section-label">{t('fpSession')}</h3>
          <div className="fp-form-grid">
            <label className="fp-field fp-full">
              <span>{t('fpCookie')}</span>
              <textarea
                className="input mono"
                rows={3}
                value={draft.cookie}
                spellCheck={false}
                onChange={(e) => setDraft((d) => ({ ...d, cookie: e.target.value }))}
                placeholder="c_user=…; xs=…; datr=…"
              />
              <small>
                {draft.cookie ? (
                  <>
                    <CookieLabel
                      account={
                        draft.cookie === account?.cookie
                          ? { ...draft, cookieAt: account.cookieAt, cookieBy: account.cookieBy }
                          : { ...draft, cookieAt: Date.now(), cookieBy: null }
                      }
                    />
                    <SessionSummary
                      cookie={draft.cookie}
                      cookieBy={draft.cookie === account?.cookie ? account.cookieBy : null}
                    />
                  </>
                ) : (
                  t('fpCookieHelp')
                )}
              </small>
            </label>
            {field('token', 'fpToken', { secret: true, full: true, help: 'fpTokenHelp' })}
            {field('note', 'fpNotes', { full: true })}
            {workers && (
              <label className="fp-field fp-full">
                <span>{t('fpWorkerSelect')}</span>
                <select
                  className="input"
                  value={workerId ?? ''}
                  onChange={(e) => setDraft((d) => assignWorker(d, e.target.value || null))}
                >
                  <option value="">{t('fpWorkerNone')}</option>
                  {workerId && !worker && (
                    <option value={workerId}>{t('fpWorkerMissing', { id: workerId })}</option>
                  )}
                  {/* A retired worker runs nothing, so it is offered only to the account it already names. */}
                  {workers.filter((w) => !retiredAt(w) || w.worker_id === workerId).map((w) => {
                    const no = heldBy.get(w.worker_id);
                    return (
                      <option key={w.worker_id} value={w.worker_id} disabled={no !== undefined}>
                        {no !== undefined
                          ? t('fpWorkerHeld', { id: w.worker_id, no })
                          : `${w.worker_id} · ${whoIs(w).login ?? w.region.name}`}
                      </option>
                    );
                  })}
                </select>
                <small>{t('fpWorkerHelp')}</small>
                {/* Saving a newly picked worker sends the login; this resends
                    it to the worker the account is already on. */}
                {account?.status === 'fleet' && account.holder && account.holder === workerId && (
                  <button
                    type="button"
                    className="btn sm"
                    style={{ justifySelf: 'start' }}
                    title={t('fpSendLoginHint')}
                    onClick={() => onSendLogin(account.holder as string)}
                  >
                    <Icon name="refresh" size={13} />
                    {t('fpSendLogin', { id: account.holder })}
                  </button>
                )}
              </label>
            )}
            <label className="fp-field">
              <span>{t('fpStatus')}</span>
              {workers && draft.status === 'fleet' ? (
                <span className="fp-row">
                  {worker ? (
                    <WorkerStatusChip status={fleetStatus(worker, parkedWorkers(challenges))} />
                  ) : (
                    <StatusChip status="fleet" />
                  )}
                </span>
              ) : (
                <select
                  className="input"
                  value={draft.status}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, status: e.target.value as PoolDraft['status'] }))
                  }
                >
                  {POOL_STATUSES.filter((s) => !workers || s !== 'fleet').map((s) => (
                    <option key={s} value={s}>
                      {t(STATUS_KEYS[s])}
                    </option>
                  ))}
                </select>
              )}
            </label>
            {!(workers && draft.status === 'fleet') && (
              <label className="fp-field">
                <span>{t('fpHolder')}</span>
                <input
                  className="input"
                  value={holderStatuses.includes(draft.status) ? (draft.holder ?? '') : ''}
                  disabled={!holderStatuses.includes(draft.status)}
                  onChange={(e) => setDraft((d) => ({ ...d, holder: e.target.value }))}
                />
                <small>{t(draft.status === 'fleet' ? 'fpHolderWorkerHelp' : 'fpHolderHelp')}</small>
              </label>
            )}
          </div>
          {account && (
            <>
              <h3 className="fp-section-label">{t('fpHistory')}</h3>
              <ul className="fp-log fp-history">
                {activity
                  .filter((a) => a.accountNo === account.no)
                  .slice(0, 5)
                  .map((a, i) => (
                    <li key={i}>
                      <i className={`fp-dot fp-${a.status}`} />
                      <div>
                        <b>{a.who}</b> {t(a.action)} #{a.accountNo}
                        <time>{relTime(new Date(a.at).toISOString(), locale)}</time>
                      </div>
                    </li>
                  ))}
                <li>
                  <i className="fp-dot fp-fleet" />
                  <div>
                    {account.batch}
                    <time>{relTime(new Date(account.addedAt).toISOString(), locale)}</time>
                  </div>
                </li>
              </ul>
              <div className="fp-danger-zone">
                <p>{t(removing ? 'fpRemoveConfirm' : 'fpRemoveHelp', { n: account.no })}</p>
                <div className="fp-row">
                  {removing ? (
                    <>
                      <button type="button" className="btn danger" onClick={onRemove}>
                        {t('fpRemove')}
                      </button>
                      <button type="button" className="btn" onClick={() => setRemoving(false)}>
                        {t('fpKeep')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn danger"
                        onClick={() => setRemoving(true)}
                      >
                        <Icon name="trash" size={13} />
                        {t('fpRemove')}…
                      </button>
                      {account.status !== 'retired' && (
                        <button type="button" className="btn" onClick={onRetire}>
                          {t('fpRetire')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            {t('fpCancel')}
          </button>
          <button type="submit" className="btn primary">
            {t(account ? 'fpSave' : 'fpAddPool')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
