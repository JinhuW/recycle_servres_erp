import { describe, it, expect, vi, beforeEach } from 'vitest';

// imapflow's failure modes as observed against a real server: a dropped
// connection or BYE makes fetchOne resolve empty, and a refused SEARCH
// resolves false — neither throws.
const fake = vi.hoisted(() => ({
  usable: true,
  mailbox: {} as unknown,
  fetchOne: undefined as unknown,
  search: [] as unknown,
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    on() {}
    get usable() { return fake.usable; }
    get mailbox() { return fake.mailbox; }
    async fetchOne() { return fake.fetchOne; }
    async search() { return fake.search; }
  },
}));

const { imapClient } = await import('../src/mail/inbox');
const { mailConfig } = await import('../src/mail');
const { testEnv } = await import('./helpers/app');

describe('imapClient', () => {
  const client = () => imapClient(mailConfig({ ...testEnv, MAIL_USER: 'sales@recycleservers.com', MAIL_PASSWORD: 'pw' })!);
  beforeEach(() => {
    Object.assign(fake, { usable: true, mailbox: {}, fetchOne: undefined, search: [] });
  });

  it('throws when the connection is gone instead of reporting an empty message', async () => {
    fake.usable = false;
    fake.mailbox = false;
    await expect(client().source(5)).rejects.toThrow(/connection lost/);
  });

  it('returns null for a message that is no longer in the box', async () => {
    fake.fetchOne = false;
    expect(await client().source(5)).toBeNull();
    fake.fetchOne = { source: Buffer.from('x') };
    expect(String(await client().source(5))).toBe('x');
  });

  it('throws on a failed SEARCH rather than reading it as no new mail', async () => {
    fake.search = false;
    await expect(client().uidsAfter(3)).rejects.toThrow(/SEARCH failed/);
    fake.search = [9, 4, 3];
    expect(await client().uidsAfter(3)).toEqual([4, 9]);
  });
});
