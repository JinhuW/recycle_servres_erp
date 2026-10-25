import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';
import { mockFrankfurter } from './helpers/fx';

// An RMB Flow entry's payment screenshots: stored under the name the receipt
// OCR reads off them, managers only, refused on a voided entry, and — being
// proof rather than money — leaving the version and the sign-off alone.

type Attachment = { id: string; filename: string; size: number; mime: string; url: string; uploadedAt: string };
type Detail = {
  id: string; reference: string | null; attachments: Attachment[];
  review: { state: string; version: string } | null;
  events: { kind: string; detail: Record<string, unknown> }[];
};

const png = (name = 'IMG_0412.png') =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, { type: 'image/png' });

// What OpenRouter answers when it reads an Alipay receipt.
const readsAlipay = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(
  JSON.stringify({ choices: [{ message: { content: '{"method":"alipay","amount":"366090.00"}' } }] }),
  { status: 200 },
)));

describe('accounting entry screenshots', () => {
  let alex: Awaited<ReturnType<typeof loginAs>>;
  let sofia: Awaited<ReturnType<typeof loginAs>>;

  beforeEach(async () => {
    await resetDb();
    mockFrankfurter(7, '2026-10-01');
    alex = await loginAs(ALEX);
    sofia = await loginAs(SOFIA);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const record = async (body: Record<string, unknown> = {}) => {
    const r = await api<{ id: string; error?: string }>('POST', '/api/accounting/entries', {
      token: alex.token,
      body: {
        direction: 'out', kind: 'other', amount: 366090, currency: 'CNY', method: 'alipay',
        occurredOn: '2026-10-05', managerId: alex.user.id, counterparty: 'Stefen', ...body,
      },
    });
    expect(r.status, r.body.error).toBe(201);
    return r.body.id;
  };
  const entry = async (id: string) =>
    (await api<{ entry: Detail }>('GET', `/api/accounting/entries/${id}`, { token: alex.token })).body.entry;
  const upload = (id: string, file: File, opts: { token?: string; env?: Record<string, string> } = {}) =>
    multipart(`/api/accounting/entries/${id}/attachments`, { file }, { token: opts.token ?? alex.token, env: opts.env });

  it('stores a screenshot under the name the receipt OCR reads off it', async () => {
    readsAlipay();
    const id = await record();
    const r = await upload(id, png(), { env: { OPENROUTER_API_KEY: 'test-key' } });
    expect(r.status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    const { attachment } = r.body as { attachment: Attachment };
    expect(attachment).toMatchObject({ filename: `${today}-alipay-366090.00.png`, mime: 'image/png' });

    const e = await entry(id);
    expect(e.attachments).toEqual([attachment]);
    expect(e.events.at(-1)).toMatchObject({
      kind: 'attachment_added', detail: { attachmentId: attachment.id, filename: attachment.filename },
    });
  });

  it('keeps the file\'s own name when there is no model to read it', async () => {
    const id = await record();
    const r = await upload(id, png('IMG_0412.png'));
    expect(r.status).toBe(200);
    expect((r.body as { attachment: Attachment }).attachment.filename).toBe('IMG_0412.png');
  });

  it('lists them beside the entry in Review', async () => {
    const id = await record();
    await upload(id, png());
    const q = await api<{ rows: { id: string; attachments: Attachment[] }[] }>(
      'GET', '/api/accounting/review?tab=mine', { token: sofia.token });
    expect(q.body.rows.find(r => r.id === id)?.attachments.map(a => a.filename)).toEqual(['IMG_0412.png']);
  });

  it('leaves the version and a sign-off alone, both ways', async () => {
    const id = await record();
    const before = await entry(id);
    expect((await api('POST', `/api/accounting/entries/${id}/review`, {
      token: sofia.token, body: { version: before.review!.version },
    })).status).toBe(200);
    const signed = await entry(id);

    const added = await upload(id, png());
    const { attachment } = added.body as { attachment: Attachment };
    const removed = await api('DELETE', `/api/accounting/entries/${id}/attachments/${attachment.id}`, { token: alex.token });
    expect(removed.status).toBe(200);

    const after = await entry(id);
    expect(after.review).toEqual(signed.review);
    expect(after.attachments).toEqual([]);
    expect(after.events.slice(-2).map(e => e.kind)).toEqual(['attachment_added', 'attachment_removed']);
    expect(after.events.at(-1)!.detail).toMatchObject({ filename: 'IMG_0412.png' });
  });

  it('is a manager\'s, and refuses a voided entry', async () => {
    const id = await record();
    const marcus = await loginAs(MARCUS);
    expect((await upload(id, png(), { token: marcus.token })).status).toBe(403);

    const { attachment } = (await upload(id, png())).body as { attachment: Attachment };
    expect((await api('POST', `/api/accounting/entries/${id}/void`, {
      token: alex.token, body: { reason: 'typo' },
    })).status).toBe(200);
    expect((await upload(id, png())).status).toBe(409);
    expect((await api('DELETE', `/api/accounting/entries/${id}/attachments/${attachment.id}`, { token: alex.token })).status).toBe(409);
    expect((await entry(id)).attachments).toHaveLength(1);
  });

  it('refuses what is not a file it stores, and a screenshot of another entry', async () => {
    const id = await record();
    expect((await multipart(`/api/accounting/entries/${id}/attachments`, {}, { token: alex.token })).status).toBe(400);
    const html = new File(['<script>'], 'x.html', { type: 'text/html' });
    expect((await upload(id, html)).status).toBe(415);
    expect((await upload('AC-404', png())).status).toBe(404);

    const other = await record();
    const { attachment } = (await upload(other, png())).body as { attachment: Attachment };
    expect((await api('DELETE', `/api/accounting/entries/${id}/attachments/${attachment.id}`, { token: alex.token })).status).toBe(404);
    expect((await api('DELETE', `/api/accounting/entries/${id}/attachments/not-a-uuid`, { token: alex.token })).status).toBe(404);
    const [{ n }] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM accounting_entry_attachments`;
    expect(n).toBe(1);
  });

  it('records an entry with no reference, and an edit keeps an old one', async () => {
    const id = await record();
    expect((await entry(id)).reference).toBeNull();
    await getTestDb()`UPDATE accounting_entries SET reference = 'TX-9' WHERE id = ${id}`;
    expect((await api('PATCH', `/api/accounting/entries/${id}`, {
      token: alex.token, body: { note: 'paid in two goes' },
    })).status).toBe(200);
    expect((await entry(id)).reference).toBe('TX-9');
  });
});
