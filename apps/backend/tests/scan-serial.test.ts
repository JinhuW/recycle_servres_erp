import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { multipart } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';
import { normalizeSerial } from '../src/ai/serial';

function jpeg(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'serial.jpg', { type: 'image/jpeg' });
}

describe('normalizeSerial', () => {
  it('sheds a separated label, keeps a serial that itself starts with SN', () => {
    expect(normalizeSerial('SN: 3A12F0C8')).toBe('3A12F0C8');
    expect(normalizeSerial('S/N#WD-WCC4N1234567')).toBe('WD-WCC4N1234567');
    expect(normalizeSerial('Serial No.: 16AB 77CD')).toBe('16AB77CD');
    expect(normalizeSerial('sn 3a12f0c8')).toBe('3a12f0c8');
    expect(normalizeSerial('SNX0K123456')).toBe('SNX0K123456');
  });

  it('rejects junk and out-of-bounds lengths', () => {
    expect(normalizeSerial(null)).toBeNull();
    expect(normalizeSerial(42)).toBeNull();
    expect(normalizeSerial('   ')).toBeNull();
    expect(normalizeSerial('ABC')).toBeNull();                 // under 4 chars
    expect(normalizeSerial('A'.repeat(65))).toBeNull();        // over 64 chars
    expect(normalizeSerial('-LEADING')).toBeNull();
    expect(normalizeSerial('has,comma')).toBeNull();           // would split the serial list
  });
});

describe('POST /api/scan/serial', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('stub path: no key → canned serial', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/serial', { file: jpeg() }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ serial: 'SN-STUB-0001', provider: 'stub' });
  });

  it('openrouter path: the read is normalized; an illegible label answers null', async () => {
    const reply = (content: string) => new Response(
      JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    const fetchMock = vi.fn(async () => reply('{"serial":"S/N: 3A12 F0C8"}'));
    vi.stubGlobal('fetch', fetchMock);
    const { token } = await loginAs(MARCUS);
    const env = { OPENROUTER_API_KEY: 'test-key' };
    const r = await multipart('/api/scan/serial', { file: jpeg() }, { token, env });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ serial: '3A12F0C8', provider: 'openrouter' });

    fetchMock.mockImplementation(async () => reply('{"serial":null}'));
    const none = await multipart('/api/scan/serial', { file: jpeg() }, { token, env });
    expect(none.status).toBe(200);
    expect((none.body as { serial: unknown }).serial).toBeNull();
  });

  it('rejects a missing file and a non-image MIME', async () => {
    const { token } = await loginAs(MARCUS);
    expect((await multipart('/api/scan/serial', {}, { token })).status).toBe(400);
    const pdf = new File([new Uint8Array([0x25, 0x50])], 'doc.pdf', { type: 'application/pdf' });
    expect((await multipart('/api/scan/serial', { file: pdf }, { token })).status).toBe(415);
  });
});
