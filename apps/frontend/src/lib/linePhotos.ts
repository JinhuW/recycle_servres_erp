import { useEffect, useRef, useState } from 'react';
import { isRealPhotoUrl, LINE_PHOTO_CAP } from '@recycle-erp/shared';
import { api } from './api';
import { showErrorDialog } from './errorToast';
import { useT } from './i18n';

export { isRealPhotoUrl, LINE_PHOTO_CAP };

// The one photo accessor for an order line. Replaces four near-identical
// `!u.startsWith('data:image/placeholder')` checks that had drifted across
// OrderDetail, DesktopEditOrder, LineDrawer and SubmitForm.
//
// A line's picture can come from two places: an AI label scan (a by-product of
// OCR, so only RAM lines ever had one) or an explicit upload (any line). The
// API merges them into `photos`, but this module synthesizes the scan entry
// client-side too, so it works unchanged against endpoints that don't return
// `photos` yet — the inventory list, sell orders, the vendor portal.

export type LinePhoto = {
  id: string;
  url: string;
  source: 'scan' | 'upload';
  filename?: string | null;
  mime?: string | null;
  uploadedAt?: string | null;
};

type PhotoBearingLine = {
  photos?: LinePhoto[] | null;
  scanImageId?: string | null;
  scanImageUrl?: string | null;
};

export function linePhotos(line: PhotoBearingLine | null | undefined): LinePhoto[] {
  if (!line) return [];
  const photos = (line.photos ?? []).filter(p => isRealPhotoUrl(p.url));
  // The scan is synthesized whenever `photos` doesn't already carry it, not
  // only when `photos` is empty: on the submit screen that array is built
  // client-side from uploads alone, so keying off emptiness made the scan tile
  // vanish the moment a photo was added to a line that had one.
  if (photos.some(p => p.source === 'scan') || !isRealPhotoUrl(line.scanImageUrl)) return photos;
  return [
    { id: 'scan:' + (line.scanImageId ?? ''), url: line.scanImageUrl, source: 'scan' },
    ...photos,
  ];
}

/**
 * What counts against the server's per-line cap. The scan lives in
 * `label_scans`, not the photo table the 409 is raised from, so counting it
 * capped every scanned RAM line one photo short of what the server allows.
 */
export const uploadedPhotoCount = (photos: readonly LinePhoto[] | null | undefined): number =>
  (photos ?? []).filter(p => p.source === 'upload').length;

export const uploadLinePhoto = (orderId: string, lineId: string, file: File) => {
  const form = new FormData();
  form.append('file', file);
  return api.upload<{ photo: LinePhoto }>(`/api/orders/${orderId}/lines/${lineId}/photos`, form);
};

export const deleteLinePhoto = (orderId: string, lineId: string, photoId: string) =>
  api.delete<{ ok: true }>(`/api/orders/${orderId}/lines/${lineId}/photos/${photoId}`);

// ─── Picking ─────────────────────────────────────────────────────────────────

/** What one file-picker selection may contribute to a line. */
export type PhotoPick = { accepted: File[]; overCap: number };

/**
 * Trims a selection to what the line still has room for.
 *
 * Left to the server, the surplus is chosen, previewed, uploaded and only then
 * refused one 409 at a time — so the user sees a generic failure instead of a
 * limit. `overCap` is what the caller names in the message.
 */
export function limitPhotoPick(
  files: Iterable<File> | null | undefined,
  currentCount: number,
  cap: number = LINE_PHOTO_CAP,
): PhotoPick {
  const images = [...(files ?? [])].filter(f => f.type.startsWith('image/'));
  const room = Math.max(0, cap - currentCount);
  return { accepted: images.slice(0, room), overCap: Math.max(0, images.length - room) };
}

// ─── The pending-photo buffer ────────────────────────────────────────────────
//
// A line has nowhere to put a photo until it is persisted, so picked files are
// held here and uploaded once the id lands. Both desktop order screens used to
// carry their own copy of this, and the copies had drifted: one of them revoked
// the preview and dropped the queue whatever the upload did, which threw away
// the only copy of a photo whose upload had just failed.

export type PendingPhoto = { file: File; url: string };

export type PhotoFlush = { saved: LinePhoto[]; failed: PendingPhoto[] };

export type LinePhotoBuffer = {
  busy: boolean;
  queuedFor: (cid: string) => PendingPhoto[];
  /** Photo id → the File it was uploaded from, for the merge path. */
  uploadedFiles: Map<string, File>;
  /** Queues a picker selection; returns what it took. */
  add: (cid: string, held: number, files: FileList | null) => PendingPhoto[];
  remove: (cid: string, p: PendingPhoto) => void;
  /**
   * Uploads what is queued for a line — or just `items`, which is how a caller
   * flushes a selection it has only this moment handed to `add`: the queue is
   * React state and does not carry it until the next render.
   */
  flush: (cid: string, orderId: string, lineId: string, items?: PendingPhoto[]) => Promise<PhotoFlush>;
};

export function useLinePhotoBuffer(
  onSaved: (cid: string, saved: LinePhoto[]) => void,
): LinePhotoBuffer {
  const { t } = useT();
  const [pending, setPending] = useState<Record<string, PendingPhoto[]>>({});
  const [busy, setBusy] = useState(false);

  // The live object URLs, held in a ref rather than read off state at cleanup
  // time: an unmount effect with an empty dep list closes over the FIRST
  // render's `pending` — `{}` — and revokes nothing at all.
  const urls = useRef<Set<string>>(new Set());
  const revoke = (url: string) => { URL.revokeObjectURL(url); urls.current.delete(url); };
  useEffect(() => () => {
    for (const url of urls.current) URL.revokeObjectURL(url);
    urls.current.clear();
  }, []);

  // The File behind every photo this session uploaded. The merge path deletes
  // the draft those photos hang off, and R2 goes with it — re-uploading bytes
  // we still hold is what lets them survive the move.
  const uploadedFiles = useRef<Map<string, File>>(new Map());

  const queuedFor = (cid: string) => pending[cid] ?? [];

  const add = (cid: string, held: number, files: FileList | null): PendingPhoto[] => {
    const { accepted, overCap } = limitPhotoPick(files, held + queuedFor(cid).length);
    if (overCap > 0) showErrorDialog(t('linePhotoCapReached', { max: LINE_PHOTO_CAP }));
    if (!accepted.length) return [];
    // Created out here, not inside the updater: React may run a state updater
    // twice, and each extra run would mint an object URL nothing revokes.
    const added = accepted.map(f => {
      const url = URL.createObjectURL(f);
      urls.current.add(url);
      return { file: f, url };
    });
    setPending(prev => ({ ...prev, [cid]: [...(prev[cid] ?? []), ...added] }));
    return added;
  };

  const remove = (cid: string, p: PendingPhoto) => {
    revoke(p.url);
    setPending(prev => ({ ...prev, [cid]: (prev[cid] ?? []).filter(x => x !== p) }));
  };

  const flush = async (
    cid: string, orderId: string, lineId: string, items?: PendingPhoto[],
  ): Promise<PhotoFlush> => {
    const queued = items ?? pending[cid];
    if (!queued?.length) return { saved: [], failed: [] };
    setBusy(true);
    let results: { p: PendingPhoto; photo: LinePhoto | null }[];
    try {
      // Concurrent: the server assigns `position` under a FOR UPDATE lock on
      // the parent line, so racing uploads for one line are already serialised
      // where it matters.
      results = await Promise.all(queued.map(async p => {
        try { return { p, photo: (await uploadLinePhoto(orderId, lineId, p.file)).photo }; }
        catch { return { p, photo: null }; }
      }));
    } finally {
      setBusy(false);
    }

    const saved: LinePhoto[] = [];
    const failed: PendingPhoto[] = [];
    for (const r of results) {
      if (!r.photo) { failed.push(r.p); continue; }
      saved.push(r.photo);
      uploadedFiles.current.set(r.photo.id, r.p.file);
      revoke(r.p.url);
    }
    // A photo whose upload failed stays queued, preview and all — dropping it
    // here discarded the only copy that existed. Anything not in this batch
    // stays put.
    setPending(prev => {
      const keep = [...(prev[cid] ?? []).filter(p => !queued.includes(p)), ...failed];
      const next = { ...prev };
      if (keep.length) next[cid] = keep; else delete next[cid];
      return next;
    });
    if (saved.length) onSaved(cid, saved);
    return { saved, failed };
  };

  return { busy, queuedFor, uploadedFiles: uploadedFiles.current, add, remove, flush };
}

// ─── Carrying photos onto a merge target ─────────────────────────────────────
//
// "Add to an existing draft PO" appends the local lines to the target and then
// deletes the throwaway draft the session had been autosaving into. That delete
// sweeps R2 for every storage key the draft's rows hold — its line photos AND
// its label scans — so a picture that is already uploaded only survives if it
// is re-uploaded against the target first, and `scanImageId` must not be handed
// to the target while the doomed draft still owns that object.

/** Where the bytes for a carried photo come from. */
export type PhotoCarrySource =
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string; filename: string };

export type CarryLine = {
  cid: string;
  /** Whether this line was written to the draft that is about to be deleted. */
  persisted: boolean;
  pending: readonly { file: File }[];
  photos?: readonly LinePhoto[] | null;
  scanImageId?: string | null;
  scanImageUrl?: string | null;
};

export type LineCarryPlan = {
  cid: string;
  /** Uploaded against the target's new line, in display order. */
  carry: PhotoCarrySource[];
  /** Safe to send on the wire line; null once the doomed draft owns the object. */
  scanImageId: string | null;
  /** Photos the cap leaves no room for — reported, never dropped in silence. */
  overCap: number;
};

/**
 * Decides, per line, what has to be re-uploaded onto the merge target and
 * whether its scan key may travel with it. Index-aligned with `lines`, which is
 * also how `addLines` and the PATCH's `addedLineIds` line up.
 *
 * `uploadedFiles` maps a photo id to the File it was uploaded from, so the
 * usual case needs no network read at all.
 */
export function planPhotoCarry(
  lines: readonly CarryLine[],
  uploadedFiles: ReadonlyMap<string, File>,
  draftWillBeDeleted: boolean,
  cap: number = LINE_PHOTO_CAP,
): LineCarryPlan[] {
  return lines.map(l => {
    const carry: PhotoCarrySource[] = [];
    // A line that was never confirmed has no row in the draft, so its scan key
    // survives the sweep and can be handed over as a plain reference.
    const scanIsDoomed = draftWillBeDeleted && l.persisted;
    if (scanIsDoomed && isRealPhotoUrl(l.scanImageUrl)) {
      carry.push({ kind: 'url', url: l.scanImageUrl, filename: 'scan.jpg' });
    }
    if (draftWillBeDeleted) {
      for (const p of l.photos ?? []) {
        if (p.source !== 'upload' || !isRealPhotoUrl(p.url)) continue;
        const file = uploadedFiles.get(p.id);
        carry.push(file
          ? { kind: 'file', file }
          : { kind: 'url', url: p.url, filename: p.filename || 'photo.jpg' });
      }
    }
    for (const p of l.pending) carry.push({ kind: 'file', file: p.file });
    return {
      cid: l.cid,
      carry: carry.slice(0, cap),
      scanImageId: scanIsDoomed ? null : (l.scanImageId ?? null),
      overCap: Math.max(0, carry.length - cap),
    };
  });
}

/**
 * Materialises a carry source. The R2 custom domain allows cross-origin GET
 * (infra/terraform sets the bucket's CORS rule), so a photo whose File is no
 * longer in memory can still be read back — and when it can't, the null is
 * what the caller counts and reports.
 */
export async function photoSourceFile(src: PhotoCarrySource): Promise<File | null> {
  if (src.kind === 'file') return src.file;
  try {
    const res = await fetch(src.url);
    if (!res.ok) return null;
    const blob = await res.blob();
    // R2 always answers with a Content-Type; a blank one is a proxy stripping
    // it, not a non-image, and the upload endpoint requires image/*.
    const type = blob.type || 'image/jpeg';
    if (!type.startsWith('image/')) return null;
    return new File([blob], src.filename, { type });
  } catch { return null; }
}
