import { useEffect, useState } from 'react';
import { AttachmentChip } from './AttachmentChip';
import { AttachmentDropzone } from './AttachmentDropzone';
import { MAX_UPLOAD_BYTES } from '../lib/api';
import { fmtBytes, fmtDateShort } from '../lib/format';
import { useT } from '../lib/i18n';
import { acctDeleteAttachment, acctUploadAttachment, type AcctAttachment } from '../lib/accounting';

const ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,image/*,application/pdf';

// An entry's payment screenshots, saved live like the sell order's
// attachments. The server names each by what the receipt OCR reads off it,
// so the chip shows the date, method and amount without opening the image.
// Mount it keyed by the entry: the list is seeded once.
export function AcctAttachments({ entryId, initial, readOnly, onChanged }: {
  entryId: string;
  initial: AcctAttachment[];
  // A voided entry, or a page that only shows them.
  readOnly?: boolean;
  // After an upload or a removal lands, so the history re-reads.
  onChanged?: () => void;
}) {
  const { t, locale } = useT();
  const [items, setItems] = useState(initial);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) {
          setError(t('fileTooLarge', { name: f.name }));
          continue;
        }
        const r = await acctUploadAttachment(entryId, f);
        setItems(prev => [...prev, r.attachment]);
        onChanged?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (a: AcctAttachment) => {
    setError(null);
    try {
      await acctDeleteAttachment(entryId, a.id);
      setItems(prev => prev.filter(x => x.id !== a.id));
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('deleteFailed'));
    }
  };

  if (readOnly && items.length === 0) return null;
  return (
    <div>
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: readOnly ? 0 : 10 }}>
          {items.map(a => (
            <AttachmentChip key={a.id} a={a} sub={`${fmtBytes(a.size)} · ${fmtDateShort(a.uploadedAt, locale)}`}
                            onRemove={readOnly ? undefined : () => void remove(a)} />
          ))}
        </div>
      )}
      {!readOnly && (
        <AttachmentDropzone
          compact
          accept={ACCEPT}
          uploading={uploading}
          boxHint={uploading ? t('acctScreenshotsUploading') : t('acctScreenshotsBox')}
          onFiles={files => void addFiles(files)}
        />
      )}
      {error && <div className="acct-error" role="alert" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

// The same list on a form whose entry doesn't exist yet: the files wait here
// and go up once it is saved (useAccountingEntryForm), when the server names
// them.
export function AcctPendingAttachments({ files, onAdd, onRemove, busy, paste }: {
  files: File[];
  onAdd: (files: FileList | null) => void;
  onRemove: (i: number) => void;
  busy: boolean;
  // The desktop form takes a pasted screenshot; the box says so.
  paste?: boolean;
}) {
  const { t } = useT();
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made = files.map(f => URL.createObjectURL(f));
    setUrls(made);
    return () => made.forEach(u => URL.revokeObjectURL(u));
  }, [files]);
  return (
    <div>
      <div className="label">{t('acctScreenshots')}</div>
      {files.length > 0 && urls.length === files.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {files.map((f, i) => (
            <AttachmentChip key={urls[i]} a={{ id: urls[i], filename: f.name, size: f.size, mime: f.type, url: urls[i] }}
                            onRemove={busy ? undefined : () => onRemove(i)} />
          ))}
        </div>
      )}
      <AttachmentDropzone
        compact
        accept={ACCEPT}
        uploading={busy}
        boxHint={t(paste ? 'acctScreenshotsBoxPaste' : 'acctScreenshotsBox')}
        onFiles={onAdd}
      />
    </div>
  );
}
