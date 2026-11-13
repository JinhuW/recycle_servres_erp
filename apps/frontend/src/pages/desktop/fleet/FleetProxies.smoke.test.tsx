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
const { AddToFleetDialog, addSlotEngine, ChangeProxyDialog, ProxyDialog, RemoveFromFleetDialog } = await import('./FleetProxies');
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
    expect(html.match(/<option/g)?.length).toBe(6);       // 4 proxy choices, 2 engines
    expect(html).toMatch(/<option[^>]*value="1"[^>]*disabled=""|<option[^>]*disabled=""[^>]*value="1"/);    // Decodo NY 1 carries two
    expect(html).toContain('fpAddToFleetFull');
    expect(html).not.toContain('fpAddToFleetDevice');     // no proxy picked, so no timezone to show yet
  });
  it('counts a port against its exit IP, so an empty port on a full IP is disabled', () => {
    const shared = PROXIES.map((p) => (p.id === 3 ? { ...p, exit_ip: '192.0.2.10', exit_load: 2 } : p));
    const html = renderToString(<AddToFleetDialog no={40} proxies={shared} limit={2} onClose={noop} onDone={noop} />);
    expect(html).toMatch(/<option[^>]*value="3"[^>]*disabled=""|<option[^>]*disabled=""[^>]*value="3"/);
  });
  it('offers the browser and no pilot, CloakBrowser selected', () => {
    expect(renderToString(<AddToFleetDialog no={40} proxies={PROXIES} limit={2} onClose={noop} onDone={noop} />)).not.toContain('Pilot');
    const html = renderToString(<AddToFleetDialog no={40} proxies={PROXIES} limit={2} onClose={noop} onDone={noop} />);
    expect(html).toContain('fpAddToFleetEngine');
    expect(html).toMatch(/<option value="cloak"[^>]*selected=""[^>]*>fpAddToFleetArmCloak/);
    expect(html).toContain('fpAddToFleetArmStock');
  });
  it('sends an engine only for CloakBrowser', () => {
    expect(addSlotEngine('stock')).toEqual({});
    expect(addSlotEngine('cloak')).toEqual({ engine: 'cloak' });
  });
  it('lists a down proxy disabled, and says so when every proxy with room is down', () => {
    const one = renderToString(<AddToFleetDialog no={40} proxies={PROXIES} limit={2} health={new Map([[3, 'down']])} onClose={noop} onDone={noop} />);
    expect(one).toMatch(/<option[^>]*value="3"[^>]*disabled=""|<option[^>]*disabled=""[^>]*value="3"/);
    expect(one).toContain('fpAddToFleetDown');
    expect(one).not.toContain('fpAddToFleetAllDown');
    const all = renderToString(<AddToFleetDialog no={40} proxies={PROXIES} limit={2} health={new Map([[2, 'down'], [3, 'down']])} onClose={noop} onDone={noop} />);
    expect(all).toContain('fpAddToFleetAllDown');
    expect(all).toMatch(/<button type="submit"[^>]*disabled=""/);
  });
  it('lists an exhausted proxy disabled and labelled', () => {
    const spent = PROXIES.map((p) => (p.id === 3 ? { ...p, exhausted: true } : p));
    const html = renderToString(<AddToFleetDialog no={40} proxies={spent} limit={2} onClose={noop} onDone={noop} />);
    expect(html).toMatch(/<option[^>]*value="3"[^>]*disabled=""|<option[^>]*disabled=""[^>]*value="3"/);
    expect(html).toContain('fpAddToFleetExhausted');
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

describe('Change proxy', () => {
  // renderToString does not run effects, so the list never loads here; what the
  // confirm screen decides is proxyChangeVerdict (proxyRules.test.ts), and the
  // dialog must show nothing and write nothing before it has a list.
  it('renders nothing until the proxy list is read', () => {
    const html = renderToString(<ChangeProxyDialog slot={SLOTS[0]} current={null} holder={null} onClose={noop} onDone={noop} />);
    expect(html).toBe('');
  });
});
