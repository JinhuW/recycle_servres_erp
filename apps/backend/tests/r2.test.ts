import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/types';

// Under isolate:false, multiple test files share one module registry.  Any
// file that imports the app (e.g. sell-orders.test.ts) pulls in src/r2.ts and
// binds the real @aws-sdk/client-s3 S3Client before this file can mock it via
// a hoisted vi.mock, making the mock invisible to r2.ts.
//
// Fix: skip hoisted vi.mock entirely.  Instead, beforeEach calls
// vi.resetModules() to clear the module cache, registers the mock via
// vi.doMock (not hoisted), then dynamically imports a fresh r2.ts that
// resolves S3Client from the mock.  afterEach unmocks so later files are
// unaffected.

let send: ReturnType<typeof vi.fn>;
let uploadAttachment: typeof import('../src/r2').uploadAttachment;
let deleteAttachment: typeof import('../src/r2').deleteAttachment;

const s3Env: Env = {
  JWT_SECRET: 'x',
  R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'AK',
  R2_SECRET_ACCESS_KEY: 'SK',
  R2_BUCKET: 'recycle-erp-attachments',
  R2_ATTACHMENTS_PUBLIC_URL: 'https://cdn.example.com',
};

function jpeg(): File {
  return new File([new Uint8Array([0xff, 0xd8])], 'My Label.jpg', { type: 'image/jpeg' });
}

beforeEach(async () => {
  send = vi.fn();
  send.mockResolvedValue({});
  vi.resetModules();
  vi.doMock('@aws-sdk/client-s3', () => ({
    S3Client: function () { return { send }; },
    PutObjectCommand: function (input: unknown) { return { __type: 'Put', input }; },
    DeleteObjectCommand: function (input: unknown) { return { __type: 'Delete', input }; },
  }));
  const r2 = await import('../src/r2');
  uploadAttachment = r2.uploadAttachment;
  deleteAttachment = r2.deleteAttachment;
});

afterEach(() => {
  vi.doUnmock('@aws-sdk/client-s3');
});

describe('r2 via S3 API', () => {
  it('uploads to S3 and returns a real public URL', async () => {
    const r = await uploadAttachment(s3Env, jpeg(), 'label-scans');
    expect(r.provider).toBe('r2');
    expect(r.storageKey).toMatch(/^label-scans\/[0-9a-f-]+-My_Label\.jpg$/);
    expect(r.deliveryUrl).toBe(`https://cdn.example.com/${r.storageKey}`);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns a stub when S3 is unconfigured', async () => {
    const r = await uploadAttachment({ JWT_SECRET: 'x' } as Env, jpeg(), 'p');
    expect(r.provider).toBe('stub');
    expect(r.storageKey.startsWith('stub-')).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes a real key, skips stub keys', async () => {
    await deleteAttachment(s3Env, 'label-scans/abc-x.jpg');
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();
    await deleteAttachment(s3Env, 'stub-123');
    expect(send).not.toHaveBeenCalled();
  });
});
