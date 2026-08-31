// The client follow-up rules, as pure functions over numbers the SQL hands us.
//
// None of this is stored. Tier and health are re-derived on every read from
// purchase-order history, the same discipline orders.category and
// orders.total_cost follow — a status column is a status that goes stale the
// moment nobody maintains it.
//
// The thresholds live in workspace_settings so a manager can retune the
// business without a deploy; the constants here are only the fallback.

import type postgres from 'postgres';
import { getWorkspaceSetting } from '../lib/settings';

type Sql = ReturnType<typeof postgres>;

export type Tier = 'A' | 'B' | 'C';
/** Derived from behaviour, never written. */
export type Health = 'new' | 'ok' | 'quiet' | 'lost';
export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'none';
export type Standing = 'prospect' | 'active' | 'archived';

export type CrmSettings = {
  /** Days between contacts, by tier. `prospect` is deliberately tighter than
   *  tier C: a new lead goes cold far faster than a settled occasional seller. */
  cadenceDays: Record<Tier | 'prospect', number>;
  /** Below this trailing-12-month score a client is always C, whatever the
   *  percentile says. Without it, "top 20%" of a handful of tiny sellers
   *  produces meaningless tier-A clients while the book is still small. */
  tierFloorUsd: number;
  /** Multiples of a client's own typical gap that mean quiet / lost. */
  quietMultiple: number;
  lostMultiple: number;
  /** A gap is clamped into this band before it is multiplied: two POs in one
   *  week must not flag the client three weeks later, and a once-a-year seller
   *  still has to surface eventually. */
  gapMinDays: number;
  gapMaxDays: number;
  /** Hard ceiling — silent this long is lost regardless of rhythm. */
  lostMaxDays: number;
};

export const DEFAULT_CRM: CrmSettings = {
  cadenceDays: { A: 14, B: 30, C: 90, prospect: 21 },
  tierFloorUsd: 500,
  quietMultiple: 2,
  lostMultiple: 4,
  gapMinDays: 7,
  gapMaxDays: 180,
  lostMaxDays: 365,
};

/** Settings keys are read individually so a partially-configured workspace
 *  still gets defaults for whatever it has not set. */
export async function loadCrmSettings(sql: Sql): Promise<CrmSettings> {
  const [cadenceDays, tierFloorUsd, quietMultiple, lostMultiple] = await Promise.all([
    getWorkspaceSetting(sql, 'crm.cadenceDays', DEFAULT_CRM.cadenceDays),
    getWorkspaceSetting(sql, 'crm.tierFloorUsd', DEFAULT_CRM.tierFloorUsd),
    getWorkspaceSetting(sql, 'crm.quietMultiple', DEFAULT_CRM.quietMultiple),
    getWorkspaceSetting(sql, 'crm.lostMultiple', DEFAULT_CRM.lostMultiple),
  ]);
  return {
    ...DEFAULT_CRM,
    cadenceDays: { ...DEFAULT_CRM.cadenceDays, ...cadenceDays },
    tierFloorUsd,
    quietMultiple,
    lostMultiple,
  };
}

/**
 * `pr` is percent_rank() over recency-weighted spend, descending — 0 is the
 * biggest supplier. It is null for anyone under the floor or with no orders.
 * A manager's pin always wins.
 */
export function tierFor(pr: number | null, override: Tier | null): Tier {
  if (override) return override;
  if (pr === null) return 'C';
  if (pr < 0.2) return 'A';
  if (pr < 0.5) return 'B';
  return 'C';
}

export function cadenceFor(
  tier: Tier,
  standing: Standing,
  perClientOverride: number | null,
  s: CrmSettings,
): number {
  if (perClientOverride) return perClientOverride;
  if (standing === 'prospect') return s.cadenceDays.prospect;
  return s.cadenceDays[tier];
}

/**
 * A client is judged against their own rhythm, not a company-wide threshold: a
 * weekly seller silent for three weeks is in trouble, a twice-a-year seller
 * silent for three weeks is fine.
 *
 * `rawGap` is the median days between their consecutive POs, or null when
 * fewer than two orders make a gap unmeasurable — then we fall back to three
 * times their cadence so a one-PO client still surfaces eventually.
 */
export function healthFor(
  args: {
    standing: Standing;
    poCount: number;
    daysSinceLastPo: number | null;
    rawGapDays: number | null;
    cadenceDays: number;
  },
  s: CrmSettings,
): Health {
  if (args.standing === 'prospect' || args.poCount === 0 || args.daysSinceLastPo === null) {
    return 'new';
  }
  const gap = effectiveGap(args.rawGapDays, args.cadenceDays, s);
  if (args.daysSinceLastPo > s.lostMultiple * gap || args.daysSinceLastPo > s.lostMaxDays) {
    return 'lost';
  }
  if (args.daysSinceLastPo > s.quietMultiple * gap) return 'quiet';
  return 'ok';
}

/** The rhythm a client is actually measured against, clamped into the band. */
export function effectiveGap(
  rawGapDays: number | null,
  cadenceDays: number,
  s: CrmSettings,
): number {
  const base = rawGapDays ?? cadenceDays * 3;
  return Math.min(Math.max(base, s.gapMinDays), s.gapMaxDays);
}

/** Days from today, negative meaning late. `null` when nothing is scheduled. */
export function dueStateFor(daysUntilDue: number | null): DueState {
  if (daysUntilDue === null) return 'none';
  if (daysUntilDue < 0) return 'overdue';
  if (daysUntilDue === 0) return 'today';
  if (daysUntilDue <= 7) return 'soon';
  return 'later';
}

/** ISO date (no time) `n` days from today, for scheduling the next contact. */
export function isoDatePlus(days: number, from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
