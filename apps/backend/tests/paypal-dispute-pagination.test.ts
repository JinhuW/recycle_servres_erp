import { afterEach, describe, it, expect, vi } from 'vitest';
import { paypalProvider } from '../src/banktx/paypal';
import type { Env } from '../src/types';

// PayPal's own `self` link carries a next_page_token= from page 2 on, so a
// next-page rule that matches only the token can hand back the page just
// fetched. Every summary costs a detail GET, so a loop that fails to advance is
// a thousand round trips and a case list truncated at the first page — and
// DISPUTE_MAX_PAGES turns that into silence rather than a failure.

const env = {
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'secret',
  PAYPAL_ENV: 'sandbox',
} as unknown as Env;

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

/** Stubs the token mint plus a disputes list whose pages are supplied by `page`. */
function stub(page: (url: string) => unknown) {
  const listCalls: string[] = [];
  const detailCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/v1/oauth2/token')) return json({ access_token: 'tok', expires_in: 32400 });
    if (/\/v1\/customer\/disputes\/[^?]/.test(url)) {
      detailCalls.push(url);
      return json({ dispute_id: url.split('/').pop() });
    }
    listCalls.push(url);
    return json(page(url));
  }));
  return { listCalls, detailCalls };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('paypal dispute pagination', () => {
  it('stops when the next link points at the page just fetched', async () => {
    // The trap in the wild: `self` sorts first and carries the token, so a
    // token-only match re-reads page 1 until the page cap runs out.
    const { listCalls, detailCalls } = stub(() => ({
      items: [{ dispute_id: 'PP-D-1' }],
      links: [
        { href: 'https://api.sandbox.paypal.com/v1/customer/disputes?next_page_token=SAME', rel: 'self' },
      ],
    }));

    const out = await paypalProvider(env).fetchDisputes!();

    expect(listCalls).toHaveLength(2);
    expect(out).toHaveLength(2);
    expect(detailCalls).toHaveLength(2);
  });

  it('follows rel=next past a self link that also carries the token', async () => {
    const { listCalls } = stub((url) => (
      url.includes('PAGE2')
        ? {
          items: [{ dispute_id: 'PP-D-2' }],
          links: [{ href: url, rel: 'self' }],
        }
        : {
          items: [{ dispute_id: 'PP-D-1' }],
          links: [
            { href: 'https://api.sandbox.paypal.com/v1/customer/disputes?next_page_token=SELF', rel: 'self' },
            { href: 'https://api.sandbox.paypal.com/v1/customer/disputes?next_page_token=PAGE2', rel: 'next' },
          ],
        }
    ));

    const out = await paypalProvider(env).fetchDisputes!();

    expect(listCalls[1]).toContain('PAGE2');
    expect(out.map(d => d.disputeId)).toEqual(['PP-D-1', 'PP-D-2']);
  });

  it('still paginates when PayPal sends no rel at all', async () => {
    const { listCalls } = stub((url) => (
      url.includes('PAGE2')
        ? { items: [{ dispute_id: 'PP-D-2' }], links: [] }
        : {
          items: [{ dispute_id: 'PP-D-1' }],
          links: [{ href: 'https://api.sandbox.paypal.com/v1/customer/disputes?next_page_token=PAGE2' }],
        }
    ));

    const out = await paypalProvider(env).fetchDisputes!();

    expect(listCalls).toHaveLength(2);
    expect(out.map(d => d.disputeId)).toEqual(['PP-D-1', 'PP-D-2']);
  });
});
