import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { multipart } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'label.jpg', { type: 'image/jpeg' });

describe('POST /api/scan/label — upload limits', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects a non-image file (415)', async () => {
    const { token } = await loginAs(MARCUS);
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf', { type: 'application/pdf' });
    const r = await multipart('/api/scan/label', { file: pdf, category: 'RAM' }, { token });
    expect(r.status).toBe(415);
  });

  it('rejects an oversized file (413)', async () => {
    const { token } = await loginAs(MARCUS);
    // 11 MB > the 10 MB default upload cap.
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.jpg', { type: 'image/jpeg' });
    const r = await multipart('/api/scan/label', { file: big, category: 'RAM' }, { token });
    expect(r.status).toBe(413);
  });

  it('still accepts a small valid image', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/label', { file: jpeg(), category: 'RAM' }, { token });
    expect(r.status).toBe(200);
  });
});
