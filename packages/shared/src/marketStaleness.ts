// How old a recorded reference price may get before it stops being trusted.
//
// Shared because the two sides answer the same question about the same row:
// `/api/market?staleOnly=1` filters on it and the market screens paint the age
// badge from it. Two numbers meant a row the server called fresh could arrive
// on a screen that flagged it stale.
export const STALE_DAYS = 5;
