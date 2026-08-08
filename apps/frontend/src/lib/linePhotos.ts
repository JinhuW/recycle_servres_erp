import { isRealPhotoUrl, LINE_PHOTO_CAP } from '@recycle-erp/shared';
import { api } from './api';

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
  if (line.photos && line.photos.length) return line.photos.filter(p => isRealPhotoUrl(p.url));
  // No `photos` on this payload — synthesize from the scan so callers get the
  // same shape everywhere.
  return isRealPhotoUrl(line.scanImageUrl)
    ? [{ id: 'scan:' + (line.scanImageId ?? ''), url: line.scanImageUrl, source: 'scan' }]
    : [];
}

/** The thumbnail to show when there's room for exactly one. */
export const primaryPhoto = (line: PhotoBearingLine | null | undefined): LinePhoto | null =>
  linePhotos(line)[0] ?? null;

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
