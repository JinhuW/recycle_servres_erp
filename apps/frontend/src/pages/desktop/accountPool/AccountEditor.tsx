import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import {
  emptyPoolDraft,
  POOL_STATUSES,
  totpKey,
  validatePoolDraft,
  type PoolAccount,
  type PoolDraft,
  type PoolActivity,
} from '../../../lib/facebookPool';
import { relTime } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { CloseButton, CookieLabel, STATUS_KEYS, StatusChip } from './shared';

export function AccountEditor({
  account,
  accounts,
  activity,
  onClose,
  onSave,
  onRemove,
  onRetire,
}: {
  account: PoolAccount | null;
  accounts: PoolAccount[];
  activity: PoolActivity[];
  onClose: () => void;
  onSave: (draft: PoolDraft) => void;
  onRemove: () => void;
  onRetire: () => void;
}) {
  const { t, locale } = useT();
  const [draft, setDraft] = useState<PoolDraft>(() =>
    account ? { ...account } : emptyPoolDraft(),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
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
          const issues = validatePoolDraft(normalized, accounts, account?.no);
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
            <div className="fp-errors" role="alert">
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
                  <CookieLabel
                    account={{
                      ...draft,
                      cookieAt: draft.cookie === account?.cookie ? account.cookieAt : Date.now(),
                    }}
                  />
                ) : (
                  t('fpCookieHelp')
                )}
              </small>
            </label>
            {field('note', 'fpNotes', { full: true })}
            <label className="fp-field">
              <span>{t('fpStatus')}</span>
              <select
                className="input"
                value={draft.status}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, status: e.target.value as PoolDraft['status'] }))
                }
              >
                {POOL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(STATUS_KEYS[s])}
                  </option>
                ))}
              </select>
            </label>
            <label className="fp-field">
              <span>{t('fpHolder')}</span>
              <input
                className="input"
                value={
                  ['taken', 'fleet', 'problem'].includes(draft.status) ? (draft.holder ?? '') : ''
                }
                disabled={!['taken', 'fleet', 'problem'].includes(draft.status)}
                onChange={(e) => setDraft((d) => ({ ...d, holder: e.target.value }))}
              />
              <small>{t('fpHolderHelp')}</small>
            </label>
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
