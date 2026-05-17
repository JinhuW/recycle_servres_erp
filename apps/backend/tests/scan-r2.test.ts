import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

// Verifies the R2-configured path end-to-end: /api/scan/label stores the image
// in R2 (via the S3 API) and the public URL flows label_scans → order-line
// JOIN → scanImageUrl (the exact value the mobile/desktop PO previews +
// lightbox render).
//
// Integration test: exercises the REAL src/routes/scan.ts → REAL src/r2.ts.
// ONLY the external @aws-sdk/client-s3 boundary is mocked.
//
// isolate:false safety: a hoisted vi.mock for @aws-sdk/client-s3 cannot
// intercept the S3Client already bound into src/r2.ts when other test files
// (e.g. sell-orders.test.ts) import the app before this file runs.  Instead,
// beforeEach calls vi.resetModules() to clear the module cache, registers the
// mock via vi.doMock (not hoisted), then dynamically imports a fresh copy of
// helpers/app (and helpers/auth) so the full
//   app → scan route → r2.ts → (mocked) @aws-sdk/client-s3
// chain binds to the mock — the same technique as r2.test.ts, applied at the
// app-graph level.  src/r2.ts and src/routes/* are never spied on or replaced.

// DB helpers use only postgres + Node built-ins — no app-graph dependency.
// Safe as static imports; resetModules does not affect them.
const MARCUS = 'marcus@recycleservers.io';

let send: ReturnType<typeof vi.fn>;

// Dynamically-imported helpers (refreshed each beforeEach after doMock).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let multipart: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let api: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loginAs: (...args: any[]) => Promise<any>;

type SentCommand = { __type: 'Put' | 'Delete'; input: { Key: string } };
function sent(): SentCommand[] {
  return send.mock.calls.map((c) => c[0] as SentCommand);
}

function jpeg(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'label.jpg', { type: 'image/jpeg' });
}

const PUBLIC_BASE = 'https://cdn.example.com';
const S3_ENV = {
  R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'AK',
  R2_SECRET_ACCESS_KEY: 'SK',
  R2_BUCKET: 'recycle-erp-attachments',
  R2_ATTACHMENTS_PUBLIC_URL: PUBLIC_BASE,
};

beforeEach(async () => {
  await resetDb();
  send = vi.fn();
  send.mockResolvedValue({});

  // Reset the module registry so a fresh import of src/index (via helpers/app)
  // will re-resolve @aws-sdk/client-s3 from the doMock registry below, not
  // from a previously-cached real binding.
  vi.resetModules();

  // Register the mock BEFORE any dynamic import that transitively requires
  // @aws-sdk/client-s3.  function-expression constructors are required —
  // Vitest 4.1.5 will not invoke arrow-fn vi.fn mocks via `new`.
  vi.doMock('@aws-sdk/client-s3', () => ({
    S3Client: function () { return { send }; },
    PutObjectCommand: function (input: unknown) { return { __type: 'Put', input }; },
    DeleteObjectCommand: function (input: unknown) { return { __type: 'Delete', input }; },
  }));

  // Dynamically import helpers/app and helpers/auth AFTER doMock so they pull
  // in a fresh src/index → src/routes/scan → src/r2 → (mocked) @aws-sdk chain.
  // helpers/auth imports helpers/app, so both share the same fresh testEnv
  // (same JWT_SECRET) — login tokens issued by one are accepted by the other.
  const appModule = await import('./helpers/app');
  const authModule = await import('./helpers/auth');
  multipart = appModule.multipart;
  api = appModule.api;
  loginAs = authModule.loginAs;
});

afterEach(() => {
  vi.doUnmock('@aws-sdk/client-s3');
});

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
    const created = await api('POST', '/api/orders', {
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

    const got = await api(
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
    const created = await api('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          condition: 'Pulled — Tested', qty: 1, unitCost: 50, scanImageId: key,
        }],
      },
    });
    const got = await api(
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
