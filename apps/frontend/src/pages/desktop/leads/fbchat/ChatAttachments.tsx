import { useCallback, useEffect, useRef, useState } from 'react';
import { FB_CHAT_MEDIA_MAX_UPLOAD_BYTES, FB_CHAT_REPLY_MEDIA_MAX } from '@recycle-erp/shared';
import { Icon } from '../../../../components/Icon';
import { ApiError } from '../../../../lib/api';
import { useT } from '../../../../lib/i18n';
import {
  chatTakeAttachments, chatUploadError, chatUploadRetryable,
  type ChatAttachSkipped, type ChatAttachment, type ChatUploadError,
} from './ChatHelpers';

// The photos waiting in the composer. Each one uploads the moment it is added,
// so by the time Send is pressed the reply only carries ids.

export type ChatAttachApi = {
  items: readonly ChatAttachment[];
  /** Why the last add left files out; null when it took them all. */
  skipped: ChatAttachSkipped | null;
  add: (files: readonly File[]) => void;
  remove: (key: number) => void;
  retry: (key: number) => void;
  /** Hands the photos to a send and empties the strip, keeping their previews alive. */
  take: () => ChatAttachment[];
  /** Puts photos back after a send that was not accepted. */
  restore: (items: readonly ChatAttachment[]) => void;
  /** Frees the previews of photos that were sent. */
  release: (items: readonly ChatAttachment[]) => void;
};

export function useChatAttachments(upload: (file: Blob) => Promise<string>): ChatAttachApi {
  const [items, setItems] = useState<readonly ChatAttachment[]>([]);
  const [skipped, setSkipped] = useState<ChatAttachSkipped | null>(null);
  // Uploads answer after other changes, so every update starts from the
  // latest list rather than the one a callback closed over.
  const current = useRef<readonly ChatAttachment[]>([]);
  const update = useCallback((fn: (now: readonly ChatAttachment[]) => readonly ChatAttachment[]) => {
    current.current = fn(current.current);
    setItems(current.current);
  }, []);
  const nextKey = useRef(0);
  const alive = useRef(true);
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  // Leaving the chat drops what was not sent, as it does the text.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const a of current.current) URL.revokeObjectURL(a.preview);
      current.current = [];
    };
  }, []);

  const start = useCallback((key: number, file: Blob) => {
    const settle = (patch: Partial<ChatAttachment>) =>
      update(now => now.map(a => (a.key === key ? { ...a, ...patch } : a)));
    uploadRef.current(file).then(
      mediaId => settle({ state: 'done', mediaId, error: null }),
      (err: unknown) => settle({ state: 'failed', error: chatUploadError(err instanceof ApiError ? err.status : undefined) }),
    );
  }, [update]);

  const add = useCallback((files: readonly File[]) => {
    const { take, skipped: left } = chatTakeAttachments(current.current.length, files);
    setSkipped(left.overLimit || left.badType || left.tooBig ? left : null);
    if (take.length === 0) return;
    const added = take.map((file): ChatAttachment => ({
      key: ++nextKey.current, file, preview: URL.createObjectURL(file),
      state: 'uploading', mediaId: null, error: null,
    }));
    update(now => [...now, ...added]);
    for (const a of added) start(a.key, a.file);
  }, [start, update]);

  const remove = useCallback((key: number) => {
    const gone = current.current.find(a => a.key === key);
    if (gone) URL.revokeObjectURL(gone.preview);
    update(now => now.filter(a => a.key !== key));
    setSkipped(null);
  }, [update]);

  const retry = useCallback((key: number) => {
    const a = current.current.find(x => x.key === key);
    if (!a || a.state !== 'failed') return;
    update(now => now.map(x => (x.key === key ? { ...x, state: 'uploading', error: null } : x)));
    start(key, a.file);
  }, [start, update]);

  const take = useCallback(() => {
    const all = [...current.current];
    update(() => []);
    setSkipped(null);
    return all;
  }, [update]);

  const release = useCallback((sent: readonly ChatAttachment[]) => {
    for (const a of sent) URL.revokeObjectURL(a.preview);
  }, []);

  const restore = useCallback((back: readonly ChatAttachment[]) => {
    // The chat was left while the send was out: nothing will show them again.
    if (!alive.current) {
      release(back);
      return;
    }
    update(now => [...back, ...now]);
  }, [release, update]);

  return { items, skipped, add, remove, retry, take, restore, release };
}

/** Only image files; a paste or drop can carry anything. */
export function chatImageFiles(list: FileList | null | undefined): File[] {
  return list ? Array.from(list).filter(f => f.type.startsWith('image/')) : [];
}

const ERROR_KEY: Record<ChatUploadError, string> = {
  tooBig: 'fbcc_attachTooBig',
  type: 'fbcc_attachType',
  storage: 'fbcc_attachStorage',
  other: 'fbcc_attachFailed',
};

/** The thumbnails above the reply box, and a line saying why any photo is not there. */
export function ChatAttachStrip({ items, skipped, onRemove, onRetry }: {
  items: readonly ChatAttachment[];
  skipped: ChatAttachSkipped | null;
  onRemove: (key: number) => void;
  onRetry: (key: number) => void;
}) {
  const { t } = useT();
  const mb = Math.round(FB_CHAT_MEDIA_MAX_UPLOAD_BYTES / (1024 * 1024));
  const reason = (e: ChatUploadError) => t(ERROR_KEY[e], { mb });
  const errors = [...new Set(items.flatMap(a => (a.error ? [a.error] : [])))];
  const notes = [
    ...errors.map(reason),
    ...(skipped?.badType ? [t('fbcc_attachSkipType')] : []),
    ...(skipped?.tooBig ? [t('fbcc_attachSkipSize', { mb })] : []),
    ...(skipped?.overLimit ? [t('fbcc_attachSkipLimit', { max: FB_CHAT_REPLY_MEDIA_MAX })] : []),
  ];
  if (items.length === 0 && notes.length === 0) return null;

  return (
    <div className="fbcc-attach">
      {items.length > 0 && (
        <ul className="fbcc-chips" aria-label={t('fbcc_attachList')}>
          {items.map((a, i) => {
            const n = i + 1;
            return (
              <li key={a.key} className={`fbcc-chip ${a.state}`} title={a.error ? reason(a.error) : undefined}>
                <img src={a.preview} alt={t('fbcc_attachPhoto', { n })} />
                {a.state === 'uploading' && (
                  <span className="fbcc-chip-over" role="status" aria-label={t('fbcc_attachUploading', { n })}>
                    <span className="busy-spinner" />
                  </span>
                )}
                {a.state === 'failed' && (
                  <span className="fbcc-chip-over">
                    {chatUploadRetryable(a.error)
                      ? (
                        <button type="button" className="fbcc-chip-retry" onClick={() => onRetry(a.key)} aria-label={t('fbcc_attachRetry', { n })} title={t('fbcc_attachRetry', { n })}>
                          <Icon name="refresh" size={14} />
                        </button>
                      )
                      : <Icon name="alert" size={16} />}
                  </span>
                )}
                <button type="button" className="fbcc-chip-x" onClick={() => onRemove(a.key)} aria-label={t('fbcc_attachRemove', { n })} title={t('fbcc_attachRemove', { n })}>
                  <Icon name="x" size={11} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {notes.length > 0 && <div className="fbcc-attach-note" role="status">{notes.join(' ')}</div>}
    </div>
  );
}
