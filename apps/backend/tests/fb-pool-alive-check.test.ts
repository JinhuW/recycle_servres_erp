import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import {
  checkPoolLiveness,
  classifyPicture,
  type Liveness,
} from '../src/services/fbPoolAliveCheck';

const uid = (n: number) => String(61556203481000 + n);

async function seed(n: number, status = 'available', checkedDaysAgo: number | null = null) {
  const db = getTestDb();
  await db`
    INSERT INTO fb_pool_accounts (uid, status, holder_name, batch, alive_checked_at)
    VALUES (${uid(n)}, ${status}, ${status === 'available' || status === 'retired' ? null : 'w1'}, 'T',
            ${checkedDaysAgo === null ? null : db`NOW() - make_interval(days => ${checkedDaysAgo})`})`;
}

const rows = () =>
  getTestDb()<{ uid: string; status: string; holder_name: string | null; alive_checked_at: Date | null }[]>`
    SELECT uid, status, holder_name, alive_checked_at FROM fb_pool_accounts ORDER BY no`;

const probeBy = (verdicts: Record<string, Liveness>) => {
  const seen: string[] = [];
  const probe = async (u: string) => { seen.push(u); return verdicts[u] ?? 'alive'; };
  return { probe, seen };
};

describe('classifyPicture', () => {
  it('reads the three shapes the picture endpoint answers with', () => {
    expect(classifyPicture({ data: { height: 50, width: 50,
      url: 'https://scontent-bos5-1.xx.fbcdn.net/v/t1.30497-1/84628273_n.jpg?stp=x' } })).toBe('alive');
    expect(classifyPicture({ data: {
      url: 'https://static.xx.fbcdn.net/rsrc.php/v4/yo/r/UlIqmHJn-SK.gif' } })).toBe('dead');
    expect(classifyPicture({ error: {
      message: "Unsupported get request. Object with ID '61500000000000' does not exist" } })).toBe('dead');
    expect(classifyPicture({ error: { message: '(#4) Application request limit reached' } })).toBe('unknown');
    expect(classifyPicture({})).toBe('unknown');
  });
});

describe('weekly pool liveness check', () => {
  beforeEach(async () => { await resetDb(); });

  it('moves a dead account to needs attention, keeps its holder and logs it', async () => {
    await seed(1, 'fleet');
    await seed(2);
    const { probe } = probeBy({ [uid(1)]: 'dead' });
    const pass = await checkPoolLiveness(getTestDb(), { probe, gapMs: 0 });
    expect(pass).toMatchObject({ checked: 2, dead: [1], unknown: 0 });
    const [a, b] = await rows();
    expect(a).toMatchObject({ status: 'problem', holder_name: 'w1' });
    expect(b.status).toBe('available');
    expect(a.alive_checked_at).not.toBeNull();
    expect(b.alive_checked_at).not.toBeNull();
    const events = await getTestDb()`SELECT actor_id, actor_name, kind, status, detail, account_no FROM fb_pool_events`;
    expect(events).toEqual([{ actor_id: null, actor_name: 'Weekly check', kind: 'reported',
      status: 'problem', detail: 'disabled', account_no: 1 }]);
  });

  it('probes each account once a week, never problem or retired ones', async () => {
    await seed(1, 'available', 2);
    await seed(2, 'taken', 8);
    await seed(3, 'problem');
    await seed(4, 'retired');
    const { probe, seen } = probeBy({});
    await checkPoolLiveness(getTestDb(), { probe, gapMs: 0 });
    expect(seen).toEqual([uid(2)]);
    seen.length = 0;
    await checkPoolLiveness(getTestDb(), { probe, gapMs: 0 });
    expect(seen).toEqual([]);
  });

  it('leaves an inconclusive account alone and retries it on the next pass', async () => {
    await seed(1, 'available', 9);
    const before = (await rows())[0].alive_checked_at;
    const { probe, seen } = probeBy({ [uid(1)]: 'unknown' });
    expect(await checkPoolLiveness(getTestDb(), { probe, gapMs: 0 })).toMatchObject({ unknown: 1, dead: [] });
    const [a] = await rows();
    expect(a.status).toBe('available');
    expect(a.alive_checked_at).toEqual(before);
    await checkPoolLiveness(getTestDb(), { probe, gapMs: 0 });
    expect(seen).toEqual([uid(1), uid(1)]);
  });

  it('stamps only what it probed when the pass is stopped', async () => {
    await seed(1);
    await seed(2);
    let stop = false;
    const probe = async () => { stop = true; return 'alive' as const; };
    expect(await checkPoolLiveness(getTestDb(), { probe, gapMs: 0, stopping: () => stop })).toMatchObject({ checked: 1 });
    const [a, b] = await rows();
    expect(a.alive_checked_at).not.toBeNull();
    expect(b.alive_checked_at).toBeNull();
  });

  it("doesn't overwrite a status a manager changed during the pass", async () => {
    await seed(1);
    const probe = async () => {
      await getTestDb()`UPDATE fb_pool_accounts SET status = 'retired' WHERE uid = ${uid(1)}`;
      return 'dead' as const;
    };
    expect(await checkPoolLiveness(getTestDb(), { probe, gapMs: 0 })).toMatchObject({ dead: [] });
    expect((await rows())[0].status).toBe('retired');
    expect(await getTestDb()`SELECT 1 FROM fb_pool_events`).toHaveLength(0);
  });
});
