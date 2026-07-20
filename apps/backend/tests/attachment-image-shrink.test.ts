import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sharp from 'sharp';
import { resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { shrinkImageToFit } from '../src/lib/image-shrink';
import { freeSellableLine } from './helpers/inventory';

// Oversized image uploads must be shrunk server-side to fit the workspace
// upload cap instead of bouncing with 413 — receipts come off phones as
// multi-MB screenshots. Non-images (PDF) keep the hard reject: there is no
// safe lossy recompression for them.

const TODAY = new Date().toISOString().slice(0, 10);
const KEY = { OPENROUTER_API_KEY: 'test-key' };

// Deterministic per-pixel noise defeats JPEG/PNG compression, so a small
// canvas still produces a reliably large file.
function noiseRaw(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < buf.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = seed & 0xff;
  }
  return buf;
}

async function noiseJpeg(width: number, height: number): Promise<Buffer> {
  return sharp(noiseRaw(width, height), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
}

async function noisePng(width: number, height: number): Promise<Buffer> {
  return sharp(noiseRaw(width, height), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

function asFile(buf: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(buf)], name, { type });
}

function mockModel(content: string) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  ));
}

async function createPurchaseOrder(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{
        category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        partNumber: 'SHRK-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
      }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function createDraftSellOrder(token: string): Promise<string> {
  const line = await freeSellableLine(token);
  const cust = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId: cust.body.items[0].id,
      lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: 1, unitPrice: line.sell_price }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

type UploadedAttachment = { attachment: { filename: string; size: number; mime: string } };

describe('shrinkImageToFit', () => {
  it('returns the file untouched when already within the cap', async () => {
    const file = asFile(await noiseJpeg(64, 64), 'small.jpg', 'image/jpeg');
    expect(await shrinkImageToFit(file, 10 * 1024 * 1024)).toBe(file);
  });

  it('returns non-images untouched even when oversized', async () => {
    const file = asFile(Buffer.alloc(200_000, 0x25), 'doc.pdf', 'application/pdf');
    expect(await shrinkImageToFit(file, 100_000)).toBe(file);
  });

  it('shrinks an oversized JPEG under the cap, keeping name and type', async () => {
    const big = await noiseJpeg(1400, 1400);
    expect(big.byteLength).toBeGreaterThan(120_000);
    const out = await shrinkImageToFit(asFile(big, 'receipt.jpg', 'image/jpeg'), 120_000);
    expect(out.size).toBeLessThanOrEqual(120_000);
    expect(out.size).toBeGreaterThan(0);
    expect(out.name).toBe('receipt.jpg');
    expect(out.type).toBe('image/jpeg');
  });

  it('shrinks an oversized PNG under the cap', async () => {
    const big = await noisePng(1200, 1200);
    expect(big.byteLength).toBeGreaterThan(120_000);
    const out = await shrinkImageToFit(asFile(big, 'shot.png', 'image/png'), 120_000);
    expect(out.size).toBeLessThanOrEqual(120_000);
    expect(out.type).toBe('image/png');
  });

  it('returns the original when the bytes are not decodable as an image', async () => {
    const file = asFile(Buffer.alloc(150_000, 0xab), 'broken.png', 'image/png');
    expect(await shrinkImageToFit(file, 100_000)).toBe(file);
  });
});

describe('attachment upload shrink — purchase orders', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts an image over upload_max_bytes by shrinking it under the cap', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createPurchaseOrder(token);
    const cap = 120_000;
    expect((await api('PATCH', '/api/workspace', { token, body: { upload_max_bytes: cap } })).status).toBe(200);

    const big = await noiseJpeg(1400, 1400);
    expect(big.byteLength).toBeGreaterThan(cap);
    const r = await multipart(
      `/api/orders/${id}/status-meta/Done/attachments`,
      { file: asFile(big, 'IMG_9001.jpg', 'image/jpeg') },
      { token },
    );
    expect(r.status).toBe(200);
    const { attachment } = r.body as UploadedAttachment;
    expect(attachment.size).toBeLessThanOrEqual(cap);
    expect(attachment.mime).toBe('image/jpeg');
  });

  it('runs the AI rename on the shrunk image', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createPurchaseOrder(token);
    expect((await api('PATCH', '/api/workspace', { token, body: { upload_max_bytes: 120_000 } })).status).toBe(200);
    mockModel('{"method":"zelle","amount":"980.00"}');

    const big = await noiseJpeg(1400, 1400);
    const r = await multipart(
      `/api/orders/${id}/status-meta/Done/attachments`,
      { file: asFile(big, 'IMG_9002.jpg', 'image/jpeg') },
      { token, env: KEY },
    );
    expect(r.status).toBe(200);
    const { attachment } = r.body as UploadedAttachment;
    expect(attachment.filename).toBe(`${TODAY}-zelle-980.00.jpg`);
    expect(attachment.size).toBeLessThanOrEqual(120_000);
  });

  it('still rejects a non-image over the cap with 413', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createPurchaseOrder(token);
    expect((await api('PATCH', '/api/workspace', { token, body: { upload_max_bytes: 100_000 } })).status).toBe(200);

    const r = await multipart(
      `/api/orders/${id}/status-meta/Done/attachments`,
      { file: asFile(Buffer.alloc(200_000, 0x25), 'doc.pdf', 'application/pdf') },
      { token },
    );
    expect(r.status).toBe(413);
  });

  // Regression: the PO attachments path was missing from the upload body-cap
  // allowlist, so anything over the global 1 MiB JSON cap 413'd before the
  // route ever ran.
  it('accepts a multipart body over 1 MiB on the PO attachments path', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createPurchaseOrder(token);

    const big = await noiseJpeg(3000, 3000);
    expect(big.byteLength).toBeGreaterThan(1_048_576);
    const r = await multipart(
      `/api/orders/${id}/status-meta/Done/attachments`,
      { file: asFile(big, 'IMG_9003.jpg', 'image/jpeg') },
      { token },
    );
    expect(r.status).toBe(200);
  });
});

describe('attachment upload shrink — sell orders', () => {
  beforeEach(async () => { await resetDb(); });

  it('accepts an image over upload_max_bytes by shrinking it under the cap', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const cap = 120_000;
    expect((await api('PATCH', '/api/workspace', { token, body: { upload_max_bytes: cap } })).status).toBe(200);

    const big = await noiseJpeg(1400, 1400);
    expect(big.byteLength).toBeGreaterThan(cap);
    const r = await multipart(
      `/api/sell-orders/${id}/status-meta/Shipped/attachments`,
      { file: asFile(big, 'label.jpg', 'image/jpeg') },
      { token },
    );
    expect(r.status).toBe(200);
    const { attachment } = r.body as UploadedAttachment;
    expect(attachment.size).toBeLessThanOrEqual(cap);
  });
});
