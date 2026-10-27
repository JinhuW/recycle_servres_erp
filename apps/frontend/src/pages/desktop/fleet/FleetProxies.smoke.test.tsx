import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The Proxies card and the Add / Remove dialogs render to markup with the
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
const { AddToFleetDialog, ProxiesCard, ProxyDialog, RemoveFromFleetDialog } = await import('./FleetProxies');
const noop = () => undefined;

describe('Proxies card', () => {
  it('lists each proxy by host:port with its load and the accounts on it, never a login', () => {
    const html = renderToString(<ProxiesCard proxies={PROXIES} limit={2} onChanged={noop} />);
    expect(html).toContain('Decodo NY 1');
    expect(html).toContain('isp.example.net:10001');
    expect(html).toContain('America/Chicago');
    expect(html).toContain('fleetProxyUses');
    expect(html).toContain('#31 (fleetProxyLeasedTag)');
    expect(html).toContain('#44 (fleetProxyParkedTag)');
    expect(html).toContain('fp-warn');                 // proxy 1 is at its limit
    expect(html).not.toContain('@');
    expect(renderToString(<ProxiesCard proxies={[]} limit={2} onChanged={noop} />)).toContain('fleetProxyNone');
  });
  it('opens the edit form with the URL field empty and write-only', () => {
    const html = renderToString(<ProxyDialog proxy={PROXIES[0]} onClose={noop} onDone={noop} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('fleetProxyUrlKeep');
    expect(html).toMatch(/type="password"[^>]*value=""/);
  });
});

describe('Add to fleet', () => {
  it('offers the proxies with their load, the full one disabled, and previews the device', () => {
    const html = renderToString(<AddToFleetDialog no={40} proxies={PROXIES} limit={2} onClose={noop} onDone={noop} />);
    expect(html).toContain('fpAddToFleetTitle');
    expect(html).toContain('Decodo NY 2');
    expect(html).toContain('Decodo CHI 1');
    expect(html.match(/type="radio"/g)?.length).toBe(3);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="1"|<input[^>]*value="1"[^>]*disabled=""/);    // Decodo NY 1 carries two
    expect(html).toContain('fpAddToFleetFull');
    expect(html).toContain('fpAddToFleetDevice');
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
