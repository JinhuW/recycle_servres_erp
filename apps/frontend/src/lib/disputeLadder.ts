// PayPal's own ladder. A case enters at INQUIRY and only climbs.
export const DISPUTE_STAGES = ['INQUIRY', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'] as const;

export type DisputeStage = (typeof DISPUTE_STAGES)[number];

export type DisputeLadderStep = {
  key: DisputeStage | 'CLOSED';
  state: 'reached' | 'active' | 'ahead' | 'skipped';
};

/** The steps of a case's stage ladder, or null for a stage we don't know.
 *  PayPal leaves the stage wherever the case was decided, so a closed case
 *  cannot be read off the stage alone: it ends on a step of its own, and the
 *  stages it never climbed to are skipped rather than still ahead. */
export function disputeLadder(stage: string | null, closed: boolean): DisputeLadderStep[] | null {
  const at = DISPUTE_STAGES.indexOf(stage as DisputeStage);
  if (at < 0) return null;
  const steps: DisputeLadderStep[] = DISPUTE_STAGES.map((key, i) => ({
    key,
    state: closed
      ? (i <= at ? 'reached' : 'skipped')
      : (i < at ? 'reached' : i === at ? 'active' : 'ahead'),
  }));
  return closed ? [...steps, { key: 'CLOSED', state: 'active' }] : steps;
}
