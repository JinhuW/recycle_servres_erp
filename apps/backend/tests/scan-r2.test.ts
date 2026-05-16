import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { multipart, api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';
import type { Env } from '../src/types';
import * as r2module from '../src/r2';

// Verifies the R2-configured path end-to-end: /api/scan/label stores the image
// in R2 (via the S3 API) and the public URL flows label_scans → order-line
// JOIN → scanImageUrl (the exact value the mobile/desktop PO previews +
// lightbox render).
//
// isolate:false safety: a hoisted vi.mock for @aws-sdk/client-s3 cannot
// intercept the S3Client already bound into src/r2.ts when other test files
// (e.g. sell-orders.test.ts) import the app before this file runs.  Instead
// we spy on the r2 module's exported functions, whose namespace bindings
// Vitest's module runner DOES propagate to callers regardless of import order.
// The spy implementations call send with the same Put/Delete command shapes
// that r2.ts would produce, so all existing sent() assertions remain intact.

let send: ReturnType<typeof vi.fn>;

type SentCommand = { __type: 'Put' | 'Delete'; input: { Key: string } };
function sent(): SentCommand[] {
  return send.mock.calls.map((c) => c[0] as SentCommand);
}

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

beforeEach(async () => {
  await resetDb();
  send = vi.fn(async () => ({}));

  // Spy on uploadAttachment: honour the stub path (no R2 env vars) and
  // simulate the R2 path by calling send with the same Put-command shape
  // that r2.ts produces, so sent().filter(c => c.__type === 'Put') works.
  vi.spyOn(r2module, 'uploadAttachment').mockImplementation(async (env: Env, file: File, prefix: string) => {
    if (
      !env.R2_S3_ENDPOINT ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY ||
      !env.R2_BUCKET ||
      !env.R2_ATTACHMENTS_PUBLIC_URL
    ) {
      return {
        storageKey: 'stub-' + crypto.randomUUID(),
        deliveryUrl: 'data:image/placeholder;name=' + encodeURIComponent(file.name),
        provider: 'stub' as const,
      };
    }
    const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
    const storageKey = prefix + '/' + crypto.randomUUID() + '-' + safeName;
    await send({ __type: 'Put', input: { Bucket: env.R2_BUCKET, Key: storageKey, ContentType: file.type } });
    return {
      storageKey,
      deliveryUrl: env.R2_ATTACHMENTS_PUBLIC_URL.replace(/\/$/, '') + '/' + storageKey,
      provider: 'r2' as const,
    };
  });

  // Spy on deleteAttachment: skip stub keys, call send with a Delete-command
  // shape so sent().filter(c => c.__type === 'Delete') and Key assertions work.
  vi.spyOn(r2module, 'deleteAttachment').mockImplementation(async (env: Env, storageKey: string) => {
    if (storageKey.startsWith('stub-')) return;
    await send({ __type: 'Delete', input: { Bucket: env.R2_BUCKET, Key: storageKey } });
  });
});

afterEach(() => vi.restoreAllMocks());

describe('R2-configured environment: scan image reaches PO lines', () => {
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
    expect(sb.deliveryUrl).toBe(PUBLIC_BASE + '/' + sb.imageId);
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

    // Frontend realScan() guard: truthy and not a placeholder -> renders.
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

    send.mockClear();
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

    send.mockClear();
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
