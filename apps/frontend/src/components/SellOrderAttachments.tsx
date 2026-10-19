import { useState } from 'react';
import { Icon } from './Icon';
import { AttachmentChip, type ChipAttachment } from './AttachmentChip';
import { AttachmentDropzone } from './AttachmentDropzone';
import { api, MAX_UPLOAD_BYTES } from '../lib/api';
import { fmtBytes, fmtDateShort } from '../lib/format';
import { useT } from '../lib/i18n';

// The sell-order page's Attachments card: the files that belong to the order
// as a whole (the sale record, the invoice sent), apart from the per-status
// evidence. Saves live, as the notes card does, so a file dropped mid-edit
// is kept when the edit is cancelled.

export type SellAttachment = ChipAttachment & {
  uploadedAt: string;
  uploadedBy: string | null;
};

const ACCEPT = [
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.xlsx', '.csv',
  'application/pdf', 'image/*', 'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
].join(',');

export function SellOrderAttachments({ orderId, initial, onChanged }: {
  orderId: string;
  initial: SellAttachment[];
  // After an upload or a removal lands, so the History card re-reads.
  onChanged?: () => void;
}) {
  const { t, locale } = useT();
  const [items, setItems] = useState<SellAttachment[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) {
          setError(t('fileTooLarge', { name: f.name }));
          continue;
        }
        const form = new FormData();
        form.append('file', f);
        const r = await api.upload<{ attachment: SellAttachment }>(
          `/api/sell-orders/${orderId}/attachments`, form,
        );
        setItems(prev => [...prev, r.attachment]);
        onChanged?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (a: SellAttachment) => {
    setError(null);
    try {
      await api.delete(`/api/sell-orders/${orderId}/attachments/${a.id}`);
      setItems(prev => prev.filter(x => x.id !== a.id));
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('deleteFailed'));
    }
  };

  // Who filed it and when sits where the chip's size would otherwise be alone;
  // for a record kept for a dispute that is the useful line.
  const subFor = (a: SellAttachment) =>
    [fmtBytes(a.size), a.uploadedBy, fmtDateShort(a.uploadedAt, locale)].filter(Boolean).join(' · ');

  return (
    <div className="card so-page-card">
      <div className="so-section-head">
        <Icon name="paperclip" size={14} /> {t('soAttachmentsSection')}
        {items.length > 0 && <span className="so-signoff-count">{items.length}</span>}
      </div>
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {items.map(a => (
            <AttachmentChip key={a.id} a={a} sub={subFor(a)} onRemove={() => void remove(a)} />
          ))}
        </div>
      )}
      <AttachmentDropzone
        compact
        accept={ACCEPT}
        uploading={uploading}
        boxHint={t('soAttachmentsBoxHint')}
        onFiles={files => void addFiles(files)}
      />
      {error && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--neg, #c0392b)' }}>{error}</div>
      )}
    </div>
  );
}
