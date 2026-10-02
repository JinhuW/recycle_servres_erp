import { describe, it, expect } from 'vitest';
import { clientIp, limiterKey } from '../src/lib/clientIp';

const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

describe('clientIp', () => {
  it('prefers the Worker header over the forwarded-for Railway rewrites', () => {
    const ip = clientIp(headers({ 'x-client-ip': '203.0.113.7', 'x-forwarded-for': '172.68.1.1' }));
    expect(ip).toEqual({ full: '203.0.113.7', key: '203.0.113.7' });
  });

  it('falls back to the first forwarded-for entry, then nothing', () => {
    expect(clientIp(headers({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' })).full).toBe('198.51.100.2');
    expect(clientIp(headers({}))).toEqual({ full: null, key: 'unknown' });
  });

  it('keeps the full IPv6 address but limits by its /64', () => {
    const a = clientIp(headers({ 'x-client-ip': '2001:db8:aa:bb:1:2:3:4' }));
    const b = clientIp(headers({ 'x-client-ip': '2001:0db8:00aa:00bb::ffff' }));
    expect(a.full).toBe('2001:db8:aa:bb:1:2:3:4');
    expect(a.key).toBe('2001:db8:aa:bb::/64');
    expect(b.key).toBe(a.key);
  });
});

describe('limiterKey', () => {
  it.each([
    ['::1', '0:0:0:0::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::ffff:192.0.2.9', '192.0.2.9'],
    ['[2001:db8:1:2::9]', '2001:db8:1:2::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['192.0.2.1', '192.0.2.1'],
  ])('%s → %s', (ip, key) => {
    expect(limiterKey(ip)).toBe(key);
  });

  it('leaves text that is not an address alone rather than guessing', () => {
    expect(limiterKey('not:an:ip:zzzz')).toBe('not:an:ip:zzzz');
  });
});
