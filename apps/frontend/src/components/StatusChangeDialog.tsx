// Captures per-status evidence when a sell order advances into Shipped /
// Awaiting payment / Done. Ported from design/sell-orders.jsx with two
// changes: (1) saves go to the backend immediately (live save), so files
// survive a parent-modal Cancel; (2) attachments come back as URLs the
// frontend can render.

import { useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { api } from '../lib/api';
import { useEscapeKey } from '../lib/useEscapeKey';
import { useT } from '../lib/i18n';

export type StatusAttachment = {
  id: string;
  filename: string;
  size: number;
  mime: string;
  url: string;
};

export type MetaStatus = 'Shipped' | 'Awaiting payment' | 'Done';

type Preset = {
  title: string;
  sub: string;
  icon: IconName;
  tone: 'info' | 'warn' | 'pos' | 'accent';
  placeholder: string;
  acceptHint: string;
};

type TFn = (key: string, vars?: Record<string, string | number>) => string;

function presetsFor(t: TFn): Record<MetaStatus, Preset> {
  return {
    'Shipped': {
      title: t('statusShippedTitle'),
      sub: t('statusShippedSub'),
      icon: 'truck',
      tone: 'info',
      placeholder: t('statusShippedPlaceholder'),
      acceptHint: t('statusShippedAcceptHint'),
    },
    'Awaiting payment': {
      title: t('statusAwaitingTitle'),
      sub: t('statusAwaitingSub'),
      icon: 'invoice',
      tone: 'warn',
      placeholder: t('statusAwaitingPlaceholder'),
      acceptHint: t('statusAwaitingAcceptHint'),
    },
    'Done': {
      title: t('statusDoneTitle'),
      sub: t('statusDoneSub'),
      icon: 'check',
      tone: 'pos',
      placeholder: t('statusDonePlaceholder'),
      acceptHint: t('statusDoneAcceptHint'),
    },
  };
}

function fmtSize(n: number) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

type Props = {
  orderId: string;
  to: MetaStatus;
  currentStatus: string;
  initialNote: string;
  initialAttachments: StatusAttachment[];
  onCancel: () => void;
  // Called once the user confirms — parent stages the status change and
  // commits on Save. The dialog has already persisted note + attachments.
  onConfirm: (next: { note: string; attachments: StatusAttachment[] }) => void;
  // Fires after any internal mutation (attachment add/remove, note PUT) so
  // the parent can refresh views that depend on backend-emitted audit events.
  onMutated?: () => void;
};

export function StatusChangeDialog({
  orderId, to, currentStatus, initialNote, initialAttachments, onCancel, onConfirm, onMutated,
}: Props) {
  const { t } = useT();
  const [note, setNote] = useState(initialNote);
  const [attachments, setAttachments] = useState<StatusAttachment[]>(initialAttachments);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cfg = presetsFor(t)[to];

  // Escape closes the dialog.
  useEscapeKey(onCancel);

  const addFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) {
          setError(t('fileTooLarge', { name: f.name }));
          continue;
        }
        const form = new FormData();
        form.append('file', f);
        const r = await api.upload<{ attachment: StatusAttachment }>(
          `/api/sell-orders/${orderId}/status-meta/${encodeURIComponent(to)}/attachments`,
          form,
        );
        setAttachments(prev => [...prev, r.attachment]);
        onMutated?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (att: StatusAttachment) => {
    setError(null);
    try {
      await api.delete(
        `/api/sell-orders/${orderId}/status-meta/${encodeURIComponent(to)}/attachments/${att.id}`,
      );
      setAttachments(prev => prev.filter(a => a.id !== att.id));
      onMutated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('deleteFailed'));
    }
  };

  // Persist the note (attachments already uploaded live), then tell the
  // parent the user accepted the transition.
  const confirm = async () => {
    setError(null);
    try {
      await api.put<{ ok: true }>(
        `/api/sell-orders/${orderId}/status-meta/${encodeURIComponent(to)}`,
        { note: note.trim() },
      );
      onMutated?.();
      onConfirm({ note: note.trim(), attachments });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'));
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
      style={{ zIndex: 110 }}
    >
      <div className="modal-shell" style={{ maxWidth: 560, width: 'calc(100vw - 80px)' }}>
        {/* Header */}
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'flex-start', gap: 14,
        }}>
          <span
            className={'chip ' + cfg.tone}
            style={{
              width: 38, height: 38, padding: 0, borderRadius: 10,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >
            <Icon name={cfg.icon} size={18} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg)' }}>{cfg.title}</div>
            <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 2 }}>{cfg.sub}</div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="chip" style={{ fontSize: 11 }}>{currentStatus}</span>
              <Icon name="arrow" size={10} />
              <span className={'chip ' + cfg.tone} style={{ fontSize: 11 }}>{to}</span>
            </div>
          </div>
          <button className="btn icon sm" onClick={onCancel} title={t('cancel')}>
            <Icon name="x" size={13} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 24, display: 'grid', gap: 18 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label">{t('trackingNote')}</label>
            <textarea
              className="input"
              rows={4}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={cfg.placeholder}
              style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              autoFocus
            />
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label
              className="label"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span>{t('attachmentsLabel')}</span>
              <span style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400 }}>{cfg.acceptHint}</span>
            </label>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: '1.5px dashed ' + (dragOver ? 'var(--accent)' : 'var(--border-strong)'),
                background: dragOver ? 'var(--accent-soft)' : 'var(--bg-soft)',
                borderRadius: 10,
                padding: '20px 16px',
                textAlign: 'center',
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
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>
                {t('uploadHint')}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,image/*,application/pdf"
                style={{ display: 'none' }}
                onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
              />
            </div>

            {attachments.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {attachments.map(a => {
                  const isImg = a.mime?.startsWith('image/');
                  return (
                    <div
                      key={a.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                        background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
                      }}
                    >
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          width: 32, height: 32, borderRadius: 6, background: 'var(--bg-soft)',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          color: 'var(--fg-subtle)', flexShrink: 0, textDecoration: 'none',
                        }}
                        onClick={e => e.stopPropagation()}
                        title={t('openAttachment')}
                      >
                        <Icon name={isImg ? 'image' : 'file'} size={14} />
                      </a>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: 13, color: 'var(--fg)', display: 'block',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            textDecoration: 'none',
                          }}
                          onClick={e => e.stopPropagation()}
                        >
                          {a.filename}
                        </a>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{fmtSize(a.size)}</div>
                      </div>
                      <button
                        className="btn icon sm"
                        onClick={e => { e.stopPropagation(); removeAttachment(a); }}
                        title={t('remove')}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {error && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'var(--neg-soft)', color: 'var(--neg)', fontSize: 12.5,
            }}>{error}</div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
            {t('editLaterHint')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onCancel}>{t('cancel')}</button>
            <button className="btn accent" onClick={confirm} disabled={uploading}>
              {t('confirmAdvance')} <Icon name="check" size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
