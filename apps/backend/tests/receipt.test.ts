import { describe, it, expect, afterEach, vi } from 'vitest';
import { normalizeAmount, buildReceiptName, maybeRenameReceipt } from '../src/ai/receipt';
import type { Env } from '../src/types';

describe('normalizeAmount', () => {
  it.each([
    ['1,250.00', '1250.00'],
    ['¥1250', '1250.00'],
    ['￥１，２５０', '1250.00'],
    ['$980', '980.00'],
    ['1234.5', '1234.50'],
    ['1250.00 CNY', '1250.00'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeAmount(raw)).toBe(want);
  });

  it('accepts a numeric value', () => {
    expect(normalizeAmount(980)).toBe('980.00');
  });

  it.each([['abc'], [null], [undefined], ['0'], ['-12.50'], [''], [{}]])(
    'rejects %s',
    (raw) => {
      expect(normalizeAmount(raw)).toBeNull();
    },
  );
});

describe('buildReceiptName', () => {
  const now = new Date('2026-07-06T12:00:00Z');

  it('composes date-method-amount.ext', () => {
    expect(buildReceiptName('alipay', '1250.00', 'IMG_2041.png', 'image/png', now))
      .toBe('2026-07-06-alipay-1250.00.png');
  });

  it('lowercases the original extension', () => {
    expect(buildReceiptName('zelle', '980.00', 'RECEIPT.JPEG', 'image/jpeg', now))
      .toBe('2026-07-06-zelle-980.00.jpeg');
  });

  it('falls back to the MIME map when the name has no extension', () => {
    expect(buildReceiptName('bank', '42.00', 'receipt', 'image/webp', now))
      .toBe('2026-07-06-bank-42.00.webp');
  });
});

describe('maybeRenameReceipt', () => {
  afterEach(() => vi.unstubAllGlobals());

  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'IMG_2041.png', { type: 'image/png' });

  function mockModel(content: string) {
    const fn = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('renames on a clean extraction, preserving bytes and type', async () => {
    mockModel('{"method":"alipay","amount":"1250.00"}');
    const out = await maybeRenameReceipt({ OPENROUTER_API_KEY: 'k' } as Env, png());
    expect(out.name).toMatch(/^\d{4}-\d{2}-\d{2}-alipay-1250\.00\.png$/);
    expect(out.type).toBe('image/png');
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it('re-normalizes a symbol-laden amount from the model', async () => {
    mockModel('{"method":"weixinpay","amount":"¥1,250.00"}');
    const out = await maybeRenameReceipt({ OPENROUTER_API_KEY: 'k' } as Env, png());
    expect(out.name).toMatch(/-weixinpay-1250\.00\.png$/);
  });

  it('keeps the original name when the model returns nulls', async () => {
    mockModel('{"method":null,"amount":null}');
    const out = await maybeRenameReceipt({ OPENROUTER_API_KEY: 'k' } as Env, png());
    expect(out.name).toBe('IMG_2041.png');
  });

  it('keeps the original name for a method outside the enum', async () => {
    mockModel('{"method":"wechat","amount":"1250.00"}');
    const out = await maybeRenameReceipt({ OPENROUTER_API_KEY: 'k' } as Env, png());
    expect(out.name).toBe('IMG_2041.png');
  });

  it('keeps the original name on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const out = await maybeRenameReceipt({ OPENROUTER_API_KEY: 'k' } as Env, png());
    expect(out.name).toBe('IMG_2041.png');
  });

  it('no API key → original name and no fetch at all', async () => {
    const fn = mockModel('{"method":"alipay","amount":"1250.00"}');
    const out = await maybeRenameReceipt({} as Env, png());
    expect(out.name).toBe('IMG_2041.png');
    expect(fn).not.toHaveBeenCalled();
  });

  it('PDF → original name and no fetch at all', async () => {
    const fn = mockModel('{"method":"alipay","amount":"1250.00"}');
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'confirmation.pdf', { type: 'application/pdf' });
    const out = await maybeRenameReceipt({ OPENROUTER_API_KEY: 'k' } as Env, pdf);
    expect(out.name).toBe('confirmation.pdf');
    expect(fn).not.toHaveBeenCalled();
  });
});
