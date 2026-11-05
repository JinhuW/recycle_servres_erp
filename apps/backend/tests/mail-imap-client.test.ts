import { describe, it, expect, vi, beforeEach } from 'vitest';

// imapflow's failure modes as observed against a real server: a dropped
// connection or BYE makes fetchOne resolve empty, and a refused SEARCH
// resolves false — neither throws.
const fake = vi.hoisted(() => ({
  usable: true,
  mailbox: {} as unknown,
  fetchOne: undefined as unknown,
  search: [] as unknown,
  options: null as null | Record<string, unknown>,
  logins: [] as string[],
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(options: Record<string, unknown>) {
      fake.options = options;
      fake.logins.push((options.auth as { user: string }).user);
    }
    on() {}
    async connect() { throw new Error('no server in this test'); }
    async logout() {}
    get usable() { return fake.usable; }
    get mailbox() { return fake.mailbox; }
    async fetchOne() { return fake.fetchOne; }
    async search() { return fake.search; }
  },
}));

const { imapClient, startMailInboxLoop } = await import('../src/mail/inbox');
const { mailConfig } = await import('../src/mail');
const { testEnv } = await import('./helpers/app');

describe('startMailInboxLoop', () => {
  const start = (env: Record<string, string>) => startMailInboxLoop(null as never, { ...testEnv, ...env });
  const shared = { MAIL_USER: 'sell@ram4cash.example', MAIL_PASSWORD: 'pw' };
  beforeEach(() => { fake.logins = []; });

  it('polls every configured box', async () => {
    const loop = start({ ...shared, MAIL_QUOTES_USER: 'quotes@recycleservers.example', MAIL_QUOTES_PASSWORD: 'q' });
    await vi.waitFor(() => expect(fake.logins).toHaveLength(2));
    loop.stop();
    expect(fake.logins).toEqual(['sell@ram4cash.example', 'quotes@recycleservers.example']);
  });

  it('polls a box only once when quotes share it', async () => {
    const loop = start(shared);
    await vi.waitFor(() => expect(fake.logins).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    loop.stop();
    expect(fake.logins).toEqual(['sell@ram4cash.example']);
  });

  it('does not poll in stub mode', async () => {
    const loop = start({ MAIL_STUB: '1', MAIL_QUOTES_USER: 'quotes@recycleservers.example' });
    await new Promise((r) => setTimeout(r, 20));
    loop.stop();
    expect(fake.logins).toEqual([]);
  });
});

describe('imapClient', () => {
  const client = (port?: string) => imapClient(mailConfig({
    ...testEnv, MAIL_USER: 'sales@recycleservers.com', MAIL_PASSWORD: 'pw', MAIL_IMAP_PORT: port,
  })!);
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

  it('uses implicit TLS on 993 and requires STARTTLS on any other port', () => {
    client();
    expect(fake.options).toMatchObject({ port: 993, secure: true, doSTARTTLS: false });
    client('143');
    expect(fake.options).toMatchObject({ port: 143, secure: false, doSTARTTLS: true });
  });
});
