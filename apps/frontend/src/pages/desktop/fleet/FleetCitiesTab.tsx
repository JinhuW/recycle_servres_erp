import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { TableSkeleton } from '../../../components/Skeleton';
import { ApiError } from '../../../lib/api';
import { fleetApi, fleetErrorCode, type FleetCity, type FleetItem, type FleetSettings, type FleetSlot, type FleetTask } from '../../../lib/fleet';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import {
  CITY_BUCKETS, cityBucket, cityRegions, cityStanding, EMPTY_CITY_FILTER, easternClock, filterCities, homeWorkerOf, isSlug, lastDoneSearch,
  marketplaceUrl, normalizeSlug, openSearch, withCityNames, type CityBucket, type CityFilter,
} from './fleetBoard';
import { agoLabel, ConfirmDialogBody, EmptyRow, Legend, UnavailableCard, useFleetMirror, useFleetPoll, WorkerLink } from './shared';

// ─── Cities ───────────────────────────────────────────────────────────────────
// The catalog the queue works from. A new city starts disabled with a
// verify-slug task: a worker opens its Marketplace page and reports the
// location label Facebook shows, because a wrong slug searches the account's
// own area in silence. It is enabled once verified, or by hand with "Enable
// anyway" (or "Skip the check" while the worker has not reported). Removing a
// city disables it and cancels its waiting tasks. The legend, a region select
// and a search box narrow the table; verifying cities come first, each with
// an inline row that says where its check stands. Per item a cell gives the
// last search (time, cards, alerts) and the open task. The Rules dialog
// holds the fleet-wide settings.

const DEFAULT_RADIUS_KM = 500;
const PER_DAY_CHOICES = [1, 2, 3, 4, 6] as const;
// The finished searches the per-item cells read cards and alerts from.
const DONE_HOURS = 48;

const BUCKET_CHIP: Record<CityBucket, string> = {
  verifying: 'chip info fleet-verifying', enabled: 'chip pos', disabled: 'chip muted',
};
const BUCKET_KEY: Record<CityBucket | 'all', string> = {
  all: 'fleetSegAll', verifying: 'fleetCityVerifying', enabled: 'fleetCityEnabled', disabled: 'fleetCityDisabled',
};
const BUCKET_DOT: Record<CityBucket | 'all', string> = {
  all: 'fleet-dot-all', enabled: 'fleet-dot-pos', verifying: 'fleet-dot-info', disabled: 'fleet-dot-all',
};

type Data = { cities: FleetCity[]; items: FleetItem[]; done: FleetTask[]; slots: FleetSlot[] };

export function FleetCitiesTab() {
  const { t } = useT();
  const mirror = useFleetMirror();
  const { data, reload } = useFleetPoll<Data>(() => {
    const since = new Date(Date.now() - DONE_HOURS * 3_600_000).toISOString();
    return Promise.all([
      fleetApi.cities(), fleetApi.items(), fleetApi.tasks({ state: 'done', since }),
      // The slots say which worker calls a city home; the table stands without them.
      fleetApi.slots().catch(() => []),
    ]).then(([cities, items, done, slots]) => ({ cities, items, done: withCityNames(done, cities), slots }));
  });
  const [adding, setAdding] = useState(false);
  const [rules, setRules] = useState(false);
  const [filter, setFilter] = useState<CityFilter>(EMPTY_CITY_FILTER);

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const items = data?.items.filter(i => i.enabled).map(i => i.name) ?? [];
  const cities = data?.cities ?? [];
  const by = (b: CityBucket) => cities.filter(c => cityBucket(c) === b).length;

  return (
    <div className="fp-pool">
      <div className="fleet-tab-head">
        <p className="fleet-lede">
          {data ? t('fleetCitiesLede', { n: cities.length, searched: by('enabled'), verifying: by('verifying'), off: by('disabled') }) : ''}
        </p>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setRules(true)} disabled={!data}>{t('fleetRules')}</button>
          {!mirror && <button type="button" className="btn primary" onClick={() => setAdding(true)} disabled={!data}>{t('fleetCityAdd')}</button>}
        </div>
      </div>
      <section className="card fleet-card" aria-label={t('fleetCitiesTitle')}>
        {data === null ? <TableSkeleton rows={6} cols={8} />
          : <CitiesTable cities={cities} items={items} done={data.done} slots={data.slots} filter={filter} onFilter={setFilter} onChanged={reload} />}
      </section>
      {adding && data && (
        <AddCityDialog cities={cities} onClose={() => setAdding(false)} onChanged={reload} />
      )}
      {rules && <RulesDialog onClose={() => setRules(false)} />}
    </div>
  );
}

export function CitiesTable({ cities, items, done, slots, filter, onFilter, onChanged, now = Date.now() }: {
  cities: readonly FleetCity[]; items: readonly string[]; done: readonly FleetTask[]; slots: readonly FleetSlot[];
  filter: CityFilter; onFilter: (f: CityFilter) => void; onChanged: () => void; now?: number;
}) {
  const { t, locale } = useT();
  const mirror = useFleetMirror();
  const [removing, setRemoving] = useState<FleetCity | null>(null);
  const [unverified, setUnverified] = useState<FleetCity | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cols = 6 + items.length;
  const shown = useMemo(() => filterCities(cities, filter), [cities, filter]);
  const regions = useMemo(() => cityRegions(cities), [cities]);
  const counts = useMemo(() => {
    const out = { all: cities.length, verifying: 0, enabled: 0, disabled: 0 };
    for (const c of cities) out[cityBucket(c)] += 1;
    return out;
  }, [cities]);
  const set = (patch: Partial<CityFilter>) => onFilter({ ...filter, ...patch });

  const act = async (slug: string, run: () => Promise<unknown>, doneToast?: string, refused?: (e: unknown) => boolean) => {
    if (busy) return;
    setBusy(slug);
    try {
      await run();
      if (doneToast) showSuccessToast(doneToast);
      onChanged();
    } catch (e) {
      if (!refused?.(e)) handleFetchError(e);
    } finally {
      setBusy(null);
    }
  };
  // A pair a worker is searching right now answers 409 exists; that item is
  // already being done, so only the other refusals count.
  const searchNow = (c: FleetCity) =>
    act(c.slug, async () => {
      const out = await Promise.allSettled(items.map(item => fleetApi.searchNow(c.slug, item)));
      const failed = out.find((r): r is PromiseRejectedResult => r.status === 'rejected' && fleetErrorCode(r.reason) !== 'exists');
      if (failed) throw failed.reason;
    }, t('fleetSearchNowDone', { city: c.name }));
  const setPerDay = (c: FleetCity, v: string) => act(c.slug, () => fleetApi.updateCity(c.slug, { per_day: v === '' ? null : Number(v) }));
  const enableAnyway = (c: FleetCity) =>
    act(c.slug, () => fleetApi.updateCity(c.slug, { enabled: true, override_verify: true }), t('fleetCityEnabledToast', { city: c.name }));
  // A city removed before a worker verified its slug is refused with 409
  // unverified; the manager is then asked whether to vouch for it.
  const restore = (c: FleetCity) =>
    act(c.slug, () => fleetApi.updateCity(c.slug, { enabled: true }), t('fleetCityEnabledToast', { city: c.name }), e => {
      if (fleetErrorCode(e) !== 'unverified') return false;
      setUnverified(c);
      return true;
    });

  // Per item: when the city was last searched (with the cards and alerts of
  // that search where the task is in the window) and what is open on it.
  const itemCell = (c: FleetCity, item: string) => {
    const open = openSearch(c, item);
    const last = lastDoneSearch(done, c.slug, item);
    const lastAt = c.last_done_at[item] ?? last?.done_at ?? null;
    if (!open && !lastAt) return <span className="fp-muted">—</span>;
    return (
      <span className="fp-holder">
        {lastAt ? (
          <span>
            {easternClock(lastAt, locale, now)}
            {last && last.done_at === lastAt && <small className="mono"> {t('fleetResultCards', { n: last.result?.cards ?? 0 })}{last.result?.alerted ? `, ${t('fleetResultAlerts', { n: last.result.alerted })}` : ''}</small>}
          </span>
        ) : <small>{t('fleetNeverSearched')}</small>}
        {open?.state === 'leased' && <span className="chip info"><span className="mono">{open.worker_id}</span></span>}
        {open?.state === 'ready' && Date.parse(open.due_at) <= now && <span className="chip warn">{t('fleetDueWaiting', { span: agoLabel(t, open.due_at, now) })}</span>}
        {open?.state === 'ready' && Date.parse(open.due_at) > now && <small>{t('fleetNextAt', { time: easternClock(open.due_at, locale, now) })}</small>}
      </span>
    );
  };

  return (
    <>
      <div className="fp-toolbar fleet-toolbar">
        <Legend buckets={CITY_BUCKETS} counts={counts} value={filter.bucket} onChange={bucket => set({ bucket })}
          label={k => t(BUCKET_KEY[k])} dotClass={k => BUCKET_DOT[k]} />
        <select className="input fleet-select" value={filter.region} aria-label={t('fleetColRegion')} onChange={e => set({ region: e.target.value })}>
          <option value="">{t('fleetEveryRegion')}</option>
          {regions.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={filter.q} autoComplete="off" placeholder={t('fleetSearchCities')}
            aria-label={t('fleetSearchCities')} onChange={e => set({ q: e.target.value })} />
        </label>
      </div>
      <div className="fp-table-wrap fleet-table-cap fleet-table-tall">
        <table className="fp-table fleet-table fleet-cities">
          <thead>
            <tr>
              <th>{t('fleetColCity')}</th>
              <th>{t('fleetColRegion')}</th>
              <th>{t('fleetColStatus')}</th>
              <th className="num">{t('fleetColPerDay')}</th>
              {items.map(i => <th key={i} className="mono">{i}</th>)}
              <th>{t('fleetColHomeOf')}</th>
              <th aria-label={t('fleetColActions')} />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <EmptyRow cols={cols}>{cities.length === 0 ? t('fleetCitiesNone') : t('fleetCitiesNoMatch')}</EmptyRow>}
            {shown.map(c => {
              const bucket = cityBucket(c);
              const standing = cityStanding(c);
              const home = homeWorkerOf(slots, c.slug);
              const rowBusy = busy === c.slug;
              const checking = c.open_tasks.find(x => x.kind === 'verify-slug') ?? null;
              const mismatch = bucket === 'verifying' && !!c.verified_as && c.verified_as.toLowerCase() !== c.name.toLowerCase();
              return (
                <Fragment key={c.slug}>
                  <tr className={standing === 'removed' ? 'fleet-row-removed' : undefined}>
                    <td>
                      <span className="fp-holder">
                        <span className="fleet-city-name">{c.name}</span>
                        <small>
                          <a className="mono" href={marketplaceUrl(c.slug)} target="_blank" rel="noreferrer" title={t('fleetCityOpenMarketplace')}>{c.slug}</a>
                          {c.radius_km !== DEFAULT_RADIUS_KM && <> · {t('fleetCityRadius', { km: c.radius_km })}</>}
                        </small>
                      </span>
                    </td>
                    <td className="fp-muted">{c.region ?? '—'}</td>
                    <td>
                      <span className="fp-holder">
                        <span className={BUCKET_CHIP[bucket]}>{t(BUCKET_KEY[bucket])}</span>
                        {bucket !== 'verifying' && c.verified_as && c.verified_as !== 'override' && <small title={t('fleetCityVerifiedAs')}>{c.verified_as}</small>}
                        {standing === 'disabled' && !mirror && (
                          <button type="button" className="btn sm fleet-inline-action" onClick={() => restore(c)} disabled={rowBusy}>{t('fleetCityEnable')}</button>
                        )}
                        {standing === 'removed' && !mirror && (
                          <button type="button" className="btn sm fleet-inline-action" onClick={() => restore(c)} disabled={rowBusy}>{t('fleetCityRestore')}</button>
                        )}
                      </span>
                    </td>
                    <td className="num">
                      {c.enabled && mirror ? (
                        <span className={c.per_day == null ? 'fp-muted' : undefined}>{c.per_day == null ? t('fleetPerDayDefault') : t('fleetPerDayN', { n: c.per_day })}</span>
                      ) : c.enabled ? (
                        <select className="input fleet-perday" value={c.per_day ?? ''} aria-label={t('fleetColPerDay')}
                          disabled={rowBusy} onChange={e => setPerDay(c, e.target.value)}>
                          <option value="">{t('fleetPerDayDefault')}</option>
                          {PER_DAY_CHOICES.map(n => <option key={n} value={n}>{t('fleetPerDayN', { n })}</option>)}
                        </select>
                      ) : <span className="fp-muted">—</span>}
                    </td>
                    {items.map(i => <td key={i}>{c.enabled ? itemCell(c, i) : <span className="fp-muted">—</span>}</td>)}
                    <td>
                      {home ? (
                        <span className="fp-holder">
                          <WorkerLink id={home.worker_id} />
                          <small>{t('fleetAccountN', { no: home.account_no })}</small>
                        </span>
                      ) : <span className="fp-muted">—</span>}
                    </td>
                    <td className="fleet-row-actions">
                      {standing !== 'removed' && !mirror && <>
                        <button type="button" className="btn ghost icon sm" onClick={() => searchNow(c)} disabled={rowBusy || items.length === 0 || !c.enabled}
                          title={`${t('fleetSearchNow')}: ${t('fleetSearchNowHint')}`} aria-label={t('fleetSearchNow')}>
                          <Icon name="search" size={13} />
                        </button>
                        <button type="button" className="btn ghost icon sm fleet-danger-text" onClick={() => setRemoving(c)} disabled={rowBusy}
                          title={`${t('fleetCityRemove')}: ${t('fleetCityRemoveHint')}`} aria-label={t('fleetCityRemove')}>
                          <Icon name="trash" size={13} />
                        </button>
                      </>}
                    </td>
                  </tr>
                  {bucket === 'verifying' && (
                    <tr className="fleet-verify-row">
                      <td colSpan={cols}>
                        <div className="fleet-verify-box">
                          {mismatch ? <>
                            <span>{t('fleetVerifyMismatch', { shown: c.verified_as ?? '', name: c.name })}</span>
                            {!mirror && <>
                              <button type="button" className="btn sm" onClick={() => enableAnyway(c)} disabled={rowBusy}>{t('fleetCityEnableAnyway')}</button>
                              <button type="button" className="btn sm fleet-danger-text" onClick={() => setRemoving(c)} disabled={rowBusy}>{t('fleetCityRemove')}</button>
                            </>}
                          </> : <>
                            <span>{t('fleetVerifyPending', { ago: agoLabel(t, c.added_at, now), name: c.name })}
                              {checking?.state === 'leased' && checking.worker_id && <> {t('fleetVerifyChecking', { worker: checking.worker_id })}</>}</span>
                            {!mirror && <button type="button" className="btn sm ghost" onClick={() => enableAnyway(c)} disabled={rowBusy}>{t('fleetVerifySkip')}</button>}
                          </>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="fp-table-foot fleet-foot">
        <span>{t('fleetCitiesFoot', { shown: shown.length, n: cities.length })}</span>
        <span>{t('fleetCitiesFootHint')}</span>
      </div>
      {unverified && (
        <Modal onClose={() => setUnverified(null)} shellStyle={{ maxWidth: 460 }}>
          <ConfirmDialogBody title={t('fleetCityUnverifiedTitle', { city: unverified.name })} confirm={t('fleetCityEnableAnyway')}
            busy={busy === unverified.slug} onClose={() => setUnverified(null)}
            onConfirm={() => { const c = unverified; setUnverified(null); void enableAnyway(c); }}
            body={<p>{t('fleetCityUnverifiedBody', { slug: unverified.slug })}</p>} />
        </Modal>
      )}
      {removing && (
        <RemoveCityDialog city={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); onChanged(); }} />
      )}
    </>
  );
}

// The fleet-wide rules: the settings every worker reads at its next task.
// Numbers are kept as typed until Save, which sends only what changed.
const RULE_FIELDS = [
  'per_day_default', 'budget_minutes', 'lease_minutes', 'task_max_minutes', 'familiar_days', 'start_fresh_hours', 'quarantine_hours', 'quarantine_probe_hours', 'retention_days',
  'max_accounts_per_proxy',
] as const;
type RuleField = (typeof RULE_FIELDS)[number];
const RULE_MIN: Record<RuleField, number> = {
  per_day_default: 1, budget_minutes: 1, lease_minutes: 1, task_max_minutes: 1, familiar_days: 0, start_fresh_hours: 0, quarantine_hours: 0, quarantine_probe_hours: 1, retention_days: 30,
  max_accounts_per_proxy: 1,
};

function RulesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const mirror = useFleetMirror();
  const [saved, setSaved] = useState<FleetSettings | 'failed' | null>(null);
  const [draft, setDraft] = useState<Record<RuleField, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fleetApi.settings()
      .then(s => {
        if (!live) return;
        setSaved(s);
        setDraft(Object.fromEntries(RULE_FIELDS.map(f => [f, String(s[f])])) as Record<RuleField, string>);
      })
      .catch(() => { if (live) setSaved('failed'); });
    return () => { live = false; };
  }, []);
  const set = (f: RuleField, v: string) => setDraft(d => (d ? { ...d, [f]: v } : d));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft || saved === null || saved === 'failed' || busy) return;
    const patch: Partial<FleetSettings> = {};
    for (const f of RULE_FIELDS) {
      const n = Number(draft[f]);
      if (!Number.isInteger(n) || n < RULE_MIN[f]) { setProblem(t('fleetRulesBad', { field: t(`fleetRule_${f}`) })); return; }
      if (n !== saved[f]) patch[f] = n;
    }
    if (Object.keys(patch).length === 0) { onClose(); return; }
    setBusy(true);
    setProblem(null);
    try {
      await fleetApi.saveSettings(patch);
      showSuccessToast(t('fleetRulesSaved'));
      onClose();
    } catch (err) {
      handleFetchError(err);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 520 }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{t('fleetRules')}</div>
            <div className="modal-sub">{t('fleetRulesSub')}</div>
          </div>
        </div>
        <div className="modal-body fleet-form">
          {saved === 'failed' && <p className="fp-warn">{t('fleetRulesFailed')}</p>}
          {draft && (
            <dl className="fleet-rules">
              {RULE_FIELDS.map(f => (
                <Fragment key={f}>
                  <dt>{t(`fleetRule_${f}`)}</dt>
                  <dd>
                    <input className="input fleet-rule-input" type="number" min={RULE_MIN[f]} step={1} value={draft[f]} onChange={e => set(f, e.target.value)}
                      disabled={mirror} />
                    {' '}{t(`fleetRuleUnit_${f}`)}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          {problem && <p role="alert" className="fp-warn">{problem}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          {!mirror && <button type="submit" className="btn primary" disabled={busy || !draft}>{t('fleetRulesSave')}</button>}
        </div>
      </form>
    </Modal>
  );
}

function RemoveCityDialog({ city, onClose, onDone }: { city: FleetCity; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const open = city.open_tasks.filter(task => task.state === 'ready').length;
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.removeCity(city.slug);
      showSuccessToast(t('fleetCityRemovedToast', { city: city.name }));
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetCityRemoveTitle', { city: city.name })} confirm={t('fleetCityRemove')} busy={busy} danger
        onClose={onClose} onConfirm={confirm}
        body={<>
          <p>{t('fleetCityRemoveBody', { n: open })}</p>
          <p className="fp-muted">{t('fleetCityRemoveNote')}</p>
        </>} />
    </Modal>
  );
}

// Add a city. After the save the dialog stays open on the new row and follows
// it: "verifying…" until a worker reports the label Facebook showed, then
// enabled; or enable it now without waiting.
function AddCityDialog({ cities, onClose, onChanged }: { cities: readonly FleetCity[]; onClose: () => void; onChanged: () => void }) {
  const { t } = useT();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [region, setRegion] = useState('');
  const [radius, setRadius] = useState(String(DEFAULT_RADIUS_KM));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<FleetCity | null>(null);
  // The list is polled; the row in it is fresher than the one POST answered.
  const live = useMemo(() => (added ? cities.find(c => c.slug === added.slug) ?? added : null), [added, cities]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const s = normalizeSlug(slug);
    const km = Number(radius);
    if (!isSlug(s)) { setProblem(t('fleetCityBadSlug')); return; }
    if (!name.trim()) { setProblem(t('fleetCityNeedName')); return; }
    if (!Number.isInteger(km) || km < 1 || km > 800) { setProblem(t('fleetCityBadRadius')); return; }
    if (cities.some(c => c.slug === s)) { setProblem(t('fleetCityDupe', { slug: s })); return; }
    setBusy(true);
    setProblem(null);
    try {
      const city = await fleetApi.addCity({ slug: s, name: name.trim(), radius_km: km, region: region.trim() || null });
      setAdded(city);
      onChanged();
    } catch (err) {
      setProblem(err instanceof ApiError && err.status === 409 ? t('fleetCityDupe', { slug: s }) : t('fleetCityAddFailed'));
    } finally {
      setBusy(false);
    }
  };
  const enableAnyway = async () => {
    if (!live || busy) return;
    setBusy(true);
    try {
      await fleetApi.updateCity(live.slug, { enabled: true, override_verify: true });
      showSuccessToast(t('fleetCityEnabledToast', { city: live.name }));
      onChanged();
    } catch (err) {
      handleFetchError(err);
    } finally {
      setBusy(false);
    }
  };

  const standing = live ? cityStanding(live) : null;
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 480 }}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{live ? live.name : t('fleetCityAddTitle')}</div>
          <div className="modal-sub">{live ? <span className="mono">{live.slug}</span> : t('fleetCityAddSub')}</div>
        </div>
      </div>
      {live ? (
        <>
          <div className="modal-body fleet-verify">
            {standing === 'verifying' ? (
              <p className="fleet-verify-line"><Icon name="refresh" size={14} className="fleet-spin" />{t('fleetCityVerifyingLong')}</p>
            ) : (
              <p className="fleet-verify-line"><Icon name="check" size={14} />{t(live.enabled ? 'fleetCityVerifiedEnabled' : 'fleetCityVerifiedDisabled')}</p>
            )}
            {live.verified_as && <p>{t('fleetCityVerifiedAsLine', { label: live.verified_as })}</p>}
            <p className="fp-muted">
              <a href={marketplaceUrl(live.slug)} target="_blank" rel="noreferrer">{t('fleetCityOpenMarketplace')}</a>
            </p>
          </div>
          <div className="modal-foot">
            {standing === 'verifying' && (
              <button type="button" className="btn" onClick={enableAnyway} disabled={busy}>{t('fleetCityEnableAnyway')}</button>
            )}
            <button type="button" className="btn primary" onClick={onClose} disabled={busy}>{t('done')}</button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <div className="modal-body fleet-form">
            <label className="fleet-field">
              <span>{t('fleetCitySlug')}</span>
              <input className="input mono" value={slug} onChange={e => setSlug(e.target.value)} placeholder="houston" autoFocus
                autoComplete="off" spellCheck={false} />
              <small className="fp-muted">{t('fleetCitySlugHint')}</small>
            </label>
            <label className="fleet-field">
              <span>{t('fleetCityName')}</span>
              <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Houston, TX" />
            </label>
            <div className="fleet-field-row">
              <label className="fleet-field">
                <span>{t('fleetColRegion')}</span>
                <input className="input" value={region} onChange={e => setRegion(e.target.value)} placeholder="south" />
              </label>
              <label className="fleet-field">
                <span>{t('fleetCityRadiusKm')}</span>
                <input className="input" type="number" min={1} max={800} value={radius} onChange={e => setRadius(e.target.value)} />
              </label>
            </div>
            {problem && <p role="alert" className="fp-warn">{problem}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
            <button type="submit" className="btn primary" disabled={busy}>{t('fleetCityAdd')}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
