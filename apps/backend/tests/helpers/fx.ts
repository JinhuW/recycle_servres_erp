import { vi } from 'vitest';

// Stubs global fetch with a Frankfurter `latest` response quoting 1 USD = `rate`
// CNY. vi.stubGlobal rather than undici MockAgent, which isn't installed.
export function mockFrankfurter(rate: number, date: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ amount: 1, base: 'USD', date, rates: { CNY: rate } }),
        { status: 200 },
      ),
    ),
  );
}
