// One photo list per order line, merging two sources the client shouldn't have
// to know apart:
//
//   - the AI label scan (order_lines.scan_image_id → label_scans.delivery_url),
//     which only exists when someone ran OCR on the line, and
//   - explicit uploads (order_line_photos), which any line may carry.
//
// The scan is not migrated into the new table: it is the join key to
// label_scans, which also holds the extraction and confidence the drawer's AI
// banner reads. It appears here as a read-only entry with a `scan:` id, and the
// DELETE route rejects non-UUID ids, so it can't be removed through that path.

export type LinePhoto = {
  id: string;
  url: string;
  source: 'scan' | 'upload';
  filename: string | null;
  mime: string | null;
  uploadedAt: string | null;
};

// Without R2 credentials the upload path returns a payload-less data: URL
// (`data:image/png;name=x.png`, r2.ts) and the scan path normalises to
// `data:image/placeholder`. Neither renders — a broken thumbnail is worse than
// no thumbnail. A genuine inline data: image always carries a `,` before its
// payload, so that is the discriminator.
export const isRealPhotoUrl = (u: unknown): u is string =>
  typeof u === 'string'
  && u.length > 0
  && !u.startsWith('data:image/placeholder')
  && !(u.startsWith('data:') && !u.includes(','));

export function linePhotos(
  line: { scan_image_id?: unknown; scan_image_url?: unknown },
  uploads: LinePhoto[] = [],
): LinePhoto[] {
  const out: LinePhoto[] = [];
  if (isRealPhotoUrl(line.scan_image_url)) {
    out.push({
      id: 'scan:' + String(line.scan_image_id ?? ''),
      url: line.scan_image_url,
      source: 'scan',
      filename: null,
      mime: null,
      uploadedAt: null,
    });
  }
  return out.concat(uploads);
}
