import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import {
  coordinatorApi, type CityTierSettings, type CityTiers, type CityWrite, type FleetAccount, type FleetDoc,
} from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import {
  applyPinEdits, citiesDiffer, cityOwners, isCitySlug, marketplaceCityUrl, normalizeCitySlug, pinEdits,
  searchesPerDay, tierSettingsEdits, tierSettingsValid,
} from '../../lib/fleetView';
import { useT } from '../../lib/i18n';

// ─── Edit cities ──────────────────────────────────────────────────────────────
// Where one worker searches. The console writes the list into that worker's
// config only, and the worker picks it up between jobs. Cities come from the
// regions in master.toml or are typed as a Marketplace location: a worker
// added beside a full fleet needs cities nobody else searches, and the regional
// workers alert straight to Telegram, so a shared city alerts twice.
//
// The same form sets how often each city is searched. The coordinator ranks a
// worker's cities by their alerts and has the busy ones searched at more of
// the day's start times; a pin fixes a city's count instead. That is asked at
// search time, not written into the config, so saving it restarts nothing.

const DEFAULT_RADIUS_KM = 100;
const PIN_CHOICES = [3, 2, 1] as const;

export function EditCitiesButton({ worker, fleet, onSaved, className = 'btn' }: {
  worker: FleetAccount;
  fleet: FleetDoc;
  onSaved?: () => void;
  className?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} title={t('fbcEditCitiesHint')} onClick={() => setOpen(true)}>
        <Icon name="edit" size={13} />
        {t('fbcEditCities')}
      </button>
      {open && (
        <EditCitiesModal worker={worker} fleet={fleet} onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onSaved?.(); }} />
      )}
    </>
  );
}

function EditCitiesModal({ worker: w, fleet, onClose, onSaved }: {
  worker: FleetAccount; fleet: FleetDoc; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useT();
  const base = useMemo<CityWrite[]>(
    () => w.cities.map(c => ({ slug: c.slug, name: c.name, radius: c.radius_km ?? DEFAULT_RADIUS_KM })),
    [w.cities],
  );
  const owners = useMemo(() => cityOwners(fleet, w.worker_id), [fleet, w.worker_id]);
  const [cities, setCities] = useState<CityWrite[]>(base);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [radius, setRadius] = useState(String(DEFAULT_RADIUS_KM));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tiers, setTiers] = useState<CityTiers | null>(null);
  const [pins, setPins] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState<CityTierSettings | null>(null);

  // Without the tiers (an older console or coordinator) the form is the
  // city list alone, as it was. Read once per opening: the page's refresh
  // hands this modal a new `w` and must not reset unsaved edits.
  useEffect(() => {
    coordinatorApi.cityTiers()
      .then(r => {
        setTiers(r);
        setSettings(r.settings);
        setPins(r.pins);
      })
      .catch(() => setTiers(null));
  }, [w.worker_id]);

  const has = (s: string) => cities.some(c => c.slug === s);
  const add = (city: CityWrite) => {
    if (has(city.slug)) { setProblem(t('fbcCitiesDupe', { slug: city.slug })); return false; }
    setCities(list => [...list, city]);
    setProblem(null);
    return true;
  };
  const addOwn = () => {
    const s = normalizeCitySlug(slug);
    const km = Number(radius);
    if (!isCitySlug(s)) { setProblem(t('fbcCitiesBadSlug')); return; }
    if (!name.trim()) { setProblem(t('fbcCitiesNeedName')); return; }
    if (!Number.isInteger(km) || km < 1 || km > 500) { setProblem(t('fbcCitiesBadRadius')); return; }
    if (add({ slug: s, name: name.trim(), radius: km })) { setSlug(''); setName(''); }
  };
  const pick = (value: string) => {
    for (const region of fleet.regions) {
      const c = region.cities.find(x => x.slug === value);
      if (c) { add({ slug: c.slug, name: c.name, radius: c.radius_km ?? DEFAULT_RADIUS_KM }); return; }
    }
  };

  const citiesChanged = citiesDiffer(base, cities);
  // A dropped city's pin goes with it only when no other worker searches it.
  const dropped = base.filter(c => !has(c.slug) && !owners.has(c.slug)).map(c => c.slug);
  const formPins = Object.fromEntries(Object.entries(pins).filter(([slug]) => has(slug)));
  const edits = tiers ? pinEdits(tiers.pins, formPins, [...cities.map(c => c.slug), ...dropped]) : {};
  const pinsChanged = Object.keys(edits).length > 0;
  const settingsEdits = tiers && settings ? tierSettingsEdits(tiers.settings, settings) : {};
  const settingsChanged = Object.keys(settingsEdits).length > 0;
  const settingsOk = !settings || tierSettingsValid(settings);
  const changed = citiesChanged || pinsChanged || settingsChanged;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !changed || !settingsOk || cities.length === 0) return;
    setBusy(true);
    try {
      // Tiers first: a refused tier write then leaves nothing half-saved,
      // and pins for a city not yet in the list are harmless.
      if (pinsChanged || settingsChanged) {
        const pinMap = pinsChanged ? applyPinEdits((await coordinatorApi.cityTiers()).pins, edits) : null;
        await coordinatorApi.saveCityTiers({
          ...(pinMap ? { pins: pinMap } : {}),
          ...(settingsChanged ? { settings: settingsEdits } : {}),
        });
      }
      if (citiesChanged) await coordinatorApi.saveCities(w.worker_id, cities);
      showSuccessToast(citiesChanged
        ? t('fbcCitiesSaved', { n: cities.length, id: w.worker_id })
        : t('fbcTiersSaved'));
      onSaved();
    } catch (err) {
      handleFetchError(err);
    } finally {
      setBusy(false);
    }
  };
  const runs = w.plan?.runs_per_day ?? null;
  const ranked = new Map(w.cities.map(c => [c.slug, c]));

  const shared = (s: string) => owners.get(s);
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 560 }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div className="modal-title">{t('fbcCitiesEditTitle', { id: w.worker_id })}</div>
        </div>
        <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-muted)' }}>{t('fbcCitiesIntro')}</p>

          <div className="ff-chips" aria-label={t('fbcColCities')}>
            {cities.map(c => {
              const others = shared(c.slug);
              return (
                <span key={c.slug} className={`ff-chip${others ? ' dup' : ''}`}
                  title={[c.slug, `${c.radius} km`, others && t('fbcCitiesShared', { who: others.join(', ') })]
                    .filter(Boolean).join(' · ')}>
                  <a href={marketplaceCityUrl(c.slug)} target="_blank" rel="noopener" title={t('fbcCitiesCheck')}
                    style={{ color: 'inherit' }}>{c.name}</a>
                  <button type="button" className="ff-chip-x" aria-label={t('fbcCitiesRemove', { name: c.name })}
                    onClick={() => setCities(list => list.filter(x => x.slug !== c.slug))}>
                    <Icon name="x" size={9} />
                  </button>
                </span>
              );
            })}
            {cities.length === 0 && <span className="fp-muted" style={{ fontSize: 12.5 }}>{t('fbcCitiesNone')}</span>}
          </div>

          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>{t('fbcCitiesFromList')}</span>
            <select className="input" value="" onChange={e => pick(e.target.value)}>
              <option value="">{t('fbcCitiesPick')}</option>
              {fleet.regions.map(region => (
                <optgroup key={region.key} label={region.name}>
                  {region.cities.map(c => {
                    const others = shared(c.slug);
                    return (
                      <option key={c.slug} value={c.slug} disabled={has(c.slug)}>
                        {others ? `${c.name} — ${others.join(', ')}` : c.name}
                      </option>
                    );
                  })}
                </optgroup>
              ))}
            </select>
          </label>

          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>{t('fbcCitiesOwn')}</span>
            <div className="fp-row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <input className="input mono" style={{ flex: '1 1 150px' }} value={slug} spellCheck={false}
                placeholder={t('fbcCitiesSlug')} aria-label={t('fbcCitiesSlug')}
                onChange={e => setSlug(e.target.value)} />
              <input className="input" style={{ flex: '1 1 150px' }} value={name}
                placeholder={t('fbcCitiesName')} aria-label={t('fbcCitiesName')}
                onChange={e => setName(e.target.value)} />
              <input className="input" style={{ width: 80 }} type="number" min={1} max={500} value={radius}
                aria-label={t('fbcCitiesRadius')} title={t('fbcCitiesRadius')}
                onChange={e => setRadius(e.target.value)} />
              <button type="button" className="btn" onClick={addOwn}><Icon name="plus" size={13} />{t('fbcCitiesAdd')}</button>
            </div>
            <span className="muted" style={{ fontSize: 11.5 }}>{t('fbcCitiesSlugWarn')}</span>
          </div>

          {tiers && settings && (
            <CityFrequency cities={cities} ranked={ranked} tiers={tiers} pins={pins} setPins={setPins}
              settings={settings} setSettings={setSettings} settingsOk={settingsOk} runs={runs} />
          )}

          {problem && (
            <div className="card-note" role="alert" style={{ padding: '10px 12px' }}>
              <Icon name="info" size={16} />
              <span>{problem}</span>
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !changed || !settingsOk || cities.length === 0}>{t('save')}</button>
        </div>
      </form>
    </Modal>
  );
}

function CityFrequency({ cities, ranked, tiers, pins, setPins, settings, setSettings, settingsOk, runs }: {
  cities: CityWrite[];
  ranked: Map<string, FleetAccount['cities'][number]>;
  tiers: CityTiers;
  pins: Record<string, number>;
  setPins: (fn: (p: Record<string, number>) => Record<string, number>) => void;
  settings: CityTierSettings;
  setSettings: (s: CityTierSettings) => void;
  settingsOk: boolean;
  runs: number | null;
}) {
  const { t } = useT();
  const pin = (slug: string, value: string) => setPins(p => {
    const next = { ...p };
    if (value) next[slug] = Number(value);
    else delete next[slug];
    return next;
  });
  const num = (key: 'top_pct' | 'mid_pct' | 'window_days', value: string) =>
    setSettings({ ...settings, [key]: Number(value) });
  const perDay = (i: number, value: string) => {
    const next = [...settings.per_day] as CityTierSettings['per_day'];
    next[i] = Number(value);
    setSettings({ ...settings, per_day: next });
  };
  const numberBox = (value: number, onChange: (v: string) => void, label: string, max: number) => (
    <input className="input" type="number" min={0} max={max} style={{ width: 64 }} value={value}
      aria-label={label} title={label} onChange={e => onChange(e.target.value)} />
  );

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>{t('fbcTiersTitle')}</span>
      {(!runs || runs < 2) && (
        <div className="card-note" style={{ padding: '8px 10px' }}>
          <Icon name="info" size={14} />
          <span style={{ fontSize: 12.5 }}>{runs ? t('fbcTiersNeedTimes', { n: runs }) : t('fbcTiersInterval')}</span>
        </div>
      )}
      <table className="table" style={{ width: '100%', fontSize: 12.5 }}>
        <tbody>
          {cities.map(c => {
            const row = ranked.get(c.slug);
            const score = tiers.scores[c.slug] ?? 0;
            const auto = row && !row.pin ? searchesPerDay(row, runs) : null;
            return (
              <tr key={c.slug}>
                <td>{c.name}</td>
                <td className="muted">{t('fbcTiersAlerts', { n: score, days: tiers.settings.window_days })}</td>
                <td style={{ width: 130 }}>
                  <select className="input" value={pins[c.slug] ?? ''} aria-label={t('fbcTiersPin', { name: c.name })}
                    onChange={e => pin(c.slug, e.target.value)}>
                    <option value="">{auto ? t('fbcTiersAutoN', { n: auto }) : t('fbcTiersAuto')}</option>
                    {PIN_CHOICES.map(n => <option key={n} value={n}>{t('fbcTiersPinned', { n })}</option>)}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <details>
        <summary style={{ fontSize: 12.5, cursor: 'pointer' }}>{t('fbcTiersRule')}</summary>
        <div style={{ display: 'grid', gap: 6, marginTop: 8, fontSize: 12.5 }}>
          <div className="fp-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {t('fbcTiersTop')} {numberBox(settings.top_pct, v => num('top_pct', v), t('fbcTiersTop'), 100)}%
            → {numberBox(settings.per_day[0], v => perDay(0, v), t('fbcTiersPerDay'), 6)}×
          </div>
          <div className="fp-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {t('fbcTiersNext')} {numberBox(settings.mid_pct, v => num('mid_pct', v), t('fbcTiersNext'), 100)}%
            → {numberBox(settings.per_day[1], v => perDay(1, v), t('fbcTiersPerDay'), 6)}×
          </div>
          <div className="fp-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {t('fbcTiersRest')} → {numberBox(settings.per_day[2], v => perDay(2, v), t('fbcTiersPerDay'), 6)}×
          </div>
          <div className="fp-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {t('fbcTiersWindow')} {numberBox(settings.window_days, v => num('window_days', v), t('fbcTiersWindow'), 92)}
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>{t('fbcTiersRuleHint')}</span>
          {!settingsOk && <span role="alert" style={{ fontSize: 12, color: 'var(--neg)' }}>{t('fbcTiersInvalid')}</span>}
        </div>
      </details>
    </div>
  );
}
