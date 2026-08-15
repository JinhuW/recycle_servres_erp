import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  MIN_POLL_INTERVAL_S,
  normalizeSubredditName,
  trackerApi,
  type TrackerRule,
  type TrackerSubreddit,
  type TrackerWorker,
  type LoopName,
} from '../../lib/tracker';
import { liveness, sortByLiveness, type Liveness } from '../../lib/workerLiveness';
import { ConfirmDialog } from './settings/dialogs';
import { Toggle } from './settings/_shared';

// ─── Tracker admin ─────────────────────────────────────────────────────────────
// Manager console for the Reddit for-sale monitor: prompt-based alert rules,
// watched subreddits, and (at the bottom) fleet health. Everything goes
// through the /api/tracker proxy; a 501 from it means the backend has no
// tracker credentials, which gets its own quiet state instead of error toasts.

const FLEET_REFRESH_MS = 30_000;

const LOOPS: readonly LoopName[] = ['poll', 'evaluate', 'notify'];

type Props = { showToast?: (msg: string, kind?: 'success' | 'error') => void };

export function DesktopTracker({ showToast }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const [workers, setWorkers] = useState<TrackerWorker[] | null>(null);
  const [rules, setRules] = useState<TrackerRule[] | null>(null);
  const [subs, setSubs] = useState<TrackerSubreddit[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [notConfigured, setNotConfigured] = useState(false);

  const [ruleDialog, setRuleDialog] = useState<TrackerRule | 'new' | null>(null);
  const [deletingRule, setDeletingRule] = useState<TrackerRule | null>(null);
  const [deletingSub, setDeletingSub] = useState<TrackerSubreddit | null>(null);

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 501) {
      setNotConfigured(true);
      return;
    }
    handleFetchError(err);
  }, []);

  useEffect(() => {
    let alive = true;
    const loadFleet = () =>
      trackerApi.listWorkers()
        .then(w => { if (alive) { setWorkers(w); setNow(Date.now()); } })
        .catch(err => { if (alive) fail(err); });

    loadFleet();
    trackerApi.listRules().then(r => { if (alive) setRules(r); }).catch(err => { if (alive) fail(err); });
    trackerApi.listSubreddits().then(s => { if (alive) setSubs(s); }).catch(err => { if (alive) fail(err); });

    // Only the fleet refetches on a timer: liveness is time-derived, while
    // rules and subreddits change only through this page.
    const timer = setInterval(loadFleet, FLEET_REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [fail]);

  const liveCount = useMemo(
    () => (workers ?? []).filter(w => liveness(w.lastHeartbeatAt, now) === 'live').length,
    [workers, now],
  );

  if (notConfigured) {
    return (
      <>
        <PageHead t={t} />
        <div className="card">
          <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--fg-muted)' }}>
            <Icon name="info" size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ maxWidth: '65ch' }}>{t('trkNotConfigured')}</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead t={t} />

      {/* ── Alert rules ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('trkRulesTitle')}</div>
            <div className="card-sub">{t('trkRulesSub')}</div>
          </div>
          <button className="btn primary sm" onClick={() => setRuleDialog('new')}>
            <Icon name="plus" size={13} />
            {t('trkNewRule')}
          </button>
        </div>
        {rules?.length === 0 && (
          <div className="card-body" style={{ color: 'var(--fg-subtle)', fontSize: 13 }}>
            {t('trkRulesEmpty')}
          </div>
        )}
        {(rules ?? []).map(rule => (
          <div key={rule.id} style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '12px 16px', borderTop: '1px solid var(--border)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, color: rule.enabled ? undefined : 'var(--fg-subtle)' }}>
                {rule.name}
              </div>
              <div style={{
                fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 2, maxWidth: '68ch',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {rule.prompt}
              </div>
            </div>
            <Toggle
              checked={rule.enabled}
              onChange={enabled => {
                trackerApi.updateRule(rule.id, { enabled })
                  .then(updated => setRules(rs => (rs ?? []).map(r => r.id === updated.id ? updated : r)))
                  .catch(fail);
              }}
            />
            <button className="btn icon sm" title={t('trkEditRule')} onClick={() => setRuleDialog(rule)}>
              <Icon name="edit" size={13} />
            </button>
            <button className="btn icon sm" title={t('trkDeleteRule')} onClick={() => setDeletingRule(rule)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>

      {/* ── Subreddits ── */}
      <SubredditsCard
        subs={subs}
        locale={locale}
        onChanged={setSubs}
        onDelete={setDeletingSub}
        onError={fail}
        showToast={showToast}
      />

      {/* ── Fleet (worker health, intentionally last) ── */}
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('trkFleetTitle')}</div>
            <div className="card-sub">
              {workers ? t('trkFleetSub', { live: String(liveCount), n: String(workers.length) }) : '…'}
            </div>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('trkColStatus')}</th>
                <th>{t('trkColWorker')}</th>
                <th>{t('trkColRole')}</th>
                <th>{t('trkColStarted')}</th>
                <th>{t('trkColHeartbeat')}</th>
                <th>{t('trkColPoll')}</th>
                <th>{t('trkColEvaluate')}</th>
                <th>{t('trkColNotify')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortByLiveness(workers ?? [], now).map(w => (
                <WorkerRow key={w.workerId} worker={w} now={now} locale={locale}
                  onRemove={() => {
                    trackerApi.removeWorker(w.workerId)
                      .then(() => {
                        setWorkers(ws => (ws ?? []).filter(x => x.workerId !== w.workerId));
                        showToast?.(t('trkWorkerRemoved'));
                      })
                      .catch(fail);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {ruleDialog && (
        <RuleModal
          rule={ruleDialog === 'new' ? null : ruleDialog}
          onClose={() => setRuleDialog(null)}
          onSaved={saved => {
            setRules(rs => {
              const list = rs ?? [];
              return list.some(r => r.id === saved.id)
                ? list.map(r => r.id === saved.id ? saved : r)
                : [...list, saved];
            });
            setRuleDialog(null);
            showToast?.(t('trkRuleSaved'));
          }}
          onError={fail}
        />
      )}

      {deletingRule && (
        <ConfirmDialog
          title={t('trkDeleteRule')}
          message={t('trkDeleteRuleMsg', { name: deletingRule.name })}
          confirmLabel={t('trkDeleteRule')}
          danger
          onCancel={() => setDeletingRule(null)}
          onConfirm={() => {
            trackerApi.deleteRule(deletingRule.id)
              .then(() => {
                setRules(rs => (rs ?? []).filter(r => r.id !== deletingRule.id));
                showToast?.(t('trkRuleDeleted'));
              })
              .catch(fail)
              .finally(() => setDeletingRule(null));
          }}
        />
      )}

      {deletingSub && (
        <ConfirmDialog
          title={t('trkDeleteSub')}
          message={t('trkDeleteSubMsg', { name: deletingSub.name })}
          confirmLabel={t('trkDeleteSub')}
          danger
          onCancel={() => setDeletingSub(null)}
          onConfirm={() => {
            trackerApi.deleteSubreddit(deletingSub.name)
              .then(() => {
                setSubs(ss => (ss ?? []).filter(s => s.name !== deletingSub.name));
                showToast?.(t('trkSubRemoved'));
              })
              .catch(fail)
              .finally(() => setDeletingSub(null));
          }}
        />
      )}
    </>
  );
}

function PageHead({ t }: { t: (k: string, vars?: Record<string, string>) => string }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{t('trkTitle')}</h1>
        <div className="page-sub">{t('trkSubtitle')}</div>
      </div>
    </div>
  );
}

const LIVENESS_CHIP: Record<Liveness, { chip: string; key: string }> = {
  live: { chip: 'chip pos', key: 'trkLive' },
  stale: { chip: 'chip warn', key: 'trkStale' },
  dead: { chip: 'chip neg', key: 'trkDead' },
};

function WorkerRow({ worker, now, locale, onRemove }: {
  worker: TrackerWorker;
  now: number;
  locale: string;
  onRemove: () => void;
}) {
  const { t } = useT();
  const state = liveness(worker.lastHeartbeatAt, now);
  const heartbeatColor = state === 'dead' ? 'var(--neg)'
    : state === 'stale' ? 'oklch(0.45 0.13 75)'
    : undefined;

  return (
    <tr>
      <td>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className={state === 'live' ? 'vl-dot' : undefined} style={state === 'live' ? undefined : {
            width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
            background: state === 'dead' ? 'var(--neg)' : 'var(--warn)',
          }} />
          <span className={LIVENESS_CHIP[state].chip}>{t(LIVENESS_CHIP[state].key)}</span>
        </span>
      </td>
      <td className="mono">{worker.workerId}</td>
      <td><span className={worker.role === 'api' ? 'chip info' : 'chip muted'}>{worker.role}</span></td>
      <td className="muted">{relTime(worker.startedAt, locale)}</td>
      <td style={{ color: heartbeatColor, fontWeight: heartbeatColor ? 550 : undefined }}>
        {relTime(worker.lastHeartbeatAt, locale)}
      </td>
      {LOOPS.map(loop => {
        const at = worker.loops[loop]?.lastSuccessAt ?? null;
        return <td key={loop} className={at ? undefined : 'muted'}>{at ? relTime(at, locale) : '—'}</td>;
      })}
      <td>
        {state === 'dead' && (
          <button className="btn icon sm" title={t('trkRemoveWorker')} onClick={onRemove}>
            <Icon name="trash" size={13} />
          </button>
        )}
      </td>
    </tr>
  );
}

function SubredditsCard({ subs, locale, onChanged, onDelete, onError, showToast }: {
  subs: TrackerSubreddit[] | null;
  locale: string;
  onChanged: (update: (prev: TrackerSubreddit[] | null) => TrackerSubreddit[] | null) => void;
  onDelete: (sub: TrackerSubreddit) => void;
  onError: (err: unknown) => void;
  showToast?: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [interval, setIntervalStr] = useState('90');
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function add() {
    const normalized = normalizeSubredditName(name);
    if (!normalized) {
      setFormError(t('trkSubInvalidName'));
      return;
    }
    const seconds = Number(interval);
    if (!Number.isFinite(seconds) || seconds < MIN_POLL_INTERVAL_S) {
      setFormError(t('trkSubInvalidInterval'));
      return;
    }
    setFormError(null);
    setAdding(true);
    trackerApi.addSubreddit({ name: normalized, pollIntervalSeconds: Math.floor(seconds) })
      .then(added => {
        onChanged(prev => {
          const list = (prev ?? []).filter(s => s.name !== added.name);
          return [...list, added].sort((a, b) => a.name.localeCompare(b.name));
        });
        setName('');
        setIntervalStr('90');
        showToast?.(t('trkSubAdded'));
      })
      .catch(onError)
      .finally(() => setAdding(false));
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <div className="card-title">{t('trkSubsTitle')}</div>
          <div className="card-sub">{t('trkSubsSub')}</div>
        </div>
      </div>

      <div style={{
        display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap',
        padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-soft)',
      }}>
        <div className="field" style={{ width: 240 }}>
          <label className="label" htmlFor="trk-sub-name">{t('trkSubName')}</label>
          <input id="trk-sub-name" className="input" placeholder="homelabsales"
            value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        </div>
        <div className="field" style={{ width: 150 }}>
          <label className="label" htmlFor="trk-sub-interval">{t('trkInterval')}</label>
          <input id="trk-sub-interval" className="input" inputMode="numeric"
            value={interval} onChange={e => setIntervalStr(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        </div>
        <button className="btn primary" onClick={add} disabled={adding}>
          {t('trkAddSub')}
        </button>
        <div className="help" style={{ flexBasis: '100%', color: formError ? 'var(--neg)' : undefined }}>
          {formError ?? `${t('trkSubNameHelp')} ${t('trkIntervalHelp')}`}
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('trkSubName')}</th>
              <th>{t('trkColEnabled')}</th>
              <th>{t('trkColInterval')}</th>
              <th>{t('trkColLastPolled')}</th>
              <th>{t('trkColStatus')}</th>
              <th>{t('trkColClaimedBy')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(subs ?? []).map(sub => (
              <tr key={sub.name}>
                <td className="mono" style={{ color: sub.enabled ? undefined : 'var(--fg-subtle)' }}>
                  r/{sub.name}
                </td>
                <td>
                  <Toggle checked={sub.enabled} onChange={enabled => {
                    trackerApi.updateSubreddit(sub.name, { enabled })
                      .then(updated => onChanged(prev =>
                        (prev ?? []).map(s => s.name === updated.name ? updated : s)))
                      .catch(onError);
                  }} />
                </td>
                <td>{sub.poll_interval_seconds}s</td>
                <td className={sub.last_polled_at ? undefined : 'muted'}>
                  {sub.last_polled_at ? relTime(sub.last_polled_at, locale) : t('trkNever')}
                </td>
                <td>
                  {!sub.enabled
                    ? <span className="chip muted">—</span>
                    : sub.last_status
                      ? <span className={sub.last_status === 'ok' ? 'chip pos' : 'chip warn'}>{sub.last_status}</span>
                      : <span className="chip muted">—</span>}
                  {sub.consecutive_errors > 0 && (
                    <span className="chip neg" style={{ marginLeft: 6 }}>×{sub.consecutive_errors}</span>
                  )}
                </td>
                <td>
                  {sub.claimed_by
                    ? <span className="chip muted mono">{sub.claimed_by}</span>
                    : <span className="muted">—</span>}
                </td>
                <td>
                  <button className="btn icon sm" title={t('trkDeleteSub')} onClick={() => onDelete(sub)}>
                    <Icon name="trash" size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RuleModal({ rule, onClose, onSaved, onError }: {
  rule: TrackerRule | null;
  onClose: () => void;
  onSaved: (rule: TrackerRule) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(rule?.name ?? '');
  const [prompt, setPrompt] = useState(rule?.prompt ?? '');
  const [saving, setSaving] = useState(false);
  const canSave = name.trim() !== '' && prompt.trim() !== '';

  function save() {
    if (!canSave || saving) return;
    setSaving(true);
    const request = rule
      ? trackerApi.updateRule(rule.id, { name: name.trim(), prompt: prompt.trim() })
      : trackerApi.createRule({ name: name.trim(), prompt: prompt.trim() });
    request.then(onSaved).catch(onError).finally(() => setSaving(false));
  }

  return (
    <Modal onClose={onClose} ariaLabel={rule ? t('trkEditRule') : t('trkNewRule')} shellStyle={{ width: 520 }}>
      <div className="modal-head">
        <div className="modal-title">{rule ? t('trkEditRule') : t('trkNewRule')}</div>
      </div>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label className="label" htmlFor="trk-rule-name">{t('trkRuleName')}</label>
          <input id="trk-rule-name" className="input" value={name}
            onChange={e => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="trk-rule-prompt">{t('trkRulePrompt')}</label>
          <textarea id="trk-rule-prompt" className="textarea" rows={6} value={prompt}
            onChange={e => setPrompt(e.target.value)} />
          <span className="help">{t('trkRulePromptHelp')}</span>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary" disabled={!canSave || saving} onClick={save}>
          {t('save')}
        </button>
      </div>
    </Modal>
  );
}
