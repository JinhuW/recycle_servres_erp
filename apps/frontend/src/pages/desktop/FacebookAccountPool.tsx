import { useState, type Dispatch, type SetStateAction } from 'react';
import { Icon } from '../../components/Icon';
import {
  DAY,
  nextPoolAccount,
  POOL_LIMIT,
  POOL_STATUSES,
  poolTotp,
  type PoolAccount,
  type PoolActivity,
  type PoolDraft,
  type PoolSnapshot,
  type PoolStatus,
} from '../../lib/facebookPool';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useEffectiveUser } from '../../lib/tweaks';
import { AccountEditor } from './accountPool/AccountEditor';
import { AccountImport } from './accountPool/AccountImport';
import { CookieLabel, PoolCode, STATUS_KEYS, StatusChip } from './accountPool/shared';
import '../../styles/facebookPool.css';

type Props = {
  snapshot: PoolSnapshot;
  setSnapshot: Dispatch<SetStateAction<PoolSnapshot>>;
  showToast?: (message: string, kind?: 'success' | 'error') => void;
};
export function FacebookAccountPool({ snapshot, setSnapshot, showToast }: Props) {
  const { t, locale } = useT();
  const user = useEffectiveUser()!;
  const manager = user.role === 'manager';
  const { accounts, activity } = snapshot;
  const [filter, setFilter] = useState<PoolStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<PoolAccount | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [reporting, setReporting] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const ago = (at: number) => relTime(new Date(at).toISOString(), locale);
  const log = (
    action: string,
    status: PoolStatus,
    accountNo?: number,
    detail?: string,
  ): PoolActivity => ({ at: Date.now(), who: user.name, action, status, accountNo, detail });
  const update = (no: number, patch: Partial<PoolAccount>, action: string) => {
    setSnapshot((s) => ({
      ...s,
      accounts: s.accounts.map((a) => (a.no === no ? { ...a, ...patch } : a)),
      activity: [
        log(action, patch.status ?? accounts.find((a) => a.no === no)!.status, no),
        ...s.activity,
      ],
    }));
  };
  const addActivity = (action: string, a: PoolAccount) =>
    setSnapshot((s) => ({ ...s, activity: [log(action, a.status, a.no), ...s.activity] }));
  const save = (draft: PoolDraft) => {
    if (!manager) return;
    const original = editor === 'new' ? null : editor;
    const holder = ['taken', 'fleet', 'problem'].includes(draft.status) ? draft.holder : null;
    const now = Date.now();
    if (original) {
      update(
        original.no,
        {
          ...draft,
          holder,
          holderId:
            holder === user.name ? user.id : holder === original.holder ? original.holderId : null,
          since: holder === original.holder ? original.since : holder ? now : null,
          cookieAt:
            draft.cookie === original.cookie ? original.cookieAt : draft.cookie ? now : null,
        },
        'fpLogEdited',
      );
      showToast?.(t('fpSaved', { n: original.no }));
    } else {
      setSnapshot((s) => ({
        ...s,
        nextNo: s.nextNo + 1,
        accounts: [
          ...s.accounts,
          {
            ...draft,
            holder,
            holderId: holder === user.name ? user.id : null,
            no: s.nextNo,
            since: holder ? now : null,
            addedAt: now,
            cookieAt: draft.cookie ? now : null,
            batch: t('fpManualBatch'),
          },
        ],
        activity: [log('fpLogAdded', draft.status, s.nextNo), ...s.activity],
      }));
      showToast?.(t('fpSaved', { n: snapshot.nextNo }));
    }
    setEditor(null);
  };
  const mine = accounts.filter((a) => a.status === 'taken' && a.holderId === user.id);
  const chosen =
    accounts.find((a) => a.no === picked && a.status === 'available') ?? nextPoolAccount(accounts);
  const take = (no: number) => {
    setSnapshot((s) => {
      const account = s.accounts.find((a) => a.no === no);
      if (
        account?.status !== 'available' ||
        s.accounts.filter((a) => a.status === 'taken' && a.holderId === user.id).length >=
          POOL_LIMIT
      )
        return s;
      return {
        ...s,
        accounts: s.accounts.map((a) =>
          a.no === no
            ? { ...a, status: 'taken', holder: user.name, holderId: user.id, since: Date.now() }
            : a,
        ),
        activity: [log('fpLogTook', 'taken', no), ...s.activity],
      };
    });
    setPicked(null);
    showToast?.(t('fpTakenToast', { n: no }));
  };
  const clearReveals = (no: number) =>
    setRevealed((prev) => new Set([...prev].filter((key) => !key.startsWith(`${no}:`))));
  const copy = async (
    a: PoolAccount,
    field: 'uid' | 'password' | 'email' | 'emailPassword' | 'recovery' | 'cookie' | 'totp',
    label: string,
  ) => {
    const value = field === 'totp' ? await poolTotp(a.totp) : a[field];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast?.(t('fpCopied', { field: t(label) }));
      if (!['uid', 'email', 'recovery'].includes(field)) addActivity('fpLogCopied', a);
    } catch {
      showToast?.(t('fpCopyFailed'), 'error');
    }
  };
  const rack = () => (
    <section className="fp-rack" aria-label={t('fpRack')}>
      <div className="fp-legend">
        {POOL_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className={`fp-legend-item fp-${status}`}
            disabled={!manager}
            aria-pressed={manager ? filter === status : undefined}
            onClick={() => setFilter((f) => (f === status ? 'all' : status))}
          >
            <i className="fp-dot" />
            <span>{t(STATUS_KEYS[status])}</span>
            <b>{accounts.filter((a) => a.status === status).length}</b>
          </button>
        ))}
      </div>
      <div className="fp-rail">
        {accounts.map((a) => {
          const name =
            a.status === 'taken' || a.status === 'fleet'
              ? a.holder
              : a.status === 'problem'
                ? '!'
                : '';
          const title = `#${a.no} · ${t(STATUS_KEYS[a.status])}${a.holder ? ` · ${a.holder}` : ''}`;
          return (
            <button
              key={a.no}
              type="button"
              title={title}
              aria-label={title}
              className={`fp-tag fp-${a.status} ${manager ? (filter !== 'all' && a.status !== filter ? 'fp-dim' : '') : a.status !== 'available' ? 'fp-dim' : ''}`}
              disabled={!manager && a.status !== 'available'}
              aria-pressed={
                !manager
                  ? chosen?.no === a.no
                  : editor !== null && editor !== 'new' && editor.no === a.no
              }
              onClick={() => (manager ? setEditor(a) : setPicked(a.no))}
            >
              <span className="fp-number">{a.no}</span>
              <span className="fp-who">{name}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
  const visible = accounts.filter(
    (a) =>
      (filter === 'all' || a.status === filter) &&
      [a.no, a.uid, a.email, a.recovery, a.note, a.holder, a.batch]
        .join(' ')
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const copyButton = (a: PoolAccount, field: Parameters<typeof copy>[1], label: string) => (
    <button
      type="button"
      className="btn ghost icon sm"
      aria-label={t('fpCopy', { field: t(label) })}
      title={t('fpCopy', { field: t(label) })}
      onClick={() => void copy(a, field, label)}
    >
      <Icon name="copy" size={13} />
    </button>
  );
  return (
    <div className="fp-pool">
      <div className="fp-demo">
        <span className="fp-demo-badge">
          <Icon name="info" size={13} />
          {t('fpDemo')}
        </span>
        <span>{t('fpDemoNote')}</span>
      </div>
      {manager ? (
        <>
          {rack()}
          <div className="fp-split">
            <section className="card fp-accounts" aria-label={t('fpPool')}>
              <div className="fp-toolbar">
                <label className="toolbar-search">
                  <Icon name="search" size={14} />
                  <input
                    className="input"
                    type="search"
                    placeholder={t('fpSearch')}
                    aria-label={t('fpSearch')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                {(filter !== 'all' || query) && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => {
                      setFilter('all');
                      setQuery('');
                    }}
                  >
                    <Icon name="x" size={12} />
                    {t('fpClear')}
                  </button>
                )}
                <div className="fp-toolbar-actions">
                  <button type="button" className="btn" onClick={() => setImporting(true)}>
                    <Icon name="upload" size={14} />
                    {t('fpImport')}
                  </button>
                  <button type="button" className="btn primary" onClick={() => setEditor('new')}>
                    <Icon name="plus" size={14} />
                    {t('fpAdd')}
                  </button>
                </div>
              </div>
              <div className="fp-table-wrap">
                <table className="fp-table">
                  <thead>
                    <tr>
                      {[
                        '#',
                        'fpUid',
                        'fpStatus',
                        'fpHolder',
                        'fpPassword',
                        'fpCode',
                        'fpEmail',
                        'fpEmailPassword',
                        'fpRecovery',
                        'fpCookie',
                        'fpNotes',
                      ].map((key) => (
                        <th key={key}>{key === '#' ? '# 序号' : t(key)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((a) => (
                      <tr
                        key={a.no}
                        tabIndex={0}
                        aria-label={`${t('edit')} #${a.no}`}
                        onClick={() => setEditor(a)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setEditor(a);
                          }
                        }}
                      >
                        <td className="fp-row-number">{a.no}</td>
                        <td className="mono">{a.uid}</td>
                        <td>
                          <StatusChip status={a.status} />
                        </td>
                        <td>
                          <span className="fp-holder">
                            {a.holder ?? '—'}
                            {a.status === 'fleet' ? (
                              <small>{t('fpWorker')}</small>
                            ) : (
                              a.since && (
                                <small className={Date.now() - a.since > 7 * DAY ? 'fp-warn' : ''}>
                                  {Date.now() - a.since > 7 * DAY ? t('fpOverdue') : ago(a.since)}
                                </small>
                              )
                            )}
                          </span>
                        </td>
                        <td className="fp-masked">••••••••</td>
                        <td>
                          <PoolCode secret={a.totp} />
                        </td>
                        <td>{a.email || '—'}</td>
                        <td className="fp-masked">{a.emailPassword ? '••••••••' : '—'}</td>
                        <td className="fp-muted">{a.recovery || '—'}</td>
                        <td>
                          <CookieLabel account={a} />
                        </td>
                        <td className="fp-note" title={a.note}>
                          {a.note || '—'}
                        </td>
                      </tr>
                    ))}
                    {!visible.length && (
                      <tr>
                        <td colSpan={11} className="fp-empty">
                          {t('fpNoMatch')}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="fp-table-foot">
                {t('fpResults', { n: visible.length, total: accounts.length })}
              </div>
            </section>
            <aside className="card fp-activity">
              <div className="card-head">
                <h2 className="card-title">{t('fpRecent')}</h2>
                <span className="card-sub">{t('fpActivitySub')}</span>
              </div>
              <ul className="fp-log">
                {activity.slice(0, 8).map((entry, i) => (
                  <li key={i}>
                    <i className={`fp-dot fp-${entry.status}`} />
                    <div>
                      <b>{entry.who}</b> {t(entry.action)}
                      {entry.accountNo !== undefined && ` #${entry.accountNo}`}
                      {entry.detail && ` · ${entry.detail}`}
                      <time>{ago(entry.at)}</time>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="card-head fp-rule-head">
                <h2 className="card-title">{t('fpRules')}</h2>
              </div>
              <ul className="fp-rules">
                {['fpRuleLimit', 'fpRuleHeld', 'fpRuleCookie'].map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ul>
            </aside>
          </div>
        </>
      ) : (
        <>
          <section className="card fp-take">
            <div>
              <h2>{t('fpFree', { n: accounts.filter((a) => a.status === 'available').length })}</h2>
              <p className="fp-take-help">{t('fpTakeHelp')}</p>
              {rack()}
            </div>
            <div className="fp-pick" aria-live="polite">
              {chosen ? (
                <>
                  <div className="fp-row fp-between">
                    <b className="fp-pick-number">#{chosen.no}</b>
                    <span className="fp-muted">
                      {t(picked === chosen.no ? 'fpChoice' : 'fpNext')}
                    </span>
                  </div>
                  <dl>
                    <dt>UID</dt>
                    <dd className="mono">
                      {chosen.uid.slice(0, 4)}…{chosen.uid.slice(-4)}
                    </dd>
                    <dt>{t('fpEmail')}</dt>
                    <dd>
                      {chosen.email
                        ? chosen.email.slice(0, 2) + '•••@' + chosen.email.split('@')[1]
                        : '—'}
                    </dd>
                    <dt>{t('fpCookie')}</dt>
                    <dd>
                      <CookieLabel account={chosen} />
                    </dd>
                    <dt>{t('fpInPool')}</dt>
                    <dd>{t('fpDays', { n: Math.floor((Date.now() - chosen.addedAt) / DAY) })}</dd>
                    <dt>{t('fpNotes')}</dt>
                    <dd>{chosen.note || '—'}</dd>
                  </dl>
                  <button
                    type="button"
                    className="btn fp-accent-button"
                    disabled={mine.length >= POOL_LIMIT}
                    onClick={() => take(chosen.no)}
                  >
                    <Icon name="key" size={14} />
                    {t('fpTake', { n: chosen.no })}
                  </button>
                  {mine.length >= POOL_LIMIT ? (
                    <small className="fp-warn">{t('fpAtLimit')}</small>
                  ) : (
                    picked !== null && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => setPicked(null)}
                      >
                        {t('fpUseNext')}
                      </button>
                    )
                  )}
                </>
              ) : (
                <p className="fp-muted">{t('fpEmptyRack')}</p>
              )}
            </div>
          </section>
          <section>
            <div className="fp-row fp-mine-heading">
              <h2>{t('fpYourAccounts')}</h2>
              <span className="fp-muted">{t('fpLimitCount', { n: mine.length })}</span>
            </div>
            {!mine.length ? (
              <div className="fp-empty-mine">{t('fpEmptyMine')}</div>
            ) : (
              <div className="fp-mine">
                {mine.map((a) => (
                  <article key={a.no} className="fp-credential">
                    <div className="fp-stub">
                      <b>{a.no}</b>
                      <small>{a.since && ago(a.since)}</small>
                    </div>
                    <div className="fp-credential-main">
                      <div className="fp-credential-head">
                        <b className="mono">{a.uid}</b>
                        <small>{a.batch}</small>
                      </div>
                      <div className="fp-code-band">
                        <PoolCode secret={a.totp} large />
                        <small>
                          {t('fpCode')}
                          <br />
                          <span className="fp-muted">{t('fpCodeHelp')}</span>
                        </small>
                        {copyButton(a, 'totp', 'fpCode')}
                      </div>
                      <dl className="fp-fields">
                        {(
                          [
                            'uid',
                            'password',
                            'email',
                            'emailPassword',
                            'recovery',
                            'cookie',
                            'note',
                          ] as const
                        ).map((field, i) => {
                          const label = [
                            'fpUid',
                            'fpPassword',
                            'fpEmail',
                            'fpEmailPassword',
                            'fpRecovery',
                            'fpCookie',
                            'fpNotes',
                          ][i];
                          const secret = field === 'password' || field === 'emailPassword';
                          const shown = revealed.has(`${a.no}:${field}`);
                          return (
                            <div key={field}>
                              <dt>{t(label)}</dt>
                              <dd title={!secret ? a[field] : undefined}>
                                {field === 'cookie' ? (
                                  <CookieLabel account={a} />
                                ) : (
                                  <span
                                    className={
                                      secret && !shown
                                        ? 'fp-masked'
                                        : field === 'note'
                                          ? 'fp-muted'
                                          : 'mono'
                                    }
                                  >
                                    {secret && !shown ? '••••••••••' : a[field] || '—'}
                                  </span>
                                )}
                              </dd>
                              <span className="fp-row">
                                {secret && (
                                  <button
                                    type="button"
                                    className="btn ghost icon sm"
                                    aria-label={t(shown ? 'fpHide' : 'fpShow', { field: t(label) })}
                                    onClick={() => {
                                      setRevealed((prev) => {
                                        const next = new Set(prev);
                                        shown
                                          ? next.delete(`${a.no}:${field}`)
                                          : next.add(`${a.no}:${field}`);
                                        return next;
                                      });
                                      if (!shown) addActivity('fpLogRevealed', a);
                                    }}
                                  >
                                    <Icon name={shown ? 'eyeOff' : 'eye'} size={14} />
                                  </button>
                                )}
                                {field !== 'note' && a[field] && copyButton(a, field, label)}
                              </span>
                            </div>
                          );
                        })}
                      </dl>
                      <div className="fp-credential-foot">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            update(
                              a.no,
                              { status: 'available', holder: null, holderId: null, since: null },
                              'fpLogReturned',
                            );
                            clearReveals(a.no);
                            setReporting(null);
                            showToast?.(t('fpReturnedToast', { n: a.no }));
                          }}
                        >
                          <Icon name="rotate" size={14} />
                          {t('fpReturn')}
                        </button>
                        <button
                          type="button"
                          className="btn danger"
                          aria-expanded={reporting === a.no}
                          onClick={() => setReporting(reporting === a.no ? null : a.no)}
                        >
                          <Icon name="flag" size={14} />
                          {t('fpReport')}
                        </button>
                      </div>
                      {reporting === a.no && (
                        <div className="fp-report">
                          <p>{t('fpReportHelp')}</p>
                          {['fpCheckpoint', 'fpWrongPassword', 'fpBadCode', 'fpDisabled'].map(
                            (reason) => (
                              <button
                                type="button"
                                className="btn sm"
                                key={reason}
                                onClick={() => {
                                  update(
                                    a.no,
                                    {
                                      status: 'problem',
                                      note: `${t(reason)} (${user.name})${a.note ? ` · ${a.note}` : ''}`,
                                    },
                                    'fpLogReported',
                                  );
                                  clearReveals(a.no);
                                  setReporting(null);
                                  showToast?.(t('fpReportedToast', { n: a.no }));
                                }}
                              >
                                {t(reason)}
                              </button>
                            ),
                          )}
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => setReporting(null)}
                          >
                            {t('fpCancel')}
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {manager && editor && (
        <AccountEditor
          key={editor === 'new' ? 'new' : editor.no}
          account={editor === 'new' ? null : editor}
          accounts={accounts}
          activity={activity}
          onClose={() => setEditor(null)}
          onSave={save}
          onRetire={() => {
            if (editor !== 'new')
              update(
                editor.no,
                { status: 'retired', holder: null, holderId: null, since: null },
                'fpLogRetired',
              );
            setEditor(null);
          }}
          onRemove={() => {
            if (editor !== 'new')
              setSnapshot((s) => ({
                ...s,
                accounts: s.accounts.filter((a) => a.no !== editor.no),
                activity: [log('fpLogRemoved', 'retired', editor.no), ...s.activity],
              }));
            setEditor(null);
          }}
        />
      )}
      {manager && importing && (
        <AccountImport
          accounts={accounts}
          onClose={() => setImporting(false)}
          onImport={(drafts, batch) => {
            const now = Date.now();
            setSnapshot((s) => ({
              nextNo: s.nextNo + drafts.length,
              accounts: [
                ...s.accounts,
                ...drafts.map((draft, i) => ({
                  ...draft,
                  no: s.nextNo + i,
                  holderId: null,
                  since: null,
                  addedAt: now,
                  cookieAt: draft.cookie ? now : null,
                  batch,
                })),
              ],
              activity: [
                log('fpLogImported', 'available', undefined, `${drafts.length} · ${batch}`),
                ...s.activity,
              ],
            }));
            setImporting(false);
            setFilter('all');
            setQuery('');
            showToast?.(t('fpImportedToast', { n: drafts.length }));
          }}
        />
      )}
    </div>
  );
}
