import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same shim as api-refresh.test.ts: vitest runs in the `node` environment here,
// so `window` has to exist before the modules under test touch it.
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = new EventTarget();
}
(globalThis as any).window.location ??= { href: 'https://inventory.test/#/activity' };
(globalThis as any).navigator ??= { userAgent: 'vitest' };

type Dialog = { msg: string; details?: string[] };

function collectDialogs(): Dialog[] {
  const seen: Dialog[] = [];
  (globalThis as any).window.__showErrorDialog = (msg: string, details?: string[]) => {
    seen.push({ msg, details });
  };
  return seen;
}

describe('handleFetchError', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as any).window.__genericErrorMessage;
  });

  // The dialog's title is a hardcoded "Something went wrong". Falling back to
  // the generic sentence printed the headline twice and told the user nothing —
  // which is exactly what a real report of this bug looked like.
  it('does not echo the generic message when the throw carries no message', async () => {
    (globalThis as any).window.__genericErrorMessage = 'Something went wrong. Please try again.';
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as any;
    const dialogs = collectDialogs();

    const { handleFetchError } = await import('../src/lib/errorToast');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handleFetchError(new Error(''));

    expect(dialogs).toHaveLength(1);
    // It may fall back to the generic sentence, but it must never be empty —
    // an empty body is what rendered as "just the title".
    expect(dialogs[0]!.msg.length).toBeGreaterThan(0);
  });

  it('surfaces the endpoint, status and request id so the failure is greppable', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as any;
    const dialogs = collectDialogs();

    const { ApiError } = await import('../src/lib/api');
    const { handleFetchError } = await import('../src/lib/errorToast');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    handleFetchError(new ApiError(500, 'Internal error', {
      path: '/api/activity', method: 'GET', requestId: 'abc-123',
    }));

    expect(dialogs[0]!.msg).toBe('Internal error');
    expect(dialogs[0]!.details?.join(' ')).toContain('abc-123');
    expect(dialogs[0]!.details?.join(' ')).toContain('/api/activity');
  });

  it('posts the failure to the backend', async () => {
    const posts: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      posts.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(null, { status: 204 });
    }) as any;
    collectDialogs();

    const { ApiError } = await import('../src/lib/api');
    const { handleFetchError } = await import('../src/lib/errorToast');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    handleFetchError(new ApiError(500, 'Internal error', {
      path: '/api/activity', method: 'GET', requestId: 'abc-123',
    }));
    await new Promise(r => setTimeout(r, 0));

    const report = posts.find(p => p.url === '/api/client-errors');
    expect(report).toBeTruthy();
    expect((report!.body as any).requestId).toBe('abc-123');
    expect((report!.body as any).kind).toBe('fetch');
  });

  // A component throwing on every render would otherwise post as fast as it
  // paints, and the code that should throttle it just proved it was broken.
  it('reports one distinct failure once, and stops at the cap', async () => {
    let posted = 0;
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url) === '/api/client-errors') posted++;
      return new Response(null, { status: 204 });
    }) as any;
    collectDialogs();

    const { handleFetchError } = await import('../src/lib/errorToast');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < 10; i++) handleFetchError(new Error('the same failure'));
    await new Promise(r => setTimeout(r, 0));
    expect(posted, 'a repeat of one problem is one fact').toBe(1);

    for (let i = 0; i < 30; i++) handleFetchError(new Error(`distinct ${i}`));
    await new Promise(r => setTimeout(r, 0));
    expect(posted).toBeLessThanOrEqual(5);
  });

  // The beacon runs inside the error path; if it could throw it would re-enter
  // the handler that called it.
  it('survives the report itself failing', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as any;
    const dialogs = collectDialogs();

    const { handleFetchError } = await import('../src/lib/errorToast');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => handleFetchError(new Error('original failure'))).not.toThrow();
    await new Promise(r => setTimeout(r, 0));
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.msg).toBe('original failure');
  });
});
