// The price a manager typed into the manual market-price dialog, or null when
// it can't be saved. Blank must not read as 0 (Number('') is 0): that recorded
// a $0 market price and zeroed the part's max buy. Zero is refused too, as the
// price-sheet import refuses it; a part has no free market price.
export function parseManualPrice(text: string): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}
