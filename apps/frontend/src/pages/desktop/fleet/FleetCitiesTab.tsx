import { useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { TableSkeleton } from '../../../components/Skeleton';
import { ApiError } from '../../../lib/api';
import { fleetApi, fleetErrorCode, type FleetCity, type FleetItem } from '../../../lib/fleet';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { cityStanding, isSlug, marketplaceUrl, nextDue, normalizeSlug, type CityStanding } from './fleetBoard';
import { Clock, ConfirmDialogBody, EmptyRow, TabCard, UnavailableCard, useFleetPoll, WorkerLink } from './shared';

// ─── Cities ───────────────────────────────────────────────────────────────────
// The catalog the queue works from. A new city starts disabled with a
// verify-slug task: a worker opens its Marketplace page and reports the
// location label Facebook shows, because a wrong slug searches the account's
// own area in silence. It is enabled once verified, or by hand with "Enable
// anyway". Removing a city disables it and cancels its waiting tasks.

const DEFAULT_RADIUS_KM = 500;
const PER_DAY_CHOICES = [1, 2, 3, 4, 6] as const;

const STANDING_CHIP: Record<CityStanding, string> = {
  verifying: 'chip warn fleet-verifying', enabled: 'chip pos', disabled: 'chip muted', removed: 'chip muted',
};
const STANDING_KEY: Record<CityStanding, string> = {
  verifying: 'fleetCityVerifying', enabled: 'fleetCityEnabled', disabled: 'fleetCityDisabled', removed: 'fleetCityRemoved',
};

type Data = { cities: FleetCity[]; items: FleetItem[] };

export function FleetCitiesTab() {
  const { t } = useT();
  const { data, reload } = useFleetPoll<Data>(() =>
    Promise.all([fleetApi.cities(), fleetApi.items()]).then(([cities, items]) => ({ cities, items })));
  const [adding, setAdding] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const items = data?.items.filter(i => i.enabled).map(i => i.name) ?? [];
  const cities = data?.cities ?? [];
  const shown = showRemoved ? cities : cities.filter(c => cityStanding(c) !== 'removed');
  const removed = cities.length - cities.filter(c => cityStanding(c) !== 'removed').length;

  return (
    <div className="fp-pool">
      <TabCard title={t('fleetCitiesTitle')} className="fleet-cities"
        sub={data ? t('fleetCitiesSub', { n: cities.filter(c => c.enabled).length, verifying: cities.filter(c => cityStanding(c) === 'verifying').length }) : ''}
        actions={<>
          {removed > 0 && (
            <label className="fleet-check"><input type="checkbox" checked={showRemoved} onChange={e => setShowRemoved(e.target.checked)} />
              {t('fleetCitiesShowRemoved', { n: removed })}</label>
          )}
          <button type="button" className="btn sm primary" onClick={() => setAdding(true)} disabled={!data}>
            <Icon name="plus" size={13} />{t('fleetCityAdd')}
          </button>
        </>}>
        {data === null ? <TableSkeleton rows={6} cols={8} /> : <CitiesTable cities={shown} items={items} onChanged={reload} />}
      </TabCard>
      {adding && data && (
        <AddCityDialog cities={cities} onClose={() => setAdding(false)} onChanged={reload} />
      )}
    </div>
  );
}

export function CitiesTable({ cities, items, onChanged, now = Date.now() }: {
  cities: readonly FleetCity[]; items: readonly string[]; onChanged: () => void; now?: number;
}) {
  const { t } = useT();
  const [removing, setRemoving] = useState<FleetCity | null>(null);
  const [unverified, setUnverified] = useState<FleetCity | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cols = 8 + items.length;

  const act = async (slug: string, run: () => Promise<unknown>, done?: string, refused?: (e: unknown) => boolean) => {
    if (busy) return;
    setBusy(slug);
    try {
      await run();
      if (done) showSuccessToast(done);
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
  const setPin = (c: FleetCity) => act(c.slug, () => fleetApi.updateCity(c.slug, { pinned: !c.pinned }));
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

  return (
    <div className="fp-table-wrap">
      <table className="fp-table fleet-table">
        <thead>
          <tr>
            <th>{t('fleetColCity')}</th>
            <th>{t('fleetColRegion')}</th>
            <th>{t('fleetColStatus')}</th>
            <th className="num">{t('fleetColPerDay')}</th>
            <th>{t('fleetColPin')}</th>
            {items.map(i => <th key={i}><span className="fp-holder">{t('fleetColLastDone')}<small className="mono">{i}</small></span></th>)}
            <th>{t('fleetColNextDue')}</th>
            <th>{t('fleetColHolder')}</th>
            <th aria-label={t('fleetColActions')} />
          </tr>
        </thead>
        <tbody>
          {cities.length === 0 && <EmptyRow cols={cols}>{t('fleetCitiesNone')}</EmptyRow>}
          {cities.map(c => {
            const standing = cityStanding(c);
            const due = nextDue(c);
            const rowBusy = busy === c.slug;
            return (
              <tr key={c.slug} className={standing === 'removed' ? 'fleet-row-removed' : undefined}>
                <td>
                  <span className="fp-holder">
                    <span>{c.name}{c.pinned && <Icon name="star" size={12} className="fleet-pin-mark" />}</span>
                    <small>
                      <a className="mono" href={marketplaceUrl(c.slug)} target="_blank" rel="noreferrer" title={t('fleetCityOpenMarketplace')}>{c.slug}</a>
                      {' · '}{t('fleetCityRadius', { km: c.radius_km })}
                    </small>
                  </span>
                </td>
                <td>{c.region ?? <span className="fp-muted">—</span>}</td>
                <td>
                  <span className="fp-holder">
                    <span className={STANDING_CHIP[standing]}>{t(STANDING_KEY[standing])}</span>
                    {c.verified_as && <small title={t('fleetCityVerifiedAs')}>{c.verified_as}</small>}
                    {standing === 'verifying' && (
                      <button type="button" className="btn sm fleet-inline-action" onClick={() => enableAnyway(c)} disabled={rowBusy}>{t('fleetCityEnableAnyway')}</button>
                    )}
                    {standing === 'disabled' && (
                      <button type="button" className="btn sm fleet-inline-action" onClick={() => restore(c)} disabled={rowBusy}>{t('fleetCityEnable')}</button>
                    )}
                  </span>
                </td>
                <td className="num">
                  <select className="input fleet-perday" value={c.per_day ?? ''} aria-label={t('fleetColPerDay')}
                    disabled={rowBusy || standing === 'removed'} onChange={e => setPerDay(c, e.target.value)}>
                    <option value="">{t('fleetPerDayDefault')}</option>
                    {PER_DAY_CHOICES.map(n => <option key={n} value={n}>{t('fleetPerDayN', { n })}</option>)}
                  </select>
                </td>
                <td>
                  <button type="button" className={`btn ghost icon sm${c.pinned ? ' fleet-pinned' : ''}`} onClick={() => setPin(c)}
                    disabled={rowBusy || standing === 'removed'} aria-pressed={c.pinned}
                    title={t(c.pinned ? 'fleetUnpin' : 'fleetPin')}>
                    <Icon name="star" size={13} />
                  </button>
                </td>
                {items.map(i => <td key={i}><Clock at={c.last_done_at[i]} now={now} /></td>)}
                <td>{due.at ? <Clock at={due.at} now={now} /> : <span className="fp-muted">—</span>}</td>
                <td><WorkerLink id={due.holder} /></td>
                <td className="fleet-row-actions">
                  {standing === 'removed' ? (
                    <button type="button" className="btn sm" onClick={() => restore(c)} disabled={rowBusy}>{t('fleetCityRestore')}</button>
                  ) : <>
                    <button type="button" className="btn ghost icon sm" onClick={() => searchNow(c)} disabled={rowBusy || items.length === 0 || !c.enabled}
                      title={`${t('fleetSearchNow')}: ${t('fleetSearchNowHint')}`} aria-label={t('fleetSearchNow')}>
                      <Icon name="search" size={13} />
                    </button>
                    <button type="button" className="btn ghost icon sm" onClick={() => setRemoving(c)} disabled={rowBusy}
                      title={t('fleetCityRemove')} aria-label={t('fleetCityRemove')}>
                      <Icon name="trash" size={13} />
                    </button>
                  </>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
    </div>
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
