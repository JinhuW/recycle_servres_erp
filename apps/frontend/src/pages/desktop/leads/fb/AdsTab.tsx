import { useEffect, useMemo, useState } from 'react';
import type { FbAd, FbAdInput, FbAdState, FbPhoto, FbPlacement, FbSellerAccount } from '@recycle-erp/shared';
import { Icon } from '../../../../components/Icon';
import { Modal } from '../../../../components/Modal';
import { TableSkeleton } from '../../../../components/Skeleton';
import { handleFetchError, showSuccessToast, showWarnToast } from '../../../../lib/errorToast';
import { fbSellerApi, fbSellerChanged, usePolled, type FbPlaceResult } from '../../../../lib/fbSeller';
import { useT } from '../../../../lib/i18n';
import { Ago, Empty, Field, Money, PlacementChip, Table } from './shared';

// The "we buy" ads managers write, and where they run. An ad is drafted, made
// ready, then placed on seller accounts × locations; each placement draws its
// own unused photos from the ad's pool. The preview reads the way the post
// will on Marketplace.

type Filter = FbAdState | 'all';
const BLANK: FbAdInput & { category: string; condition: string; renew_days: number; photos_min: number; photos_max: number } = {
  title: '', description: '', price_usd: 1, category: 'Electronics', condition: 'Used - Good', renew_days: 7, photo_pool_id: null, photos_min: 3, photos_max: 5,
};
type Draft = typeof BLANK;
const toDraft = (a: FbAd): Draft => ({
  title: a.title, description: a.description, price_usd: a.price_usd, category: a.category, condition: a.condition,
  renew_days: a.renew_days, photo_pool_id: a.photo_pool_id, photos_min: a.photos_min, photos_max: a.photos_max,
});

/** What would stop the ad from saving, as i18n keys by field. */
export function adProblems(d: Draft): Partial<Record<keyof Draft, string>> {
  const p: Partial<Record<keyof Draft, string>> = {};
  if (!d.title.trim()) p.title = 'fbs_err_required';
  if (!d.description.trim()) p.description = 'fbs_err_required';
  if (!(d.price_usd >= 0)) p.price_usd = 'fbs_err_number';
  if (!Number.isInteger(d.renew_days) || d.renew_days < 1 || d.renew_days > 60) p.renew_days = 'fbs_err_renew';
  if (!Number.isInteger(d.photos_min) || d.photos_min < 1 || d.photos_min > 10) p.photos_min = 'fbs_err_photos';
  if (!Number.isInteger(d.photos_max) || d.photos_max < d.photos_min || d.photos_max > 10) p.photos_max = 'fbs_err_photos_max';
  return p;
}

export function AdsTab() {
  const { t } = useT();
  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<number | 'new' | null>(null);
  const list = usePolled(() => fbSellerApi.ads(filter === 'all' ? undefined : filter), null, [filter]);
  const pools = usePolled(() => fbSellerApi.pools(), null, []);
  const accts = usePolled(() => fbSellerApi.accounts(), null, []);
  const ads = list.data?.rows ?? null;
  useEffect(() => { if (picked === null && ads?.length) setPicked(ads[0].id); }, [ads, picked]);

  return (
    <>
      <div className="fbs-tools">
        <div className="seg" role="group" aria-label={t('fbs_ad_filter')}>
          {(['all', 'draft', 'ready', 'archived'] as const).map(f => (
            <button key={f} className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`fbs_ad_${f}`)}</button>
          ))}
        </div>
        <button className="btn primary" onClick={() => setPicked('new')}><Icon name="plus" size={13} />{t('fbs_ad_new')}</button>
      </div>
      <div className="fbs-split">
        <div className="card fbs-list">
          {!ads ? <TableSkeleton rows={4} cols={1} /> : !ads.length ? <p className="rl-empty">{t('fbs_ads_empty')}</p> : ads.map(a => (
            <button key={a.id} className={`fbs-list-item${picked === a.id ? ' on' : ''}`} onClick={() => setPicked(a.id)}>
              <b>{a.title}</b>
              <span className="rl-sub">
                <span className={`chip ${a.state === 'ready' ? 'pos' : a.state === 'draft' ? 'muted' : 'cool'}`}>{t(`fbs_ad_${a.state}`)}</span>
                {' '}{t('fbs_ad_live_n', { n: a.live_placements })}
              </span>
            </button>
          ))}
        </div>
        <div className="fbs-main">
          {picked === 'new' && (
            <AdEditor key="new" ad={null} pools={pools.data?.rows ?? []} accounts={accts.data?.rows ?? []}
              onSaved={a => { setPicked(a.id); void list.reload(); }} />
          )}
          {typeof picked === 'number' && (
            <AdDetail key={picked} id={picked} pools={pools.data?.rows ?? []} accounts={accts.data?.rows ?? []} onChanged={() => void list.reload()} />
          )}
        </div>
      </div>
      <PlacementsCard key={String(picked)} adId={typeof picked === 'number' ? picked : null} />
    </>
  );
}

function AdDetail({ id, pools, accounts, onChanged }: { id: number; pools: { id: number; name: string; unused: number }[]; accounts: FbSellerAccount[]; onChanged: () => void }) {
  const { data: ad, setData } = usePolled(() => fbSellerApi.ad(id), null, [id]);
  if (!ad) return <TableSkeleton rows={6} cols={2} />;
  return <AdEditor ad={ad} pools={pools} accounts={accounts} onSaved={a => { setData(a); onChanged(); }} />;
}

function AdEditor({ ad, pools, accounts, onSaved }: {
  ad: FbAd | null; pools: { id: number; name: string; unused: number }[]; accounts: FbSellerAccount[]; onSaved: (a: FbAd) => void;
}) {
  const { t } = useT();
  const [d, setD] = useState<Draft>(ad ? toDraft(ad) : BLANK);
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState(false);
  const problems = adProblems(d);
  const bad = Object.keys(problems).length > 0;
  const editable = !ad || ad.state === 'draft';
  const dirty = !ad || JSON.stringify(toDraft(ad)) !== JSON.stringify(d);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(x => ({ ...x, [k]: v }));
  const err = (k: keyof Draft) => (problems[k] ? t(problems[k]!) : null);

  const run = async (call: () => Promise<FbAd>, toast: string) => {
    setBusy(true);
    try { const a = await call(); onSaved(a); fbSellerChanged(); showSuccessToast(toast); } catch (e) { handleFetchError(e); } finally { setBusy(false); }
  };
  const save = () => run(() => (ad ? fbSellerApi.patchAd(ad.id, d) : fbSellerApi.createAd(d)), t('fbs_ad_saved'));
  const state = (s: FbAdState, toast: string) => ad && run(() => fbSellerApi.patchAd(ad.id, { state: s }), toast);
  const pool = pools.find(p => p.id === d.photo_pool_id);

  return (
    <div className="fbs-editor">
      <div className="card fbs-panel">
        <div className="rl-between">
          <h3>{ad ? t('fbs_ad_edit') : t('fbs_ad_new')}</h3>
          {ad && <span className={`chip ${ad.state === 'ready' ? 'pos' : 'muted'}`}>{t(`fbs_ad_${ad.state}`)}</span>}
        </div>
        {!editable && <p className="help">{t('fbs_ad_locked')}</p>}
        <fieldset disabled={!editable || busy} className="fbs-form">
          <Field label={t('fbs_ad_title')} error={err('title')} wide>
            <input className="input" value={d.title} maxLength={100} onChange={e => set('title', e.target.value)} />
          </Field>
          <Field label={t('fbs_ad_desc')} error={err('description')} wide>
            <textarea className="input" rows={5} value={d.description} onChange={e => set('description', e.target.value)} />
          </Field>
          <Field label={t('fbs_ad_price')} error={err('price_usd')} hint={t('fbs_ad_price_hint')}>
            <input className="input" type="number" min={0} step="1" value={d.price_usd} onChange={e => set('price_usd', e.target.valueAsNumber)} />
          </Field>
          <Field label={t('fbs_ad_category')}><input className="input" value={d.category} onChange={e => set('category', e.target.value)} /></Field>
          <Field label={t('fbs_ad_condition')}><input className="input" value={d.condition} onChange={e => set('condition', e.target.value)} /></Field>
          <Field label={t('fbs_ad_renew')} error={err('renew_days')}>
            <input className="input" type="number" min={1} max={60} value={d.renew_days} onChange={e => set('renew_days', e.target.valueAsNumber)} />
          </Field>
          <Field label={t('fbs_ad_pool')} hint={pool ? t('fbs_pool_unused_n', { n: pool.unused }) : undefined}>
            <select className="input" value={d.photo_pool_id ?? ''} onChange={e => set('photo_pool_id', e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('fbs_ad_no_pool')}</option>
              {pools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label={t('fbs_ad_photos_min')} error={err('photos_min')}>
            <input className="input" type="number" min={1} max={10} value={d.photos_min} onChange={e => set('photos_min', e.target.valueAsNumber)} />
          </Field>
          <Field label={t('fbs_ad_photos_max')} error={err('photos_max')}>
            <input className="input" type="number" min={1} max={10} value={d.photos_max} onChange={e => set('photos_max', e.target.valueAsNumber)} />
          </Field>
        </fieldset>
        <div className="fbs-buttons">
          {editable && <button className="btn primary" disabled={busy || bad || !dirty} onClick={() => void save()}>{t('fbs_save')}</button>}
          {ad?.state === 'draft' && <button className="btn" disabled={busy || dirty || bad} onClick={() => void state('ready', t('fbs_ad_made_ready'))} title={dirty ? t('fbs_ad_save_first') : undefined}>{t('fbs_ad_make_ready')}</button>}
          {ad?.state === 'ready' && <button className="btn primary" disabled={busy} onClick={() => setPlacing(true)}><Icon name="globe" size={13} />{t('fbs_ad_place')}</button>}
          {ad?.state === 'ready' && <button className="btn" disabled={busy} onClick={() => void state('draft', t('fbs_ad_back_to_draft_done'))}>{t('fbs_ad_back_to_draft')}</button>}
          {ad && ad.state !== 'archived' && <button className="btn ghost" disabled={busy} onClick={() => void state('archived', t('fbs_ad_archived_done'))}>{t('fbs_ad_archive')}</button>}
          {ad?.state === 'archived' && <button className="btn" disabled={busy} onClick={() => void state('draft', t('fbs_ad_back_to_draft_done'))}>{t('fbs_ad_unarchive')}</button>}
        </div>
      </div>
      <AdPreview d={d} poolName={pool?.name ?? null} />
      {placing && ad && <PlaceDialog ad={ad} accounts={accounts} onClose={() => setPlacing(false)} />}
    </div>
  );
}

function AdPreview({ d, poolName }: { d: Draft; poolName: string | null }) {
  const { t } = useT();
  return (
    <div className="card fbs-panel fbs-preview" aria-label={t('fbs_ad_preview')}>
      <h3>{t('fbs_ad_preview')}</h3>
      <div className="fbs-preview-photos">
        {Array.from({ length: Math.max(1, Math.min(d.photos_max || 1, 5)) }, (_, i) => (
          <span key={i} className={i < d.photos_min ? 'sure' : undefined}><Icon name="image" size={16} /></span>
        ))}
      </div>
      <p className="rl-sub">{poolName ? t('fbs_ad_preview_photos', { min: d.photos_min, max: d.photos_max, pool: poolName }) : t('fbs_ad_preview_no_pool')}</p>
      <div className="fbs-preview-title">{d.title || <span className="rl-muted">{t('fbs_ad_title')}</span>}</div>
      <div className="fbs-preview-price"><Money usd={Number.isFinite(d.price_usd) ? d.price_usd : null} /></div>
      <div className="rl-sub">{d.category} · {d.condition}</div>
      <p className="fbs-preview-desc">{d.description || <span className="rl-muted">{t('fbs_ad_desc')}</span>}</p>
      <p className="help">{t('fbs_ad_preview_renew', { n: d.renew_days })}</p>
    </div>
  );
}

function PlaceDialog({ ad, accounts, onClose }: { ad: FbAd; accounts: FbSellerAccount[]; onClose: () => void }) {
  const { t } = useT();
  const sellers = accounts.filter(a => a.role === 'seller');
  const [nos, setNos] = useState<number[]>([]);
  const [locs, setLocs] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FbPlaceResult | null>(null);
  const locations = locs.split('\n').map(s => s.trim()).filter(Boolean);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await fbSellerApi.place(ad.id, nos, locations);
      setResult(r);
      fbSellerChanged();
      if (r.placements.length) showSuccessToast(t('fbs_placed_n', { n: r.placements.length }));
      else showWarnToast(t('fbs_placed_none'));
    } catch (e) { handleFetchError(e); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 560 }}>
      <div className="modal-head"><div><div className="modal-title">{t('fbs_ad_place')}</div><div className="modal-sub">{ad.title}</div></div></div>
      <div className="modal-body">
        {result ? (
          <>
            <p>{t('fbs_placed_n', { n: result.placements.length })}</p>
            {result.refused.length > 0 && (
              <>
                <h4 className="fbs-h4">{t('fbs_refused_pairs', { n: result.refused.length })}</h4>
                <ul className="fbs-refused">
                  {result.refused.map((r, i) => <li key={i}><span className="mono">#{r.account_no}</span> · {r.location}: {r.reason}</li>)}
                </ul>
              </>
            )}
          </>
        ) : (
          <>
            <div className="field"><span className="label">{t('fbs_place_accounts')}</span>
              {!sellers.length ? <p className="help">{t('fbs_no_sellers')}</p> : (
                <div className="fbs-checks">
                  {sellers.map(a => (
                    <label key={a.account_no} className="fbs-check">
                      <input type="checkbox" checked={nos.includes(a.account_no)}
                        onChange={e => setNos(x => (e.target.checked ? [...x, a.account_no] : x.filter(n => n !== a.account_no)))} />
                      <span className="mono">#{a.account_no}</span> <span className="rl-muted">{t('fbs_ad_live_n', { n: a.live_ads })}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label className="field"><span className="label">{t('fbs_place_locations')}</span>
              <textarea className="input" rows={4} value={locs} onChange={e => setLocs(e.target.value)} placeholder={'Denver, CO\nAurora, CO'} />
              <span className="help">{t('fbs_place_locations_hint')}</span></label>
            {nos.length > 0 && locations.length > 0 && <p className="help">{t('fbs_place_pairs', { n: nos.length * locations.length })}</p>}
          </>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t(result ? 'fbs_done' : 'cancel')}</button>
        {!result && <button className="btn primary" onClick={() => void submit()} disabled={busy || !nos.length || !locations.length}>{t('fbs_ad_place')}</button>}
      </div>
    </Modal>
  );
}

// ─── Placements ───────────────────────────────────────────────────────────────

function PlacementsCard({ adId }: { adId: number | null }) {
  const { t } = useT();
  const [scope, setScope] = useState<'ad' | 'all'>(adId === null ? 'all' : 'ad');
  const { data, reload } = usePolled(
    async () => (scope === 'ad' && adId !== null ? (await fbSellerApi.ad(adId)).placements ?? [] : (await fbSellerApi.placements()).rows),
    30_000, [scope, adId],
  );
  const photos = usePhotoIndex(data);
  const [resolving, setResolving] = useState<FbPlacement | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const act = async (p: FbPlacement, call: () => Promise<FbPlacement>, toast: string) => {
    setBusy(p.id);
    try { await call(); fbSellerChanged(); showSuccessToast(toast); await reload(); } catch (e) { handleFetchError(e); } finally { setBusy(null); }
  };

  return (
    <section className="fbs-section">
      <div className="rl-between fbs-section-head">
        <h3>{t('fbs_placements')}</h3>
        {adId !== null && (
          <div className="seg" role="group" aria-label={t('fbs_placements')}>
            <button className={scope === 'ad' ? 'active' : ''} aria-pressed={scope === 'ad'} onClick={() => setScope('ad')}>{t('fbs_pl_this_ad')}</button>
            <button className={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>{t('fbs_pl_all_ads')}</button>
          </div>
        )}
      </div>
      {!data ? <TableSkeleton rows={3} cols={7} /> : !data.length ? <Empty><p>{t('fbs_pl_empty')}</p></Empty> : (
        <Table head={<>
          <th>{t('fbs_col_state')}</th><th>{t('fbs_col_account')}</th><th>{t('fbs_col_location')}</th><th>{t('fbs_col_photos')}</th>
          <th>{t('fbs_col_listing')}</th><th>{t('fbs_col_posted')}</th><th>{t('fbs_col_renew')}</th><th className="rl-act" />
        </>}>
          {data.map(p => (
            <tr key={p.id}>
              <td><PlacementChip state={p.state} />{p.last_error && <span className="rl-sub fbs-error">{p.last_error}</span>}</td>
              <td className="mono">{p.account_no === null ? '—' : `#${p.account_no}`}</td>
              <td>{p.location}{scope === 'all' && <span className="rl-sub rl-clip">{p.content.title}</span>}</td>
              <td>
                <span className="fbs-thumbs">
                  {p.photo_ids.map(pid => photos.get(pid)
                    ? <img key={pid} src={photos.get(pid)!.url} alt={t('fbs_photo_n', { n: pid })} title={t('fbs_photo_n', { n: pid })} loading="lazy" />
                    : <span key={pid} className="fbs-thumb-missing" title={t('fbs_photo_n', { n: pid })}>#{pid}</span>)}
                  {!p.photo_ids.length && <span className="rl-muted">—</span>}
                </span>
              </td>
              <td className="mono">{p.fb_listing_id
                ? <a href={`https://www.facebook.com/marketplace/item/${encodeURIComponent(p.fb_listing_id)}/`} target="_blank" rel="noopener noreferrer">{p.fb_listing_id}</a>
                : '—'}</td>
              <td><Ago at={p.posted_at} /></td>
              <td><Ago at={p.next_renew_at} /></td>
              <td className="rl-act">
                {p.state === 'live' && <>
                  <button className="btn sm" disabled={busy === p.id} onClick={() => void act(p, () => fbSellerApi.renew(p.id), t('fbs_pl_renewed'))}>{t('fbs_pl_renew')}</button>{' '}
                  <button className="btn sm ghost" disabled={busy === p.id} onClick={() => void act(p, () => fbSellerApi.remove(p.id), t('fbs_pl_removing_toast'))}>{t('fbs_pl_remove')}</button>
                </>}
                {p.state === 'uncertain' && <button className="btn sm" disabled={busy === p.id} onClick={() => setResolving(p)}>{t('fbs_pl_resolve')}</button>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {resolving && <ResolveDialog p={resolving} onClose={() => setResolving(null)} onDone={() => { setResolving(null); fbSellerChanged(); void reload(); }} />}
    </section>
  );
}

/** The photos the shown placements drew, by id, read from their pools' used photos. */
function usePhotoIndex(placements: FbPlacement[] | null): Map<number, FbPhoto> {
  const [index, setIndex] = useState<Map<number, FbPhoto>>(new Map());
  const pools = usePolled(() => fbSellerApi.pools(), null, []);
  const want = useMemo(() => (placements ?? []).flatMap(p => p.photo_ids).filter(id => !index.has(id)), [placements, index]);
  useEffect(() => {
    if (!want.length || !pools.data) return;
    let live = true;
    Promise.all(pools.data.rows.map(p => fbSellerApi.photos(p.id, 'used').then(r => r.rows)))
      .then(all => { if (live) setIndex(new Map(all.flat().map(p => [p.id, p]))); }, () => {});
    return () => { live = false; };
    // One read per set of missing ids; a photo no pool lists shows as its number.
  }, [want.join(','), pools.data]);
  return index;
}

function ResolveDialog({ p, onClose, onDone }: { p: FbPlacement; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [live, setLive] = useState<boolean | null>(null);
  const [listing, setListing] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (live === null) return;
    setBusy(true);
    try { await fbSellerApi.resolve(p.id, live, live ? listing.trim() || undefined : undefined); showSuccessToast(t('fbs_pl_resolved')); onDone(); }
    catch (e) { handleFetchError(e); setBusy(false); }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 480 }}>
      <div className="modal-head"><div><div className="modal-title">{t('fbs_pl_resolve')}</div>
        <div className="modal-sub">{t('fbs_pl_resolve_sub', { account: p.account_no ?? '—', location: p.location })}</div></div></div>
      <div className="modal-body">
        {p.last_error && <p className="help">{p.last_error}</p>}
        <label className="fbs-check"><input type="radio" name="live" checked={live === true} onChange={() => setLive(true)} />{t('fbs_pl_resolve_live')}</label>
        {live && (
          <label className="field"><span className="label">{t('fbs_col_listing')}</span>
            <input className="input mono" value={listing} onChange={e => setListing(e.target.value)} inputMode="numeric" /></label>
        )}
        <label className="fbs-check"><input type="radio" name="live" checked={live === false} onChange={() => setLive(false)} />{t('fbs_pl_resolve_not')}</label>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy || live === null}>{t('fbs_pl_resolve')}</button>
      </div>
    </Modal>
  );
}
