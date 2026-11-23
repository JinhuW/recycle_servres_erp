// The unit cost a typed lot total implies, rounded to the cent, or null when
// the total or the quantity can't yield one yet (a half-typed or blank total,
// or no quantity to divide by). The caller keeps the typed text on screen
// either way, so a null here never rewrites what the user is typing.
export function unitFromTotal(totalText: string, qty: number): number | null {
  if (totalText.trim() === '') return null;
  const total = Number(totalText);
  if (!Number.isFinite(total) || total < 0 || !(qty > 0)) return null;
  return +(total / qty).toFixed(2);
}
