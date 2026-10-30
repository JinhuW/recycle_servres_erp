import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The proxy form and the Add / Remove dialogs render to markup with the
// fetchers swapped out and the modal shell reduced to its children (it reads
// `document`). With no language provider `t` answers its key.
vi.mock('../../../lib/fleet', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fleet')>('../../../lib/fleet');
  const never = () => new Promise(() => undefined);
  return { ...actual, fleetApi: Object.fromEntries(Object.keys(actual.fleetApi).map(k => [k, vi.fn(never)])) };
});
vi.mock('../../../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <div className="modal">{children}</div> }));
vi.mock('../../../lib/errorToast', () => ({ handleFetchError: vi.fn(), showSuccessToast: vi.fn(), showWarnToast: vi.fn() }));

const { PROXIES, SLOTS } = await import('./fixtures');
const { AddToFleetDialog, ProxyDialog, RemoveFromFleetDialog } = await import('./FleetProxies');
const noop = () => undefined;

describe('Proxy form', () => {
  it('opens the edit form with the URL field empty and write-only', () => {
    const html = renderToString(<ProxyDialog proxy={PROXIES[0]} onClose={noop} onDone={noop} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('fleetProxyUrlKeep');
    expect(html).toMatch(/type="password"[^>]*value=""/);
  });
});

describe('Add to fleet', () => {
  it('defaults to a random proxy with room and lists each proxy with its load, the full one disabled', () => {
    const html = renderToString(<AddToFleetDialog no={40} proxies={PROXIES} limit={2} onClose={noop} onDone={noop} />);
    expect(html).toContain('fpAddToFleetTitle');
    expect(html).toMatch(/<option value=""[^>]*selected=""[^>]*>fpAddToFleetRandom/);
    expect(html).toContain('Decodo NY 2');
    expect(html).toContain('Decodo CHI 1');
    expect(html.match(/<option/g)?.length).toBe(4);
    expect(html).toMatch(/<option[^>]*value="1"[^>]*disabled=""|<option[^>]*disabled=""[^>]*value="1"/);    // Decodo NY 1 carries two
    expect(html).toContain('fpAddToFleetFull');
    expect(html).not.toContain('fpAddToFleetDevice');     // no proxy picked, so no timezone to show yet
  });
  it('says every proxy is full when none has room', () => {
    const html = renderToString(<AddToFleetDialog no={40} proxies={PROXIES} limit={0} onClose={noop} onDone={noop} />);
    expect(html).toContain('fpAddToFleetAllFull');
    expect(html).not.toContain('<select');
  });
  it('says to add a proxy first when there is none', () => {
    const html = renderToString(<AddToFleetDialog no={40} proxies={[]} limit={2} onClose={noop} onDone={noop} />);
    expect(html).toContain('fpAddToFleetNoProxy');
  });
  it('asks before taking an account out', () => {
    const html = renderToString(<RemoveFromFleetDialog slot={SLOTS.find(s => s.account_no === 40)!} onClose={noop} onDone={noop} />);
    expect(html).toContain('fpRemoveFromFleetTitle');
    expect(html).toContain('fpRemoveFromFleetBody');
  });
});
