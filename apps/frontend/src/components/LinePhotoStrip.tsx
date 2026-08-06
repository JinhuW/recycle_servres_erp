import { useRef, useState } from 'react';
import { Icon } from './Icon';
import { ImageLightbox } from './ImageLightbox';
import { useT } from '../lib/i18n';
import { type LinePhoto } from '../lib/linePhotos';

// Photos of the actual goods on one line. Any line may carry them — the AI
// label scan appears here too, as a read-only first entry, so the user sees one
// row of pictures rather than "the scan" and "the photos" as separate ideas.
//
// A new line has no DB id yet (it isn't persisted until confirm), so pending
// files are held by the parent and shown here as local previews.
export type PendingPhoto = { file: File; url: string };

export function LinePhotoStrip({
  photos,
  pending = [],
  onAdd,
  onRemove,
  onRemovePending,
  readOnly = false,
  busy = false,
}: {
  photos: LinePhoto[];
  pending?: PendingPhoto[];
  onAdd?: (files: FileList | null) => void;
  onRemove?: (photo: LinePhoto) => void;
  onRemovePending?: (p: PendingPhoto) => void;
  readOnly?: boolean;
  busy?: boolean;
}) {
  const { t } = useT();
  const [lightbox, setLightbox] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const total = photos.length + pending.length;

  const tile = (url: string, key: string, alt: string, onDrop?: () => void, isScan = false) => (
    <div key={key} className="lp-tile">
      <button type="button" className="lp-thumb" onClick={() => setLightbox(url)} title={alt}>
        <img src={url} alt={alt} />
      </button>
      {isScan && <span className="lp-badge">{t('aiShort')}</span>}
      {!readOnly && onDrop && (
        <button type="button" className="lp-x" onClick={onDrop} aria-label={t('delete')}>
          <Icon name="x" size={10} />
        </button>
      )}
    </div>
  );

  return (
    <div className="lp-wrap">
      <div className="lp-head">
        <span className="label" style={{ marginBottom: 0 }}>
          <Icon name="camera" size={12} style={{ marginRight: 5, verticalAlign: -1 }} />
          {t('linePhotos')}
        </span>
        {total > 0 && <span className="lp-count">{total}</span>}
      </div>
      <div className="lp-strip">
        {photos.map(p =>
          tile(p.url, p.id, p.filename ?? t('linePhotos'),
            p.source === 'upload' && onRemove ? () => onRemove(p) : undefined,
            p.source === 'scan'),
        )}
        {pending.map(p =>
          tile(p.url, p.url, p.file.name, onRemovePending ? () => onRemovePending(p) : undefined),
        )}
        {!readOnly && onAdd && (
          <>
            <button
              type="button"
              className="lp-add"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              title={t('linePhotosAdd')}
            >
              {busy ? '…' : <Icon name="plus" size={15} />}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              multiple
              capture="environment"
              style={{ display: 'none' }}
              onChange={e => { onAdd(e.target.files); e.target.value = ''; }}
            />
          </>
        )}
      </div>
      {total === 0 && <div className="lp-empty">{t('linePhotosEmpty')}</div>}
      {lightbox && <ImageLightbox url={lightbox} alt={t('linePhotos')} onClose={() => setLightbox(null)} />}
    </div>
  );
}
