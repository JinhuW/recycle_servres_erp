import { useState } from 'react';
import { Icon } from './Icon';
import { ImageLightbox } from './ImageLightbox';
import { useT } from '../lib/i18n';

// A single attachment row (icon · filename · size). Image attachments open in an
// in-app lightbox instead of a new browser tab; everything else (PDF, etc.) is a
// normal open-in-new-tab link. Used by the sell-order evidence list and the
// status-change dialog, so the lightbox z-index sits above those modals (110–120).

export type ChipAttachment = {
  id: string;
  filename: string;
  size: number;
  mime: string;
  url: string;
};

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B`
  : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
  : `${(n / 1024 / 1024).toFixed(1)} MB`;

const ROW: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
  background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
  textDecoration: 'none', color: 'var(--fg)', width: '100%', textAlign: 'left',
};

export function AttachmentChip({ a, onRemove }: { a: ChipAttachment; onRemove?: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const isImg = a.mime?.startsWith('image/');

  const body = (
    <>
      <span style={{
        width: 32, height: 32, borderRadius: 6, background: 'var(--bg-soft)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--fg-subtle)', flexShrink: 0,
      }}>
        <Icon name={isImg ? 'image' : 'file'} size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {a.filename}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{fmtSize(a.size)}</div>
      </div>
    </>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {isImg ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={t('openAttachment')}
          style={{ ...ROW, cursor: 'zoom-in', font: 'inherit' }}
        >
          {body}
        </button>
      ) : (
        <a href={a.url} target="_blank" rel="noreferrer" title={t('openAttachment')} style={ROW}>
          {body}
        </a>
      )}
      {onRemove && (
        <button className="btn icon sm" onClick={onRemove} title={t('remove')} style={{ flexShrink: 0 }}>
          <Icon name="x" size={12} />
        </button>
      )}
      {open && (
        <ImageLightbox url={a.url} alt={a.filename} zIndex={200} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
