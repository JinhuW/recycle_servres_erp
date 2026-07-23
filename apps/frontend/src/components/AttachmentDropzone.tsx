import { useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';

// Shared drag-&-drop file picker for evidence/attachment surfaces (sell orders
// and purchase orders). Presentational: the parent owns the selected-file state
// and renders the AttachmentChip list itself.
export function AttachmentDropzone({
  onFiles,
  uploading = false,
  label,
  acceptHint,
  boxHint,
  accept = '.pdf,.png,.jpg,.jpeg,image/*,application/pdf',
  multiple = true,
}: {
  onFiles: (files: FileList | null) => void;
  uploading?: boolean;
  label?: string;
  acceptHint?: string;
  // Hint rendered inside the dropzone box (replaces the default size hint).
  boxHint?: string;
  accept?: string;
  multiple?: boolean;
}) {
  const { t } = useT();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="field" style={{ marginBottom: 0 }}>
      {(label || acceptHint) && (
        <label className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {label ? <span>{label}</span> : <span />}
          {acceptHint && <span style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400 }}>{acceptHint}</span>}
        </label>
      )}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: '1.5px dashed ' + (dragOver ? 'var(--accent)' : 'var(--border-strong)'),
          background: dragOver ? 'var(--accent-soft)' : 'var(--bg-soft)',
          borderRadius: 10, padding: '20px 16px', textAlign: 'center',
          cursor: uploading ? 'wait' : 'pointer',
          transition: 'border-color 120ms, background 120ms',
          opacity: uploading ? 0.6 : 1,
        }}
      >
        <Icon name="upload" size={20} style={{ color: 'var(--fg-subtle)' }} />
        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--fg)' }}>
          <strong style={{ color: 'var(--accent-strong)' }}>
            {uploading ? t('uploadingLabel') : t('clickToUpload')}
          </strong> {!uploading && t('orDragDrop')}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{boxHint ?? t('uploadHint')}</div>
        <input
          ref={inputRef}
          type="file"
          multiple={multiple}
          accept={accept}
          style={{ display: 'none' }}
          onChange={e => { onFiles(e.target.files); e.target.value = ''; }}
        />
      </div>
    </div>
  );
}
