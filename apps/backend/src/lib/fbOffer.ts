// The only place a seller-agent offer is computed (CONTRACTS §6.6, guard 2).
// The model never sees a ceiling, a Market price or the ladder; it writes the
// placeholder {{offer}} and this module's number goes in its place.
//
//   ceiling = Σ max_buy_unit × qty
//   offer   = min(ceiling, round_to_dollar(ceiling × (opening_pct + step_pct × (round − 1)) / 100))
//
// `round` is 1 for the first offer in a thread; the thread's stored `round`
// counts the offers already made.

import type { AgentExtract, AgentInput, FbMarketMatch, FbSellerSettings } from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { getWorkspaceSetting } from './settings';
import { canonPartCol, canonPartNumberJs } from './part-number';
import { maxBuyFor } from './market';

export type OfferPolicy = FbSellerSettings['offer'];

export type OfferResult =
  | { ok: true; offer_usd: number; ceiling_usd: number; round: number }
  | { ok: false; reason: string; ceiling_usd: number | null; round: number };

/** The round the next offer in a thread would be. */
export function nextRound(input: Pick<AgentInput, 'thread'>): number {
  return Math.max(0, Math.floor(input.thread.round)) + 1;
}

/** The ladder: the next offer for a ceiling, never above it. */
export function offerAmount(ceilingUsd: number, policy: OfferPolicy, round: number): number {
  const pct = policy.opening_pct + policy.step_pct * Math.max(0, round - 1);
  return Math.min(ceilingUsd, Math.round((ceilingUsd * pct) / 100));
}

function findMatch(market: readonly FbMarketMatch[], partNumber: string | null): FbMarketMatch | null {
  const canon = canonPartNumberJs(partNumber ?? '');
  if (!canon) return null;
  return market.find((m) => m.canon === canon) ?? null;
}

/** Σ max_buy_unit × qty, or the reason there is none. */
export function ceilingFor(
  market: readonly FbMarketMatch[], items: AgentExtract['items'],
): { ok: true; ceiling_usd: number } | { ok: false; reason: string } {
  if (items.length === 0) return { ok: false, reason: 'The seller has not named an item yet.' };
  let sum = 0;
  for (const it of items) {
    const label = it.part_number || it.description || 'an item';
    if (!it.part_number) return { ok: false, reason: `No part number for ${label}.` };
    if (it.qty === null || !Number.isInteger(it.qty) || it.qty <= 0) {
      return { ok: false, reason: `No quantity for ${label}.` };
    }
    const m = findMatch(market, it.part_number);
    if (!m) return { ok: false, reason: `${it.part_number} has no exact Market match.` };
    if (m.max_buy_unit === null || !(m.max_buy_unit > 0)) {
      return { ok: false, reason: `${it.part_number} has no Market price to buy against.` };
    }
    sum += m.max_buy_unit * it.qty;
  }
  return { ok: true, ceiling_usd: Math.floor(sum * 100) / 100 };
}

/** The next offer for this thread, or why there is none. */
export function offerFor(input: AgentInput, extract: AgentExtract): OfferResult {
  const round = nextRound(input);
  const c = ceilingFor(input.market, extract.items);
  if (!c.ok) return { ok: false, reason: c.reason, ceiling_usd: null, round };
  if (round > input.settings.max_rounds) {
    return { ok: false, reason: `Every one of the ${input.settings.max_rounds} offer rounds has been made.`, ceiling_usd: c.ceiling_usd, round };
  }
  const offer = offerAmount(c.ceiling_usd, input.settings, round);
  if (!(offer > 0)) return { ok: false, reason: 'The offer would be nothing.', ceiling_usd: c.ceiling_usd, round };
  return { ok: true, offer_usd: offer, ceiling_usd: c.ceiling_usd, round };
}

/** The Market match for each item, by exact canonical part number. */
export function matchFor(market: readonly FbMarketMatch[], partNumber: string | null): FbMarketMatch | null {
  return findMatch(market, partNumber);
}

// A token a seller might have typed as a part number: letters and digits
// together, at least five long once separators go. Over-collecting only costs
// an index lookup; the offer still needs the extract to name the exact part.
const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9\-_./]{3,40}[A-Za-z0-9]/g;

export function partNumberCandidates(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(TOKEN_RE)) {
      const tok = m[0];
      if (!/\d/.test(tok) || !/[A-Za-z]/.test(tok)) continue;
      const canon = canonPartNumberJs(tok);
      if (canon.length >= 5) out.add(canon);
    }
  }
  return [...out];
}

type MarketRow = {
  canon: string; part_number: string; label: string;
  last_price: number | null; avg_sell: number | null;
  last_price_at: Date | null; updated_at: Date;
};

/**
 * AgentInput.market for these part numbers: an exact canonical match on the
 * Market table, the freshest row per part, priced with the Market page's own
 * maxBuyFor and target margin. `price_at` is when the price used was set.
 */
export async function marketFor(sql: SqlLike, partNumbers: readonly string[]): Promise<FbMarketMatch[]> {
  const canons = [...new Set(partNumbers.map((p) => canonPartNumberJs(p)).filter(Boolean))];
  if (canons.length === 0) return [];
  const [margin, rows] = await Promise.all([
    getWorkspaceSetting(sql, 'target_margin', 0.30),
    sql<MarketRow[]>`
      SELECT DISTINCT ON (canon) canon, part_number, label, last_price, avg_sell, last_price_at, updated_at FROM (
        SELECT ${canonPartCol(sql, sql`rp.part_number`)} AS canon, rp.part_number, rp.label,
               rp.last_price::float AS last_price, rp.avg_sell::float AS avg_sell,
               rp.last_price_at, rp.updated_at
        FROM ref_prices rp
        WHERE rp.part_number IS NOT NULL AND rp.part_number <> ''
          AND ${canonPartCol(sql, sql`rp.part_number`)} = ANY(${canons}::text[])
      ) x
      ORDER BY canon, last_price_at DESC NULLS LAST, updated_at DESC
    `,
  ]);
  return rows.map((r) => {
    const basis = r.last_price ?? r.avg_sell;
    const at = r.last_price !== null ? r.last_price_at ?? r.updated_at : basis !== null ? r.updated_at : null;
    return {
      canon: r.canon,
      part_number: r.part_number,
      label: r.label,
      max_buy_unit: maxBuyFor(basis, margin),
      price_at: at ? new Date(at).toISOString() : null,
    };
  });
}
