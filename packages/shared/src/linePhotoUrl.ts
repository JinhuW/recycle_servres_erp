// Whether a photo URL is worth putting in an <img>.
//
// Shared because the backend decides which entries go into an order line's
// `photos` payload and the frontend decides which of them to render, and a URL
// one side considers real while the other filters it means a broken thumbnail
// on one surface and a missing one on the next — with nothing failing a test.
//
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

// How many uploaded photos one order line may hold. The server is the
// authority (routes/orders.ts rejects the surplus with a 409), but it answers
// one upload at a time and long after the files were chosen — so the picker
// needs the same number to stop at the limit and say which limit it stopped at.
// The label scan is not counted: it lives in label_scans, not the photo table.
export const LINE_PHOTO_CAP = 6;
