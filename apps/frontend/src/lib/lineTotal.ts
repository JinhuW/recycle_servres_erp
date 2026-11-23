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

// What a typed lot total saves as, when that is not what was typed. A line
// stores only its unit cost, to the cent (order_lines.unit_cost is
// NUMERIC(12,2)), so its total is qty × that: $100 over 3 saves as
// 3 × $33.33 = $99.99. Null when it saves as typed, or has no unit cost yet.
export function roundedLotTotal(totalText: string, qty: number): { unit: number; saved: number } | null {
  const unit = unitFromTotal(totalText, qty);
  if (unit == null) return null;
  const saved = +(qty * unit).toFixed(2);
  return Math.abs(saved - Number(totalText)) < 0.005 ? null : { unit, saved };
}
