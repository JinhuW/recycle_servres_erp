import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FleetAccountBrief } from '../../../lib/fleet';

// The hover card's body from a pool row and a fetched record. With no language
// provider `t` returns its key.
vi.mock('../../../lib/fleet', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fleet')>('../../../lib/fleet');
  return { ...actual, fleetApi: { accountBrief: vi.fn(() => new Promise(() => undefined)) } };
});
const { AccountBriefCard } = await import('./accountBrief');

const NOW = Date.parse('2026-10-31T12:00:00Z');
const POOL = { no: 47, uid: '61500000067', status: 'fleet' as const, holder: 'homelab-1', note: 'bought from vendor A', addedAt: Date.parse('2026-10-03T12:00:00Z'), batch: 'oct-a' };
const BRIEF: FleetAccountBrief = {
  account_no: 47, days: 7, searches: 41, cards: 3120, opened: 410, alerted: 3, seconds: 36_000,
  last_search_at: '2026-10-31T11:50:00Z', stints: 3, problems: 1, retired: 0,
  on_worker_since: '2026-10-10T00:00:00Z', on_worker: 'homelab-1',
};

describe('AccountBriefCard', () => {
  it('shows the import, the note, and the last week once the record lands', () => {
    const html = renderToString(<AccountBriefCard no={47} uid={null} pool={POOL} load={{ kind: 'ok', brief: BRIEF }} now={NOW} />);
    expect(html).toContain('615…067');
    expect(html).toContain('bought from vendor A');
    expect(html).toContain('fleetBriefImportedAt');
    expect(html).toContain('oct-a');
    expect(html).toContain('3,120');
    expect(html).toContain('fleetBriefStintsValue');
    expect(html).toContain('fp-warn');
  });

  it('shows the pool part at once and says the record is loading', () => {
    const html = renderToString(<AccountBriefCard no={47} uid={null} pool={{ ...POOL, note: '' }} load={{ kind: 'loading' }} now={NOW} />);
    expect(html).toContain('fleetBriefNoNote');
    expect(html).toContain('fleetBriefLoading');
  });
});
