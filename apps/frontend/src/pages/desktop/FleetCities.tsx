import { useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { coordinatorApi, type CityWrite, type FleetAccount, type FleetDoc } from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import {
  citiesDiffer, cityOwners, isCitySlug, marketplaceCityUrl, normalizeCitySlug,
} from '../../lib/fleetView';
import { useT } from '../../lib/i18n';

// ─── Edit cities ──────────────────────────────────────────────────────────────
// Where one worker searches. The console writes the list into that worker's
// config only, and the worker picks it up between jobs. Cities come from the
// regions in master.toml or are typed as a Marketplace location: a worker
// added beside a full fleet needs cities nobody else searches, and the regional
// workers alert straight to Telegram, so a shared city alerts twice.

const DEFAULT_RADIUS_KM = 100;

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

  const changed = citiesDiffer(base, cities);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !changed || cities.length === 0) return;
    setBusy(true);
    coordinatorApi.saveCities(w.worker_id, cities)
      .then(() => {
        showSuccessToast(t('fbcCitiesSaved', { n: cities.length, id: w.worker_id }));
        onSaved();
      })
      .catch(handleFetchError)
      .finally(() => setBusy(false));
  };

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

          {problem && (
            <div className="card-note" role="alert" style={{ padding: '10px 12px' }}>
              <Icon name="info" size={16} />
              <span>{problem}</span>
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !changed || cities.length === 0}>{t('save')}</button>
        </div>
      </form>
    </Modal>
  );
}
