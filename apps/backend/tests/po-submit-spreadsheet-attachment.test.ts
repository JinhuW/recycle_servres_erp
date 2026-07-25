import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';
import { maybeRenameReceipt } from '../src/ai/receipt';

// Vendors send lot manifests and price lists as spreadsheets, so the PO
// Submission dropzone accepts .xlsx and .csv alongside receipts. The gate is
// three-layered (stored workspace setting ∩ SAFE_UPLOAD_MIME, then the storage
// layer), and getUploadLimits intersects rather than unions — so the seeded
// setting has to be widened by migration too, not just the constant.

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function draftOrder(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{
        category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        partNumber: 'PO-SHEET-1', condition: 'Pulled — Tested', qty: 2, unitCost: 50,
      }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

// A real ZIP local-file-header, so the bytes match what an .xlsx actually is.
const XLSX = () =>
  new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'manifest.xlsx', { type: XLSX_MIME });
const CSV = () =>
  new File(['part,qty\nM393A4K40DB3,50\n'], 'manifest.csv', { type: 'text/csv' });

describe('PO Submission attachments — spreadsheets', () => {
  beforeEach(async () => { await resetDb(); });

  it('accepts an .xlsx and round-trips its MIME type', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftOrder(token);

    const up = await multipart(
      `/api/orders/${id}/status-meta/Submission/attachments`,
      { file: XLSX() },
      { token },
    );
    expect(up.status).toBe(200);
    const att = (up.body as { attachment: { filename: string; mime: string } }).attachment;
    expect(att.mime).toBe(XLSX_MIME);
    expect(att.filename).toBe('manifest.xlsx');
  });

  it('accepts a .csv', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftOrder(token);

    const up = await multipart(
      `/api/orders/${id}/status-meta/Submission/attachments`,
      { file: CSV() },
      { token },
    );
    expect(up.status).toBe(200);
    expect((up.body as { attachment: { mime: string } }).attachment.mime).toBe('text/csv');
  });

  // .xls is an OLE container and the usual macro-malware wrapper; the bucket is
  // public, so it stays off the list even though sheets are now allowed.
  it('still rejects legacy .xls and macro-enabled .xlsm with 415', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftOrder(token);

    for (const [name, mime] of [
      ['book.xls', 'application/vnd.ms-excel'],
      ['book.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
    ]) {
      const r = await multipart(
        `/api/orders/${id}/status-meta/Submission/attachments`,
        { file: new File([new Uint8Array([0x00])], name, { type: mime }) },
        { token },
      );
      expect(r.status, `${name} must be refused`).toBe(415);
    }
  });

  it('still rejects text/html with 415', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftOrder(token);

    const r = await multipart(
      `/api/orders/${id}/status-meta/Submission/attachments`,
      { file: new File(['<script>alert(1)</script>'], 'evil.html', { type: 'text/html' }) },
      { token },
    );
    expect(r.status).toBe(415);
  });

  it('a workspace setting cannot widen acceptance beyond the hard allowlist', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await draftOrder(token);

    await getTestDb()`
      UPDATE workspace_settings
      SET value = '["text/html","application/vnd.ms-excel"]'::jsonb
      WHERE key = 'upload_allowed_mime'
    `;

    const r = await multipart(
      `/api/orders/${id}/status-meta/Submission/attachments`,
      { file: new File(['<b>x</b>'], 'evil.html', { type: 'text/html' }) },
      { token },
    );
    expect(r.status).toBe(415);
  });
});

describe('receipt auto-rename — non-image guard', () => {
  // maybeRenameReceipt used to return early only for application/pdf and treat
  // everything else as an image. Once spreadsheets are accepted that would ship
  // .xlsx bytes to OpenRouter as an image on every upload. Asserting on the
  // return value alone is not enough — a failed call also returns the original
  // file — so this watches the network instead.
  it('returns a spreadsheet untouched without calling the OCR provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const file = XLSX();
      const out = await maybeRenameReceipt(
        { OPENROUTER_API_KEY: 'sk-test-should-not-be-used' } as never,
        file,
      );
      expect(out).toBe(file);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
