import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { multipart, api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';
import type { Env } from '../src/types';

// Verifies the R2-configured path end-to-end: /api/scan/label stores the image
// in R2 (via the S3 API) and the public URL flows label_scans → order-line
// JOIN → scanImageUrl (the exact value the mobile/desktop PO previews +
// lightbox render). The @aws-sdk/client-s3 client is mocked; `send` records
// the Put/Delete commands the route issues.

const send = vi.fn(async () => ({}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: function () {
    return { send };
  },
  PutObjectCommand: function (input: unknown) {
    return { __type: 'Put', input };
  },
  DeleteObjectCommand: function (input: unknown) {
    return { __type: 'Delete', input };
  },
}));

function jpeg(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'label.jpg', { type: 'image/jpeg' });
}

const PUBLIC_BASE = 'https://cdn.example.com';
const S3_ENV: Partial<Env> = {
  R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'AK',
  R2_SECRET_ACCESS_KEY: 'SK',
  R2_BUCKET: 'recycle-erp-attachments',
  R2_ATTACHMENTS_PUBLIC_URL: PUBLIC_BASE,
};

type SentCommand = { __type: 'Put' | 'Delete'; input: { Key: string } };
function sent(): SentCommand[] {
  return send.mock.calls.map((c) => c[0] as SentCommand);
}

describe('R2-configured environment: scan image reaches PO lines', () => {
  beforeEach(async () => { await resetDb(); send.mockClear(); });
  afterEach(() => vi.restoreAllMocks());

  it('stores in R2 and resolves a real public URL on the order line', async () => {
    const { token } = await loginAs(MARCUS);

    const scanRes = await multipart(
      '/api/scan/label',
      { file: jpeg(), category: 'RAM' },
      { token, env: S3_ENV },
    );
    expect(scanRes.status).toBe(200);
    const sb = scanRes.body as { imageId: string; deliveryUrl: string };

    // Bytes were written to R2 under the label-scans/ prefix.
    expect(sent().filter((c) => c.__type === 'Put')).toHaveLength(1);
    expect(sb.imageId).toMatch(/^label-scans\//);
    expect(sb.imageId.startsWith('stub-')).toBe(false);

    // Real public URL, not a stub placeholder.
    expect(sb.deliveryUrl).toBe(`${PUBLIC_BASE}/${sb.imageId}`);
    expect(sb.deliveryUrl.startsWith('data:image/placeholder')).toBe(false);

    // Persisted to label_scans.
    const sql = getTestDb();
    const rows = await sql`
      SELECT cf_image_id, delivery_url FROM label_scans WHERE cf_image_id = ${sb.imageId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].delivery_url).toBe(sb.deliveryUrl);

    // Order line referencing the scan resolves scanImageUrl via the JOIN.
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          condition: 'Pulled — Tested', qty: 1, unitCost: 50,
          scanImageId: sb.imageId, scanConfidence: 0.9,
        }],
      },
    });
    expect(created.status).toBe(201);

    const got = await api<{ order: { lines: { scanImageId: string; scanImageUrl: string | null }[] } }>(
      'GET', '/api/orders/' + created.body.id, { token },
    );
    expect(got.status).toBe(200);
    const line = got.body.order.lines[0];
    expect(line.scanImageId).toBe(sb.imageId);
    expect(line.scanImageUrl).toBe(sb.deliveryUrl);

    // Frontend realScan() guard: truthy and not a placeholder → renders.
    const realScan = (uurl?: string | null): uurl is string =>
      !!uurl && !uurl.startsWith('data:image/placeholder');
    expect(realScan(line.scanImageUrl)).toBe(true);
  });

  async function scanAndOrder(token: string) {
    const env = S3_ENV;
    const scanRes = await multipart('/api/scan/label', { file: jpeg(), category: 'RAM' }, { token, env });
    const key = (scanRes.body as { imageId: string }).imageId;
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          condition: 'Pulled — Tested', qty: 1, unitCost: 50, scanImageId: key,
        }],
      },
    });
    const got = await api<{ order: { lines: { id: string }[] } }>(
      'GET', '/api/orders/' + created.body.id, { token },
    );
    return { env, key, orderId: created.body.id, lineId: got.body.order.lines[0].id };
  }

  it('removing a line deletes its label image from R2', async () => {
    const { token } = await loginAs(MARCUS);
    const { env, key, orderId, lineId } = await scanAndOrder(token);

    const r = await api('PATCH', '/api/orders/' + orderId, {
      token, env, body: { removeLineIds: [lineId] },
    });
    expect(r.status).toBe(200);
    const deletes = sent().filter((c) => c.__type === 'Delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key).toBe(key);
  });

  it('deleting a draft order deletes its line label images from R2', async () => {
    const { token } = await loginAs(MARCUS);
    const { env, key, orderId } = await scanAndOrder(token);

    const r = await api('DELETE', '/api/orders/' + orderId, { token, env });
    expect(r.status).toBe(200);
    const deletes = sent().filter((c) => c.__type === 'Delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key).toBe(key);
  });

  it('stub fallback (no R2) stays a filtered placeholder', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/label', { file: jpeg(), category: 'RAM' }, { token });
    expect(r.status).toBe(200);
    const b = r.body as { deliveryUrl: string };
    expect(b.deliveryUrl.startsWith('data:image/placeholder')).toBe(true);
  });
});
