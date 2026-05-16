import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () { return { send }; }),
  PutObjectCommand: vi.fn(function (input) { return { __type: 'Put', input }; }),
  DeleteObjectCommand: vi.fn(function (input) { return { __type: 'Delete', input }; }),
}));

import { uploadAttachment, deleteAttachment } from '../src/r2';
import type { Env } from '../src/types';

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

describe('r2 via S3 API', () => {
  beforeEach(() => { send.mockReset(); send.mockResolvedValue({}); });

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
