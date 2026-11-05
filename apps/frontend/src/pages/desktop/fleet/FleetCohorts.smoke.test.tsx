import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FleetCohortAccount, FleetCohortCounts, FleetCohortGroup, FleetCohortReport } from '../../../lib/fleet';

// The report's markup from fixtures. With no language provider `t` returns its
// key, so the assertions read keys and the numbers printed beside them.
vi.mock('../../../lib/fleet', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fleet')>('../../../lib/fleet');
  const never = () => new Promise(() => undefined);
  return { ...actual, fleetApi: Object.fromEntries(Object.keys(actual.fleetApi).map(k => [k, vi.fn(never)])) };
});

const { CohortBody, FleetCohortCard } = await import('./FleetCohorts');

const counts = (o: Partial<FleetCohortCounts>): FleetCohortCounts => ({
  failed: 0, failed_pct: null, lost: 0, survived: 0, survived_in_loss_state: 0, never_healthy: 0, unknown: 0, running: 0, decided: 0, lost_pct: null, ...o,
});
const group = (o: Partial<FleetCohortGroup>): FleetCohortGroup => ({
  pilot: 'p1', batch: 'order-7', arm: 'cloak', claimed: 10, never_claimed: 2, reached_healthy: 6, health_unknown: 0, failed_starts: 3,
  lost_24h: { all: counts({ failed: 4, failed_pct: 40, lost: 3, survived: 6, never_healthy: 1, unknown: 1, decided: 10, lost_pct: 30 }), unflagged: counts({ failed: 2, failed_pct: 25, lost: 2, survived: 6, decided: 8, lost_pct: 25 }) },
  lost_7d: { all: counts({ running: 10 }), unflagged: counts({ running: 8 }) },
  searches: { all: { accounts: 4, searches: 18, per_account: 4.5 }, unflagged: { accounts: 4, searches: 18, per_account: 4.5 } },
  exit_change_accounts: 1, outage_accounts: 1, recovery_boots: 4,
  ...o,
});
const account: FleetCohortAccount = {
  account_no: 41, batch: 'order-7', arm: 'stock', enrolled_at: '2026-11-01T00:00:00Z', first_claimed_at: null, reached_healthy: null, crossed_arm: false, lost_at: null,
  outcome_24h: null, outcome_7d: null, in_loss_state_24h: false, in_loss_state_7d: false, searches_7d: null, exit_changes: 0, licence_outages: 0, recovery_boots: 0,
};
const report = (o: Partial<FleetCohortReport> = {}): FleetCohortReport => ({
  pilot: 'p1', days: null, since: null, pilots: ['p1'], seats: { active: 7, parked: 2, max_slots: 18, pilot_cap: 18 },
  arms: [group({ batch: null }), group({ batch: null, arm: 'stock' })], groups: [group({})], accounts: [account], ...o,
});

describe('cohort report', () => {
  it('shows a pilot with counts next to percentages, with and without flagged accounts', () => {
    const html = renderToString(<CohortBody report={report()} />);
    // The failed figure comes first, with the stint figure beside it.
    expect(html.indexOf('4/10 · 40%')).toBeGreaterThan(-1);
    expect(html.indexOf('4/10 · 40%')).toBeLessThan(html.indexOf('3/10 · 30%'));
    expect(html).toContain('fleetCohortStintLost');
    expect(html).toContain('fleetCohortFailedHint');
    expect(html).toContain('2/8 · 25%');
    expect(html).toContain('fleetCohortUnflagged');
    expect(html).toContain('fleetCohortNeverHealthy');
    expect(html).toContain('fleetCohortUnknown');
    expect(html).toContain('fleetCohortAllBatches');
    expect(html).toContain('order-7');
    expect(html).toContain('4.5');
    expect(html).toContain('fleetCohortNotClaimed');
  });

  it('says the recovery count is an upper bound and shows the seats line', () => {
    const html = renderToString(<CohortBody report={report()} />);
    expect(html).toContain('fleetCohortRecoveryNote');
    expect(html).toContain('fleetCohortSeats');
  });

  it('never prints a decision', () => {
    const html = renderToString(<CohortBody report={report()} />);
    expect(html).not.toMatch(/\b(Go|Stop|Hold|Inconclusive)\b/);
  });

  it('works as a scorecard with no pilot, no accounts and no batch', () => {
    const html = renderToString(<CohortBody report={report({ pilot: null, days: 30, accounts: [], arms: [], groups: [group({ pilot: null, batch: null, health_unknown: 3 })] })} />);
    expect(html).toContain('fleetCohortNoBatch');
    expect(html).toContain('fleetCohortHealthUnknown');
    expect(html).not.toContain('fleetCohortFirstClaim');
  });

  it('says so when there is nothing to show', () => {
    const html = renderToString(<CohortBody report={report({ arms: [], groups: [], accounts: [] })} />);
    expect(html).toContain('fleetCohortNone');
  });

  it('opens on the scorecard while it loads', () => {
    const html = renderToString(<FleetCohortCard />);
    expect(html).toContain('fleetCohortScorecard');
    expect(html).toContain('fleetCohortSubScorecard');
  });
});
