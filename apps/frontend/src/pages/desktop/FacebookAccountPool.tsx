import { useState } from 'react';
import type { FbPoolSecretField, FbReportReason } from '@recycle-erp/shared';
import { Icon } from '../../components/Icon';
import { ApiError } from '../../lib/api';
import { handleFetchError, showWarnToast } from '../../lib/errorToast';
import {
  activityKey,
  DAY,
  nextPoolAccount,
  POOL_LIMIT,
  POOL_STATUSES,
  poolApi,
  poolTotp,
  REPORT_REASON_KEYS,
  type PoolAccount,
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
  onSnapshot: (snapshot: PoolSnapshot) => void;
  showToast?: (message: string, kind?: 'success' | 'error') => void;
};
// Refusals the API names with one of the page's own keys read as a warning,
// not as the blocking error dialog: the pool moved under the user, that's all.
const KNOWN_REFUSALS = new Set(['fpAtLimit', 'fpDuplicate', 'fpTakenElsewhere', 'fpNotTaken']);
export function FacebookAccountPool({ snapshot, onSnapshot, showToast }: Props) {
  const { t, locale } = useT();
  const user = useEffectiveUser()!;
  const manager = user.role === 'manager';
  const { accounts, activity } = snapshot;
  const [busy, setBusy] = useState(false);
  // Every write answers with the whole pool; a refusal with a known code is a
  // warning toast, anything else is the usual error dialog.
  const run = async (
    request: Promise<PoolSnapshot>,
    toast?: string | ((s: PoolSnapshot) => string),
  ): Promise<PoolSnapshot | null> => {
    setBusy(true);
    try {
      const next = await request;
      onSnapshot(next);
      if (toast) showToast?.(typeof toast === 'function' ? toast(next) : toast);
      return next;
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
      if (err instanceof ApiError && err.status === 409 && code && KNOWN_REFUSALS.has(code)) {
        showWarnToast(t(code));
        void poolApi.snapshot().then(onSnapshot).catch(() => undefined);
      } else handleFetchError(err);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const audit = (no: number, kind: 'copied' | 'revealed', field: FbPoolSecretField) =>
    void poolApi.event(no, kind, field).catch(() => undefined);
  const [filter, setFilter] = useState<PoolStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<PoolAccount | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [reporting, setReporting] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const ago = (at: number) => relTime(new Date(at).toISOString(), locale);
  const save = async (draft: PoolDraft) => {
    if (!manager || busy) return;
    const original = editor === 'new' ? null : editor;
    const saved = await (original
      ? run(poolApi.update(original.no, draft), t('fpSaved', { n: original.no }))
      : run(poolApi.create(draft, t('fpManualBatch')), (s) =>
          t('fpSaved', { n: s.accounts.find((a) => a.uid === draft.uid)?.no ?? '' }),
        ));
    if (saved) setEditor(null);
  };
  const mine = accounts.filter((a) => a.status === 'taken' && a.holderId === user.id);
  const chosen =
    accounts.find((a) => a.no === picked && a.status === 'available') ?? nextPoolAccount(accounts);
  const take = async (no: number) => {
    if (busy) return;
    if (await run(poolApi.take(no), t('fpTakenToast', { n: no }))) setPicked(null);
  };
  const clearReveals = (no: number) =>
    setRevealed((prev) => new Set([...prev].filter((key) => !key.startsWith(`${no}:`))));
  const copy = async (
    a: PoolAccount,
    field: 'uid' | 'password' | 'email' | 'emailPassword' | 'recovery' | 'cookie' | 'totp',
    label: string,
  ) => {
    const value = field === 'totp' ? await poolTotp(a.totp) : a[field];
    if (!value) {
      // A key that decodes but yields no code: crypto.subtle is missing, which
      // is an http page. Say so rather than copy nothing in silence.
      if (field === 'totp' && a.totp) showToast?.(t('fpCodeUnavailable'), 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showToast?.(t('fpCopied', { field: t(label) }));
      if (field !== 'uid' && field !== 'email' && field !== 'recovery') audit(a.no, 'copied', field);
    } catch {
      showToast?.(t('fpCopyFailed'), 'error');
    }
  };
  // Managers read the legend and the table; the rail of tags stays only as the
  // purchaser's picker, the one way to take a particular account.
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
      {!manager && <div className="fp-rail">
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
              className={`fp-tag fp-${a.status} ${a.status !== 'available' ? 'fp-dim' : ''}`}
              disabled={a.status !== 'available'}
              aria-pressed={chosen?.no === a.no}
              onClick={() => setPicked(a.no)}
            >
              <span className="fp-number">{a.no}</span>
              <span className="fp-who">{name}</span>
            </button>
          );
        })}
      </div>}
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
                        <th key={key}>{key === '#' ? t('fpNo') : t(key)}</th>
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
                      <b>{entry.who}</b> {t(activityKey(entry.action))}
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
                    <dt>{t('fpUid')}</dt>
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
                                      if (!shown) audit(a.no, 'revealed', field);
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
                          disabled={busy}
                          onClick={() => {
                            void run(poolApi.giveBack(a.no), t('fpReturnedToast', { n: a.no })).then(
                              (ok) => {
                                if (!ok) return;
                                clearReveals(a.no);
                                setReporting(null);
                              },
                            );
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
                          {(Object.keys(REPORT_REASON_KEYS) as FbReportReason[]).map((reason) => (
                            <button
                              type="button"
                              className="btn sm"
                              key={reason}
                              disabled={busy}
                              onClick={() => {
                                const note = `${t(REPORT_REASON_KEYS[reason])} (${user.name})${a.note ? ` · ${a.note}` : ''}`;
                                void run(
                                  poolApi.report(a.no, reason, note),
                                  t('fpReportedToast', { n: a.no }),
                                ).then((ok) => {
                                  if (!ok) return;
                                  clearReveals(a.no);
                                  setReporting(null);
                                });
                              }}
                            >
                              {t(REPORT_REASON_KEYS[reason])}
                            </button>
                          ))}
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
          onSave={(draft) => void save(draft)}
          onRetire={() => {
            if (editor === 'new' || busy) return;
            void run(poolApi.retire(editor.no)).then((ok) => ok && setEditor(null));
          }}
          onRemove={() => {
            if (editor === 'new' || busy) return;
            void run(poolApi.remove(editor.no)).then((ok) => ok && setEditor(null));
          }}
        />
      )}
      {manager && importing && (
        <AccountImport
          accounts={accounts}
          onClose={() => setImporting(false)}
          onImport={(drafts, batch) => {
            if (busy) return;
            void run(
              poolApi.importRows(batch, drafts),
              t('fpImportedToast', { n: drafts.length }),
            ).then((ok) => {
              if (!ok) return;
              setImporting(false);
              setFilter('all');
              setQuery('');
            });
          }}
        />
      )}
    </div>
  );
}
