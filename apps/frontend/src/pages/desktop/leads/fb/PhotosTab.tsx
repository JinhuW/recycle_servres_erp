import { useEffect, useState } from 'react';
import type { FbPhotoPool } from '@recycle-erp/shared';
import { AttachmentDropzone } from '../../../../components/AttachmentDropzone';
import { Icon } from '../../../../components/Icon';
import { TableSkeleton } from '../../../../components/Skeleton';
import { handleFetchError, showSuccessToast } from '../../../../lib/errorToast';
import { fbSellerApi, fbSellerChanged, usePolled, type FbUploadResult } from '../../../../lib/fbSeller';
import { fmtBytes } from '../../../../lib/format';
import { useT } from '../../../../lib/i18n';
import { Ago } from './shared';

// The photo pools ads draw from. Each post takes random unused photos and a
// photo is used once, ever, so a pool runs down: the counts and the low-pool
// warning say when to add more. Photos go in by dragging a batch onto the
// pool; the server refuses a file it already holds in any pool.

const UPLOAD_BATCH = 20;

export function PhotosTab() {
  const { t } = useT();
  const pools = usePolled(() => fbSellerApi.pools(), null, []);
  const settings = usePolled(() => fbSellerApi.settings(), null, []);
  const [picked, setPicked] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const rows = pools.data?.rows ?? null;
  const low = settings.data?.value.photos.low_pool_warning ?? null;
  useEffect(() => { if (picked === null && rows?.length) setPicked(rows.find(p => !p.archived_at)?.id ?? rows[0].id); }, [rows, picked]);
  const shown = (rows ?? []).filter(p => showArchived || !p.archived_at);
  const pool = rows?.find(p => p.id === picked) ?? null;

  return (
    <div className="fbs-split">
      <div className="card fbs-list">
        {!rows ? <TableSkeleton rows={3} cols={1} /> : shown.map(p => (
          <button key={p.id} className={`fbs-list-item${picked === p.id ? ' on' : ''}`} onClick={() => setPicked(p.id)}>
            <b>{p.name}{p.archived_at && <span className="chip muted fbs-gap">{t('fbs_archived')}</span>}</b>
            <span className="rl-sub">
              {t('fbs_pool_counts', { unused: p.unused, used: p.used })}
              {low !== null && !p.archived_at && p.unused < low && <> <span className="chip warn" title={t('fbs_pool_low_hint', { n: low })}>{t('fbs_pool_low')}</span></>}
            </span>
          </button>
        ))}
        <div className="fbs-list-foot">
          {creating
            ? <NewPool onDone={p => { setCreating(false); if (p) { setPicked(p.id); void pools.reload(); } }} />
            : <button className="btn sm" onClick={() => setCreating(true)}><Icon name="plus" size={13} />{t('fbs_pool_new')}</button>}
          <label className="fbs-check"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{t('fbs_show_archived')}</label>
        </div>
      </div>
      <div className="fbs-main">
        {pool ? <PoolView key={pool.id} pool={pool} low={low} onChanged={() => { void pools.reload(); fbSellerChanged(); }} />
          : rows && <p className="rl-empty">{t('fbs_pools_empty')}</p>}
      </div>
    </div>
  );
}

function NewPool({ onDone }: { onDone: (p: FbPhotoPool | null) => void }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { onDone(await fbSellerApi.createPool(name.trim())); showSuccessToast(t('fbs_pool_created')); } catch (e) { handleFetchError(e); setBusy(false); }
  };
  return (
    <form className="fbs-inline" onSubmit={e => { e.preventDefault(); if (name.trim()) void submit(); }}>
      <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={t('fbs_pool_name')} aria-label={t('fbs_pool_name')} autoFocus disabled={busy} />
      <button className="btn sm primary" disabled={busy || !name.trim()}>{t('fbs_create')}</button>
      <button type="button" className="btn sm ghost" onClick={() => onDone(null)} disabled={busy}>{t('cancel')}</button>
    </form>
  );
}

function PoolView({ pool, low, onChanged }: { pool: FbPhotoPool; low: number | null; onChanged: () => void }) {
  const { t } = useT();
  const [used, setUsed] = useState<'all' | 'used' | 'unused'>('all');
  const { data, reload } = usePolled(() => fbSellerApi.photos(pool.id, used), null, [pool.id, used]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<FbUploadResult | null>(null);
  const [note, setNote] = useState(pool.note);

  // Large drops go up in batches so one request stays under the upload limit.
  const upload = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setUploading(true);
    const all: FbUploadResult = { added: [], refused: [] };
    try {
      for (let i = 0; i < files.length; i += UPLOAD_BATCH) {
        const r = await fbSellerApi.uploadPhotos(pool.id, files.slice(i, i + UPLOAD_BATCH));
        all.added.push(...r.added);
        all.refused.push(...r.refused);
      }
    } catch (e) {
      handleFetchError(e);
    } finally {
      setResult(all);
      setUploading(false);
      void reload();
      onChanged();
    }
  };
  const del = async (id: number) => {
    try { await fbSellerApi.deletePhoto(id); void reload(); onChanged(); } catch (e) { handleFetchError(e); }
  };
  const patch = async (body: { note?: string; archived?: boolean }, toast: string) => {
    try { await fbSellerApi.patchPool(pool.id, body); showSuccessToast(toast); onChanged(); } catch (e) { handleFetchError(e); }
  };

  return (
    <>
      <div className="card fbs-panel">
        <div className="rl-between">
          <h3>{pool.name}</h3>
          <div className="rl-actions">
            <button className="btn sm ghost" onClick={() => void patch({ archived: !pool.archived_at }, t(pool.archived_at ? 'fbs_pool_unarchived' : 'fbs_pool_archived'))}>
              {t(pool.archived_at ? 'fbs_unarchive' : 'fbs_archive')}
            </button>
          </div>
        </div>
        <p className="rl-sub">{t('fbs_pool_counts', { unused: pool.unused, used: pool.used })}</p>
        {low !== null && !pool.archived_at && pool.unused < low && (
          <div className="fbs-banner warn"><Icon name="alert" size={14} /><div>{t('fbs_pool_low_banner', { n: pool.unused, min: low })}</div></div>
        )}
        <div className="fbs-inline">
          <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={t('fbs_pool_note')} aria-label={t('fbs_pool_note')} />
          <button className="btn sm" disabled={note === pool.note} onClick={() => void patch({ note }, t('fbs_saved'))}>{t('fbs_save')}</button>
        </div>
        {!pool.archived_at && (
          <AttachmentDropzone onFiles={f => void upload(f)} uploading={uploading} accept="image/jpeg,image/png,image/webp"
            label={t('fbs_drop_label')} boxHint={t('fbs_drop_hint')} />
        )}
        {result && (
          <div className="fbs-upload-result" role="status">
            <p><b>{t('fbs_upload_added', { n: result.added.length })}</b>{result.refused.length > 0 && <> · {t('fbs_upload_refused', { n: result.refused.length })}</>}</p>
            {result.refused.length > 0 && (
              <ul className="fbs-refused">{result.refused.map((r, i) => <li key={i}><span className="mono">{r.name}</span>: {r.reason}</li>)}</ul>
            )}
          </div>
        )}
      </div>

      <div className="fbs-tools">
        <div className="seg" role="group" aria-label={t('fbs_photo_filter')}>
          {(['all', 'unused', 'used'] as const).map(f => (
            <button key={f} className={used === f ? 'active' : ''} aria-pressed={used === f} onClick={() => setUsed(f)}>{t(`fbs_photos_${f}`)}</button>
          ))}
        </div>
      </div>
      {!data ? <TableSkeleton rows={2} cols={4} /> : !data.rows.length ? <p className="rl-empty">{t('fbs_photos_empty')}</p> : (
        <div className="fbs-grid">
          {data.rows.map(p => (
            <figure key={p.id} className={`fbs-photo${p.used_at ? ' used' : ''}`}>
              <img src={p.url} alt={t('fbs_photo_n', { n: p.id })} loading="lazy" />
              <figcaption>
                <span className="mono">#{p.id}</span>
                {p.used_at
                  ? <span className="chip muted" title={t('fbs_photo_used_hint')}>{t('fbs_photo_used_by', { n: p.used_by_placement ?? '—' })}</span>
                  : <button className="btn ghost icon sm" onClick={() => void del(p.id)} title={t('fbs_photo_delete')} aria-label={t('fbs_photo_delete')}><Icon name="trash" size={13} /></button>}
              </figcaption>
              <span className="rl-sub">{fmtBytes(p.bytes)} · <Ago at={p.used_at ?? p.uploaded_at} /></span>
            </figure>
          ))}
        </div>
      )}
    </>
  );
}
