import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Skeleton } from '../../components/Skeleton';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  summarizeTrial,
  trackerApi,
  TRIAL_MIN_LABELLED,
  type AudienceScore,
  type PromptRole,
  type PromptStats,
  type PromptVersionStats,
  type TrialCell,
  type VsLive,
} from '../../lib/tracker';
import { ConfirmDialog } from './settings/dialogs';

// ─── Which prompt is better ───────────────────────────────────────────────────
// The tracker scores every prompt version by the leads its alerts drew (any
// reaction but 👎) and, while a candidate is on trial, sets its verdicts
// against the live prompt's on the same posts. This card puts that evidence
// first and the trial controls second: a prompt should be promoted on the
// numbers, not on how its wording reads.

// Reactions trickle in over hours; a minute is fresh enough.
const REFRESH_MS = 60_000;

type Window = '7d' | '30d' | 'all';
const WINDOWS: readonly Window[] = ['7d', '30d', 'all'];
const WINDOW_MS: Record<Exclude<Window, 'all'>, number> = { '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

const ROLE_CLASS: Record<PromptRole, string> = { live: 'ff-live', candidate: 'ff-stale', retired: 'fp-retired' };

// Live's verdict down the side, the candidate's across the top.
const CELLS: ReadonlyArray<{ key: keyof VsLive; live: boolean; candidate: boolean }> = [
  { key: 'both', live: true, candidate: true },
  { key: 'liveOnly', live: true, candidate: false },
  { key: 'candidateOnly', live: false, candidate: true },
  { key: 'neither', live: false, candidate: false },
];

type Props = {
  locale: string;
  onError: (err: unknown) => void;
  /** Promoting switches the rules off, so the page's rules list must reload. */
  onPromoted: () => void;
  showToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function PromptsCard({ locale, onError, onPromoted, showToast }: Props) {
  const { t } = useT();
  const [win, setWin] = useState<Window>('30d');
  const [data, setData] = useState<PromptStats | 'unavailable' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'edit' | 'end' | 'promote' | null>(null);

  const load = useCallback(() => {
    trackerApi.promptStats(win === 'all' ? null : new Date(Date.now() - WINDOW_MS[win]))
      .then(setData)
      .catch(() => setData('unavailable'));
  }, [win]);

  useEffect(() => {
    load();
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const stats = data && data !== 'unavailable' ? data : null;
  const candidate = stats?.config.candidate ?? null;
  const candidateVersion = stats?.versions.find(v => v.role === 'candidate');

  return (
    <section className="card rt-prompts" aria-label={t('trkPromptTitle')} aria-busy={!data}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{t('trkPromptTitle')}</h2>
          <span className="card-sub">{t('trkPromptSub')}</span>
        </div>
        <div className="seg" role="tablist" aria-label={t('trkPromptWindow')}>
          {WINDOWS.map(w => (
            <button key={w} type="button" role="tab" aria-selected={win === w}
              className={win === w ? 'active' : ''} onClick={() => setWin(w)}>
              {t(`trkPromptWindow_${w}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="card-body rt-prompts-body">
        {data === 'unavailable' && <p className="fp-muted rt-note">{t('trkPromptUnavailable')}</p>}

        {candidate && (
          <div className="rt-trial">
            <div className="fp-section-label">{t('trkTrialTitle')}</div>
            {candidateVersion?.vsLive
              ? <TrialGrid vs={candidateVersion.vsLive} locale={locale} />
              : <p className="fp-muted rt-note">{t('trkTrialWaiting')}</p>}
          </div>
        )}

        <VersionsTable stats={stats} loading={!data} locale={locale}
          open={open} onToggle={key => setOpen(o => (o === key ? null : key))} />

        {stats && stats.unmatchedReactions > 0 && (
          <span className="fp-muted rt-help">{t('trkPromptUnmatched', { n: stats.unmatchedReactions })}</span>
        )}

        {stats && (
          <div className="rt-prompts-actions">
            {candidate
              ? <>
                  <button className="btn ghost sm" onClick={() => setDialog('edit')}>
                    <Icon name="edit" size={13} />{t('trkEditTrial')}
                  </button>
                  <button className="btn ghost sm" onClick={() => setDialog('end')}>{t('trkEndTrial')}</button>
                  <button className="btn primary sm" onClick={() => setDialog('promote')}>{t('trkPromote')}</button>
                </>
              : <button className="btn primary sm" onClick={() => setDialog('edit')}>
                  <Icon name="plus" size={13} />{t('trkStartTrial')}
                </button>}
          </div>
        )}
      </div>

      {dialog === 'edit' && stats && (
        <CandidateModal
          prompt={candidate?.systemPrompt ?? ''}
          model={candidate && candidate.model !== stats.config.live.model ? candidate.model : ''}
          liveModel={stats.config.live.model}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            showToast?.(t('trkTrialSaved'));
            load();
          }}
          onError={onError}
        />
      )}

      {dialog === 'end' && (
        <ConfirmDialog
          title={t('trkEndTrial')}
          message={t('trkEndTrialMsg')}
          confirmLabel={t('trkEndTrial')}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            trackerApi.clearCandidate()
              .then(() => { showToast?.(t('trkTrialEnded')); load(); })
              .catch(onError)
              .finally(() => setDialog(null));
          }}
        />
      )}

      {dialog === 'promote' && stats && (
        <ConfirmDialog
          title={t('trkPromote')}
          message={t('trkPromoteMsg', { rules: stats.config.enabledRules })}
          confirmLabel={t('trkPromote')}
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            trackerApi.promoteCandidate()
              .then(() => { showToast?.(t('trkPromoted')); load(); onPromoted(); })
              .catch(onError)
              .finally(() => setDialog(null));
          }}
        />
      )}
    </section>
  );
}

function TrialGrid({ vs, locale }: { vs: VsLive; locale: string }) {
  const { t } = useT();
  const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const s = summarizeTrial(vs);
  return (
    <>
      <p className="rt-trial-verdict">
        {t('trkTrialVerdict', {
          labelled: fmt.format(s.labelled),
          junk: fmt.format(s.junkDropped),
          lost: fmt.format(s.leadsLost),
          gained: fmt.format(s.leadsGained),
        })}
        {s.junkAdded > 0 && <> {t('trkTrialJunkAdded', { n: fmt.format(s.junkAdded) })}</>}
      </p>
      {!s.enoughData && <p className="rt-trial-warn">{t('trkTrialTooFew', { n: TRIAL_MIN_LABELLED })}</p>}
      <div className="rt-trial-grid" role="table" aria-label={t('trkTrialTitle')}>
        <span />
        <span className="rt-trial-axis">{t('trkTrialCandAlerts')}</span>
        <span className="rt-trial-axis">{t('trkTrialCandRejects')}</span>
        {[true, false].map(live => (
          <Fragment key={String(live)}>
            <span className="rt-trial-axis rt-trial-side">{live ? t('trkTrialLiveAlerts') : t('trkTrialLiveRejects')}</span>
            {CELLS.filter(c => c.live === live).map(c => (
              <TrialCellView key={c.key} name={c.key} cell={vs[c.key]} fmt={fmt} />
            ))}
          </Fragment>
        ))}
      </div>
    </>
  );
}

function TrialCellView({ name, cell, fmt }: { name: keyof VsLive; cell: TrialCell; fmt: Intl.NumberFormat }) {
  const { t } = useT();
  return (
    <div className={`rt-trial-cell rt-trial-${name}`} role="cell">
      <b>{fmt.format(cell.posts)}</b>
      <span className="rt-trial-what">{t(`trkTrialCell_${name}`)}</span>
      {/* Posts neither prompt flagged were never sent, so nobody could react. */}
      {name !== 'neither' && (
        <span className="rt-trial-counts">{t('trkTrialCellCounts', { leads: cell.leads, notLeads: cell.notLeads })}</span>
      )}
    </div>
  );
}

// A configured prompt that hasn't judged a post has no version yet; it still
// gets a row, or a just-promoted or just-started prompt would be missing.
type Row = { key: string; role: PromptRole; model: string; systemPrompt: string; version: PromptVersionStats | null };

function rowsOf(stats: PromptStats): Row[] {
  const pending: Row[] = [];
  const { live, candidate } = stats.config;
  if (candidate && candidate.promptVersionId === null) {
    pending.push({ key: 'new-candidate', role: 'candidate', model: candidate.model, systemPrompt: candidate.systemPrompt, version: null });
  }
  if (live.promptVersionId === null) {
    pending.push({ key: 'new-live', role: 'live', model: live.model, systemPrompt: live.systemPrompt, version: null });
  }
  return [
    ...pending,
    ...stats.versions.map(v => ({ key: `v${v.id}`, role: v.role, model: v.model, systemPrompt: v.systemPrompt, version: v })),
  ];
}

function VersionsTable({ stats, loading, locale, open, onToggle }: {
  stats: PromptStats | null;
  loading: boolean;
  locale: string;
  open: string | null;
  onToggle: (key: string) => void;
}) {
  const { t } = useT();
  const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const pct = useMemo(() => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }), [locale]);
  // "3 of 14 (21%)": the count first, so a rate never reads as more evidence than it is.
  const ofN = (part: number, whole: number) => (whole > 0
    ? `${t('trkPromptOf', { x: fmt.format(part), n: fmt.format(whole) })} (${pct.format(part / whole)})`
    : '—');
  const devCell = (d: AudienceScore) => (d.sent > 0
    ? t('trkPromptDevCell', { leads: fmt.format(d.leads), notLeads: fmt.format(d.notLeads), n: fmt.format(d.sent) })
    : '—');
  const COLS = 6;

  return (
    <div className="fp-table-wrap">
      <table className="fp-table rt-versions">
        <thead>
          <tr>
            <th>{t('trkPromptColVersion')}</th>
            <th>{t('trkPromptColJudged')}</th>
            <th>{t('trkPromptColFlagged')}</th>
            <th title={t('trkPromptColBuyersHint')}>{t('trkPromptColBuyers')}</th>
            <th title={t('trkPromptColDevHint')}>{t('trkPromptColDev')}</th>
            <th>{t('trkPromptColUsed')}</th>
          </tr>
        </thead>
        <tbody>
          {loading && [0, 1].map(i => (
            <tr key={i} aria-hidden>
              {Array.from({ length: COLS }, (_, j) => <td key={j}><Skeleton width={j ? 60 : 140} height={12} /></td>)}
            </tr>
          ))}
          {stats && rowsOf(stats).map(({ key, role, model, systemPrompt, version: v }) => (
            <Fragment key={key}>
              <tr className={role === 'retired' ? 'rt-retired' : undefined}>
                <td>
                  <div className="rt-version-cell">
                    <button type="button" className="btn ghost sm rt-version" aria-expanded={open === key}
                      title={open === key ? t('trkPromptHide') : t('trkPromptShow')} onClick={() => onToggle(key)}>
                      <Icon name={open === key ? 'chevronDown' : 'chevronRight'} size={12} />
                      <b className="mono">{v ? `v${v.id}` : t('trkPromptNew')}</b>
                    </button>
                    <span className={`fp-chip ${ROLE_CLASS[role]}`}>{t(`trkPromptRole_${role}`)}</span>
                    <span className="mono fp-muted rt-model">{model}</span>
                  </div>
                </td>
                <td className="mono">{v ? fmt.format(v.evaluated) : '—'}</td>
                <td className="mono">{v ? ofN(v.targets, v.evaluated) : '—'}</td>
                <td className="mono">{v ? ofN(v.buyers.leads, v.buyers.sent) : '—'}</td>
                <td className="mono">{v ? devCell(v.dev) : '—'}</td>
                {v
                  ? <td title={`${v.firstUsedAt} – ${v.lastUsedAt}`}>{relTime(v.lastUsedAt, locale)}</td>
                  : <td className="fp-muted">{t('trkPromptNotYet')}</td>}
              </tr>
              {open === key && (
                <tr className="rt-version-prompt">
                  <td colSpan={COLS}><pre>{systemPrompt}</pre></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateModal({ prompt: initialPrompt, model: initialModel, liveModel, onClose, onSaved, onError }: {
  prompt: string;
  model: string;
  liveModel: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useT();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [model, setModel] = useState(initialModel);
  const [saving, setSaving] = useState(false);
  const canSave = prompt.trim() !== '';

  function save() {
    if (!canSave || saving) return;
    setSaving(true);
    trackerApi.setCandidate({ prompt: prompt.trim(), model: model.trim() })
      .then(onSaved).catch(onError).finally(() => setSaving(false));
  }

  const title = initialPrompt ? t('trkEditTrial') : t('trkStartTrial');
  return (
    <Modal onClose={onClose} ariaLabel={title} shellStyle={{ width: 640 }}>
      <div className="modal-head">
        <div className="modal-title">{title}</div>
      </div>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label className="label" htmlFor="trk-trial-prompt">{t('trkTrialPrompt')}</label>
          <textarea id="trk-trial-prompt" className="textarea mono" rows={14} value={prompt}
            onChange={e => setPrompt(e.target.value)} />
          <span className="help">{t('trkTrialPromptHelp')}</span>
        </div>
        <div className="field">
          <label className="label" htmlFor="trk-trial-model">{t('trkTrialModel')}</label>
          <input id="trk-trial-model" className="input mono" value={model} placeholder={liveModel}
            onChange={e => setModel(e.target.value)} />
          <span className="help">{t('trkTrialModelHelp', { model: liveModel })}</span>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary" disabled={!canSave || saving} onClick={save}>
          {initialPrompt ? t('save') : t('trkStartTrial')}
        </button>
      </div>
    </Modal>
  );
}
