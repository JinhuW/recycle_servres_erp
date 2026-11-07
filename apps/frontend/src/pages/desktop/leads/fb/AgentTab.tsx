import { useEffect, useMemo, useState } from 'react';
import type {
  FbAgentEvalRunDetail, FbAgentModule, FbAgentProfileRow, FbEvalCompare, FbShadowPair, ParamField, ParamSchema, RegistryEntry,
} from '@recycle-erp/shared';
import { Icon } from '../../../../components/Icon';
import { ModelPicker } from '../../../../components/ModelPicker';
import { TableSkeleton } from '../../../../components/Skeleton';
import { handleFetchError, showSuccessToast } from '../../../../lib/errorToast';
import { fbAgentApi, paramProblems, usePolled, type FbProfileEdit } from '../../../../lib/fbSeller';
import { useT } from '../../../../lib/i18n';
import { fbSellerThreadPath, hrefFor, onLinkClick } from '../../../../lib/route';
import { Ago, Empty, Money, Table } from './shared';
import { RunLine } from './ThreadView';

// The agent's setup as versions. A version is edited only while it is a
// draft; then it is promoted to candidate (it shadows the live agent on every
// real message, sending nothing) or straight to active. Shadow lays the two
// decisions side by side; Tests replays saved cases against a version and
// compares two runs.

type Sub = 'profiles' | 'shadow' | 'tests';
const STATE_TONE: Record<FbAgentProfileRow['state'], string> = { draft: 'muted', candidate: 'info', active: 'pos', retired: 'cool' };

export function AgentTab() {
  const { t } = useT();
  const [sub, setSub] = useState<Sub>('profiles');
  const profiles = usePolled(() => fbAgentApi.profiles(), null, []);
  const registry = usePolled(() => fbAgentApi.registry(), null, []);
  const rows = profiles.data?.rows ?? null;
  return (
    <>
      <div className="fbs-tools">
        <div className="seg" role="group" aria-label={t('fbs_tab_agent')}>
          {(['profiles', 'shadow', 'tests'] as const).map(s => (
            <button key={s} className={sub === s ? 'active' : ''} aria-pressed={sub === s} onClick={() => setSub(s)}>{t(`fbs_agent_${s}`)}</button>
          ))}
        </div>
      </div>
      {!rows ? <TableSkeleton rows={4} cols={4} />
        : sub === 'profiles' ? <Profiles rows={rows} registry={registry.data} onChanged={() => void profiles.reload()} />
        : sub === 'shadow' ? <Shadow rows={rows} />
        : <Tests rows={rows} />}
    </>
  );
}

export const profileLabel = (p: Pick<FbAgentProfileRow, 'name' | 'version'>) => `${p.name} v${p.version}`;

function StateChip({ state }: { state: FbAgentProfileRow['state'] }) {
  const { t } = useT();
  return <span className={`chip ${STATE_TONE[state]}`}>{t(`fbs_pstate_${state}`)}</span>;
}

// ─── Profiles ─────────────────────────────────────────────────────────────────

function Profiles({ rows, registry, onChanged }: {
  rows: FbAgentProfileRow[]; registry: { rules: RegistryEntry[]; skills: RegistryEntry[] } | null; onChanged: () => void;
}) {
  const { t } = useT();
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => { if (picked === null && rows.length) setPicked((rows.find(r => r.state === 'draft') ?? rows.find(r => r.state === 'active') ?? rows[0]).id); }, [rows, picked]);
  const p = rows.find(r => r.id === picked) ?? null;
  const [busy, setBusy] = useState(false);
  const act = async (call: () => Promise<FbAgentProfileRow>, toast: string) => {
    setBusy(true);
    try { const r = await call(); onChanged(); setPicked(r.id); showSuccessToast(toast); } catch (e) { handleFetchError(e); } finally { setBusy(false); }
  };

  return (
    <div className="fbs-split">
      <div className="card fbs-list">
        {rows.map(r => (
          <button key={r.id} className={`fbs-list-item${picked === r.id ? ' on' : ''}`} onClick={() => setPicked(r.id)}>
            <b>{profileLabel(r)} <StateChip state={r.state} /></b>
            <span className="rl-sub">{r.notes || t('fbs_no_notes')}</span>
            <span className="rl-sub">{r.based_on ? t('fbs_based_on', { n: rows.find(x => x.id === r.based_on)?.version ?? r.based_on }) : t('fbs_seeded')} · <Ago at={r.created_at} /></span>
          </button>
        ))}
      </div>
      <div className="fbs-main">
        {p && (
          <>
            <div className="fbs-buttons">
              {p.state === 'draft' && <>
                <button className="btn" disabled={busy} onClick={() => void act(() => fbAgentApi.promote(p.id, 'candidate'), t('fbs_promoted_candidate'))} title={t('fbs_promote_candidate_hint')}>{t('fbs_promote_candidate')}</button>
                <button className="btn primary" disabled={busy} onClick={() => void act(() => fbAgentApi.promote(p.id, 'active'), t('fbs_promoted_active'))}>{t('fbs_promote_active')}</button>
              </>}
              {p.state === 'candidate' && <button className="btn primary" disabled={busy} onClick={() => void act(() => fbAgentApi.promote(p.id, 'active'), t('fbs_promoted_active'))}>{t('fbs_promote_active')}</button>}
              {p.state === 'retired' && <button className="btn" disabled={busy} onClick={() => void act(() => fbAgentApi.promote(p.id, 'active'), t('fbs_rolled_back'))} title={t('fbs_roll_back_hint')}>{t('fbs_roll_back')}</button>}
              <button className="btn" disabled={busy} onClick={() => void act(() => fbAgentApi.draft(p.id), t('fbs_draft_made'))}><Icon name="copy" size={13} />{t('fbs_new_draft')}</button>
              {p.state !== 'active' && p.state !== 'retired' && <button className="btn ghost" disabled={busy} onClick={() => void act(() => fbAgentApi.retire(p.id), t('fbs_retired_toast'))}>{t('fbs_retire')}</button>}
            </div>
            <ProfileEditor key={`${p.id}:${p.state}`} p={p} registry={registry} onSaved={onChanged} />
          </>
        )}
      </div>
    </div>
  );
}

function ProfileEditor({ p, registry, onSaved }: { p: FbAgentProfileRow; registry: { rules: RegistryEntry[]; skills: RegistryEntry[] } | null; onSaved: () => void }) {
  const { t } = useT();
  const editable = p.state === 'draft';
  const [e, setE] = useState<Required<FbProfileEdit>>({ prompts: p.prompts, skills: p.skills, rules: p.rules, models: p.models, notes: p.notes });
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(e) !== JSON.stringify({ prompts: p.prompts, skills: p.skills, rules: p.rules, models: p.models, notes: p.notes });
  const schemaOf = (list: RegistryEntry[] | undefined, kind: string) => list?.find(x => x.kind === kind)?.params ?? null;
  const problems = useMemo(() => [
    ...e.skills.flatMap(m => paramProblems(m.params, schemaOf(registry?.skills, m.kind)).map(x => `${m.kind}.${x}`)),
    ...e.rules.flatMap(m => paramProblems(m.params, schemaOf(registry?.rules, m.kind)).map(x => `${m.kind}.${x}`)),
    ...(!e.models.extract.trim() || !e.models.reply.trim() ? ['models'] : []),
  ], [e, registry]);

  const save = async () => {
    setBusy(true);
    try { await fbAgentApi.patchProfile(p.id, e); showSuccessToast(t('fbs_saved')); onSaved(); } catch (err) { handleFetchError(err); } finally { setBusy(false); }
  };
  const setModule = (which: 'skills' | 'rules', i: number, m: FbAgentModule) => setE(x => ({ ...x, [which]: x[which].map((y, j) => (j === i ? m : y)) }));
  const move = (i: number, d: -1 | 1) => setE(x => {
    const rules = [...x.rules];
    const j = i + d;
    if (j < 0 || j >= rules.length) return x;
    [rules[i], rules[j]] = [rules[j], rules[i]];
    return { ...x, rules };
  });

  return (
    <fieldset className="fbs-profile" disabled={!editable || busy}>
      {!editable && <p className="help">{t('fbs_profile_locked')}</p>}
      <div className="card fbs-panel">
        <h3>{t('fbs_models')}</h3>
        <div className="fbs-form">
          <label className="field"><span className="label">{t('fbs_model_extract')}</span>
            <ModelPicker value={e.models.extract} onChange={v => setE(x => ({ ...x, models: { ...x.models, extract: v } }))} invalid={!e.models.extract.trim()} /></label>
          <label className="field"><span className="label">{t('fbs_model_reply')}</span>
            <ModelPicker value={e.models.reply} onChange={v => setE(x => ({ ...x, models: { ...x.models, reply: v } }))} invalid={!e.models.reply.trim()} /></label>
          <label className="field fbs-wide"><span className="label">{t('fbs_notes')}</span>
            <input className="input" value={e.notes} onChange={ev => setE(x => ({ ...x, notes: ev.target.value }))} /></label>
        </div>
      </div>

      <div className="card fbs-panel">
        <h3>{t('fbs_prompts')}</h3>
        <label className="field"><span className="label">{t('fbs_prompt_system')}</span>
          <textarea className="input fbs-prompt" rows={6} value={e.prompts.system} onChange={ev => setE(x => ({ ...x, prompts: { ...x.prompts, system: ev.target.value } }))} /></label>
        <label className="field"><span className="label">{t('fbs_prompt_extract')}</span>
          <textarea className="input fbs-prompt" rows={4} value={e.prompts.extract} onChange={ev => setE(x => ({ ...x, prompts: { ...x.prompts, extract: ev.target.value } }))} /></label>
        <p className="help">{t('fbs_prompt_offer_hint')}</p>
      </div>

      <div className="card fbs-panel">
        <h3>{t('fbs_skills')}</h3>
        <p className="help">{t('fbs_skills_hint')}</p>
        {e.skills.map((m, i) => {
          const reg = registry?.skills.find(x => x.kind === m.kind);
          return (
            <div key={m.kind} className="fbs-module">
              <label className="fbs-check"><input type="checkbox" checked={m.enabled} onChange={ev => setModule('skills', i, { ...m, enabled: ev.target.checked })} />
                <b>{reg?.label ?? m.kind}</b> <span className="mono rl-muted">{m.kind}</span></label>
              <label className="field"><span className="label">{t('fbs_prompt_skill')}</span>
                <textarea className="input fbs-prompt" rows={3} value={e.prompts.skills[m.kind] ?? ''}
                  onChange={ev => setE(x => ({ ...x, prompts: { ...x.prompts, skills: { ...x.prompts.skills, [m.kind]: ev.target.value } } }))} /></label>
              <ParamsForm schema={reg?.params ?? null} params={m.params} onChange={params => setModule('skills', i, { ...m, params })} />
            </div>
          );
        })}
      </div>

      <div className="card fbs-panel">
        <h3>{t('fbs_rules')}</h3>
        <p className="help">{t('fbs_rules_hint')}</p>
        <ol className="fbs-rules">
          {e.rules.map((m, i) => {
            const reg = registry?.rules.find(x => x.kind === m.kind);
            return (
              <li key={m.kind} className="fbs-module">
                <div className="rl-between">
                  <label className="fbs-check"><input type="checkbox" checked={m.enabled} onChange={ev => setModule('rules', i, { ...m, enabled: ev.target.checked })} />
                    <b>{reg?.label ?? m.kind}</b> <span className="mono rl-muted">{m.kind}</span></label>
                  <span>
                    <button type="button" className="btn ghost icon sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('fbs_move_up')}><Icon name="arrowUp" size={13} /></button>
                    <button type="button" className="btn ghost icon sm" onClick={() => move(i, 1)} disabled={i === e.rules.length - 1} aria-label={t('fbs_move_down')}><Icon name="arrowDown" size={13} /></button>
                  </span>
                </div>
                <ParamsForm schema={reg?.params ?? null} params={m.params} onChange={params => setModule('rules', i, { ...m, params })} />
              </li>
            );
          })}
        </ol>
      </div>

      {editable && (
        <div className="fbs-savebar">
          {problems.length > 0 && <span className="fbs-error">{t('fbs_profile_problems', { list: problems.join(', ') })}</span>}
          <button type="button" className="btn ghost" disabled={!dirty || busy} onClick={() => setE({ prompts: p.prompts, skills: p.skills, rules: p.rules, models: p.models, notes: p.notes })}>{t('fbs_discard')}</button>
          <button type="button" className="btn primary" disabled={!dirty || busy || problems.length > 0} onClick={() => void save()}>{t('fbs_save')}</button>
        </div>
      )}
    </fieldset>
  );
}

/** A rule's or skill's params as a form, from the registry's schema. */
export function ParamsForm({ schema, params, onChange }: { schema: ParamSchema | null; params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const { t } = useT();
  if (!schema) return Object.keys(params).length ? <p className="help mono">{JSON.stringify(params)}</p> : null;
  const entries = Object.entries(schema.properties);
  if (!entries.length) return null;
  const set = (k: string, v: unknown) => onChange({ ...params, [k]: v });
  return (
    <div className="fbs-form fbs-params">
      {entries.map(([k, f]) => <ParamInput key={k} name={k} f={f} value={params[k] ?? f.default} onChange={v => set(k, v)} t={t} />)}
    </div>
  );
}

function ParamInput({ name, f, value, onChange, t }: { name: string; f: ParamField; value: unknown; onChange: (v: unknown) => void; t: ReturnType<typeof useT>['t'] }) {
  if (f.type === 'boolean') {
    return <label className="fbs-check"><input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />{f.label}</label>;
  }
  if (f.type === 'array') {
    const list = Array.isArray(value) ? (value as string[]) : [];
    if (f.items.enum) {
      return (
        <div className="field fbs-wide"><span className="label">{f.label}</span>
          <div className="fbs-checks">
            {f.items.enum.map(opt => (
              <label key={opt} className="fbs-check"><input type="checkbox" checked={list.includes(opt)}
                onChange={e => onChange(e.target.checked ? [...list, opt] : list.filter(x => x !== opt))} /><span className="mono">{opt}</span></label>
            ))}
          </div>
        </div>
      );
    }
    return (
      <label className="field fbs-wide"><span className="label">{f.label}</span>
        <textarea className="input mono" rows={Math.min(6, Math.max(2, list.length + 1))} value={list.join('\n')}
          onChange={e => onChange(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))} />
        <span className="help">{t('fbs_one_per_line')}</span></label>
    );
  }
  if (f.type === 'string') {
    return <label className="field"><span className="label">{f.label}</span><input className="input" value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value)} /></label>;
  }
  const n = typeof value === 'number' ? value : Number.NaN;
  return (
    <label className="field"><span className="label">{f.label}</span>
      <input className="input" type="number" step={f.type === 'integer' ? 1 : 'any'} min={f.minimum} max={f.maximum} value={Number.isFinite(n) ? n : ''}
        onChange={e => onChange(e.target.value === '' ? null : e.target.valueAsNumber)} data-param={name} />
      {(f.minimum !== undefined || f.maximum !== undefined) && <span className="help">{t('fbs_param_range', { min: f.minimum ?? '—', max: f.maximum ?? '—' })}</span>}
    </label>
  );
}

// ─── Shadow ───────────────────────────────────────────────────────────────────

function Shadow({ rows }: { rows: FbAgentProfileRow[] }) {
  const { t } = useT();
  const candidate = rows.find(r => r.state === 'candidate') ?? null;
  const [pid, setPid] = useState<number | null>(candidate?.id ?? null);
  const { data } = usePolled(() => fbAgentApi.shadow(pid), 60_000, [pid]);
  return (
    <>
      <div className="fbs-tools">
        <select className="input" value={pid ?? ''} onChange={e => setPid(e.target.value ? Number(e.target.value) : null)} aria-label={t('fbs_shadow_profile')}>
          <option value="">{t('fbs_shadow_any')}</option>
          {rows.map(r => <option key={r.id} value={r.id}>{profileLabel(r)} · {t(`fbs_pstate_${r.state}`)}</option>)}
        </select>
        {!candidate && <span className="help">{t('fbs_shadow_no_candidate')}</span>}
      </div>
      {!data ? <TableSkeleton rows={3} cols={3} /> : !data.rows.length ? <Empty><p>{t('fbs_shadow_empty')}</p></Empty> : (
        <Table head={<><th>{t('fbs_shadow_trigger')}</th><th>{t('fbs_shadow_live')}</th><th>{t('fbs_shadow_candidate')}</th></>}>
          {data.rows.map((s, i) => <ShadowRow key={s.shadow.id ?? i} s={s} />)}
        </Table>
      )}
    </>
  );
}

/** Whether the candidate would have done something different from the live agent. */
export function shadowDiffers(s: Pick<FbShadowPair, 'live' | 'shadow'>): boolean {
  const a = s.live?.decision;
  const b = s.shadow.decision;
  if (!a || !b) return s.live?.outcome !== s.shadow.outcome;
  return a.outcome !== b.outcome || a.offer?.offer_usd !== b.offer?.offer_usd || a.reply !== b.reply || a.stage !== b.stage;
}

function ShadowRow({ s }: { s: FbShadowPair }) {
  const { t } = useT();
  const href = s.thread_id !== null ? fbSellerThreadPath(s.thread_id) : null;
  return (
    <tr className={shadowDiffers(s) ? 'fbs-differs' : undefined}>
      <td className="fbs-trigger">
        {href ? <a className="rl-link" href={hrefFor(href)} onClick={onLinkClick(href)}>{t('fbs_thread_n', { n: s.thread_id! })}</a> : <span className="rl-muted">—</span>}
        <p>“{s.trigger_body ?? '—'}”</p>
        <Ago at={s.created_at} />
      </td>
      <td>{s.live ? <ul className="fbs-runs"><RunLine r={s.live} /></ul> : <span className="rl-muted">{t('fbs_shadow_no_live')}</span>}
        {s.live?.decision?.offer && <p className="rl-sub">{t('fbs_col_offer')}: <Money usd={s.live.decision.offer.offer_usd} /></p>}</td>
      <td><ul className="fbs-runs"><RunLine r={s.shadow} /></ul>
        {s.shadow.decision?.offer && <p className="rl-sub">{t('fbs_col_offer')}: <Money usd={s.shadow.decision.offer.offer_usd} /></p>}
        {shadowDiffers(s) && <span className="chip warn">{t('fbs_shadow_differs')}</span>}</td>
    </tr>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

function Tests({ rows }: { rows: FbAgentProfileRow[] }) {
  const { t } = useT();
  const cases = usePolled(() => fbAgentApi.cases(), null, []);
  const runs = usePolled(() => fbAgentApi.evals(), 10_000, []);
  const [profileId, setProfileId] = useState<number>(() => (rows.find(r => r.state === 'candidate') ?? rows.find(r => r.state === 'draft') ?? rows[0]).id);
  const [open, setOpen] = useState<number | null>(null);
  const [pair, setPair] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const byId = new Map(rows.map(r => [r.id, r]));

  const run = async () => {
    setBusy(true);
    try { const r = await fbAgentApi.runEval(profileId); showSuccessToast(t('fbs_eval_started')); setOpen(r.id); void runs.reload(); } catch (e) { handleFetchError(e); } finally { setBusy(false); }
  };
  const archive = async (id: number) => {
    try { await fbAgentApi.archiveCase(id); void cases.reload(); } catch (e) { handleFetchError(e); }
  };

  return (
    <>
      <section className="fbs-section">
        <div className="rl-between fbs-section-head">
          <h3>{t('fbs_cases', { n: cases.data?.rows.length ?? 0 })}</h3>
        </div>
        {!cases.data ? <TableSkeleton rows={2} cols={4} /> : !cases.data.rows.length ? <Empty><p>{t('fbs_cases_empty')}</p></Empty> : (
          <Table head={<><th>{t('fbs_case_name')}</th><th>{t('fbs_case_expect')}</th><th>{t('fbs_case_source')}</th><th>{t('fbs_col_updated')}</th><th className="rl-act" /></>}>
            {cases.data.rows.map(c => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.expected.handoff ? t('fbs_expect_handoff', { kind: c.expected.reason_kind ?? '—' }) : t('fbs_expect_reply')}
                  {c.expected.max_offer_usd !== undefined && <span className="rl-sub">{t('fbs_expect_max_offer', { usd: c.expected.max_offer_usd })}</span>}
                  {c.expected.must_not_contain?.length ? <span className="rl-sub">{t('fbs_expect_banned', { list: c.expected.must_not_contain.join(', ') })}</span> : null}</td>
                <td>{c.source_thread_id !== null
                  ? <a className="rl-link" href={hrefFor(fbSellerThreadPath(c.source_thread_id))} onClick={onLinkClick(fbSellerThreadPath(c.source_thread_id))}>{t('fbs_thread_n', { n: c.source_thread_id })}</a>
                  : <span className="rl-muted">{t('fbs_case_written')}</span>}</td>
                <td><Ago at={c.created_at} /></td>
                <td className="rl-act"><button className="btn sm ghost" onClick={() => void archive(c.id)}>{t('fbs_archive')}</button></td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="fbs-section">
        <div className="rl-between fbs-section-head">
          <h3>{t('fbs_evals')}</h3>
          <div className="rl-actions">
            <select className="input" value={profileId} onChange={e => setProfileId(Number(e.target.value))} aria-label={t('fbs_eval_profile')}>
              {rows.map(r => <option key={r.id} value={r.id}>{profileLabel(r)} · {t(`fbs_pstate_${r.state}`)}</option>)}
            </select>
            <button className="btn primary" disabled={busy || !cases.data?.rows.length} onClick={() => void run()}><Icon name="zap" size={13} />{t('fbs_eval_run')}</button>
            <button className="btn" disabled={pair.length !== 2} onClick={() => setOpen(-1)} title={t('fbs_compare_hint')}>{t('fbs_compare')}</button>
          </div>
        </div>
        {!runs.data ? <TableSkeleton rows={2} cols={6} /> : !runs.data.rows.length ? <Empty><p>{t('fbs_evals_empty')}</p></Empty> : (
          <Table head={<><th className="fbs-dotcol" aria-label={t('fbs_compare')} /><th>{t('fbs_eval_profile')}</th><th>{t('fbs_col_state')}</th>
            <th className="rl-num">{t('fbs_eval_passed')}</th><th className="rl-num">{t('fbs_eval_failed')}</th><th className="rl-num">{t('fbs_eval_cost')}</th><th>{t('fbs_col_updated')}</th></>}>
            {runs.data.rows.map(r => (
              <tr key={r.id} className={open === r.id ? 'rl-picked' : undefined}>
                <td className="fbs-dotcol"><input type="checkbox" aria-label={t('fbs_compare_pick')} checked={pair.includes(r.id)}
                  onChange={e => setPair(x => (e.target.checked ? [...x, r.id].slice(-2) : x.filter(y => y !== r.id)))} /></td>
                <td><button className="rl-link" onClick={() => setOpen(r.id)}>{byId.get(r.profile_id) ? profileLabel(byId.get(r.profile_id)!) : `#${r.profile_id}`}</button></td>
                <td><span className={`chip ${r.state === 'done' ? 'pos' : r.state === 'failed' ? 'neg' : 'info'}`}>{t(`fbs_run_${r.state}`)}</span></td>
                <td className="rl-num">{r.passed}/{r.cases}</td>
                <td className="rl-num">{r.failed ? <b className="fbs-error">{r.failed}</b> : 0}</td>
                <td className="rl-num">${r.cost_usd.toFixed(4)}</td>
                <td><Ago at={r.finished_at ?? r.created_at} /></td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {open === -1 && pair.length === 2 && <CompareView a={pair[0]} b={pair[1]} labelOf={id => { const p = byId.get(id); return p ? profileLabel(p) : `#${id}`; }} />}
      {open !== null && open > 0 && <EvalDetail key={open} id={open} />}
    </>
  );
}

function EvalDetail({ id }: { id: number }) {
  const { t } = useT();
  const { data } = usePolled(() => fbAgentApi.evalRun(id), 5_000, [id]);
  if (!data) return <TableSkeleton rows={3} cols={4} />;
  return <EvalResults d={data} title={t('fbs_eval_detail', { profile: profileLabel(data.profile) })} />;
}

export function EvalResults({ d, title }: { d: FbAgentEvalRunDetail; title: string }) {
  const { t } = useT();
  return (
    <section className="fbs-section">
      <h3>{title}</h3>
      {d.error && <p className="fbs-error">{d.error}</p>}
      <Table head={<><th>{t('fbs_case_name')}</th><th>{t('fbs_eval_result')}</th><th>{t('fbs_eval_decision')}</th><th>{t('fbs_eval_why')}</th></>}>
        {d.results.map(r => (
          <tr key={r.case_id}>
            <td>{r.case_name}</td>
            <td>{r.passed === null ? <span className="chip info">{t(`fbs_run_${r.state}`)}</span>
              : <span className={`chip ${r.passed ? 'pos' : 'neg'}`}>{t(r.passed ? 'fbs_pass' : 'fbs_fail')}</span>}</td>
            <td>{r.decision ? <>{t(`fbs_outcome_${r.decision.outcome}`)}{r.decision.offer && <> · <Money usd={r.decision.offer.offer_usd} /></>}
              {r.decision.handoff_reason && <span className="rl-sub">{r.decision.handoff_reason}</span>}
              {r.decision.reply && <span className="rl-sub">“{r.decision.reply}”</span>}</> : <span className="rl-muted">—</span>}</td>
            <td>{r.error ? <span className="fbs-error">{r.error}</span> : r.why.length ? r.why.map((w, i) => <p key={i} className="fbs-fired">{w}</p>) : <span className="rl-muted">—</span>}</td>
          </tr>
        ))}
      </Table>
    </section>
  );
}

function CompareView({ a, b, labelOf }: { a: number; b: number; labelOf: (profileId: number) => string }) {
  const { t } = useT();
  const { data } = usePolled<FbEvalCompare>(() => fbAgentApi.compare(a, b), null, [a, b]);
  if (!data) return <TableSkeleton rows={3} cols={4} />;
  const side = (s: FbEvalCompare['rows'][number]['a']) => !s ? <span className="rl-muted">{t('fbs_compare_absent')}</span> : (
    <>
      <span className={`chip ${s.passed === null ? 'info' : s.passed ? 'pos' : 'neg'}`}>{s.passed === null ? '—' : t(s.passed ? 'fbs_pass' : 'fbs_fail')}</span>{' '}
      {s.handoff ? t('fbs_expect_handoff', { kind: s.reason_kind ?? '—' }) : t('fbs_expect_reply')}
      {s.offer_usd !== null && <> · <Money usd={s.offer_usd} /></>}
      {s.reply && <span className="rl-sub">“{s.reply}”</span>}
    </>
  );
  return (
    <section className="fbs-section">
      <h3>{t('fbs_compare_title', { a: labelOf(data.a.profile_id), b: labelOf(data.b.profile_id), n: data.changed })}</h3>
      <Table head={<><th>{t('fbs_case_name')}</th><th>{t('fbs_compare_a', { label: labelOf(data.a.profile_id) })}</th><th>{t('fbs_compare_b', { label: labelOf(data.b.profile_id) })}</th><th>{t('fbs_compare_changes')}</th></>}>
        {data.rows.map(r => (
          <tr key={r.case_id} className={r.changed ? 'fbs-differs' : undefined}>
            <td>{r.case_name}</td><td>{side(r.a)}</td><td>{side(r.b)}</td>
            <td>{r.changes.length ? r.changes.map((c, i) => <p key={i} className="fbs-fired">{c}</p>) : <span className="rl-muted">{t('fbs_compare_same')}</span>}</td>
          </tr>
        ))}
      </Table>
    </section>
  );
}
