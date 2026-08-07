import { isRealPhotoUrl } from '@recycle-erp/shared';
import { api } from './api';

export { isRealPhotoUrl };

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
