import { describe, it, expect } from 'vitest';
import { isTransientConnectError } from '../scripts/pg-retry.mjs';

// The migration runner's retry decides whether a failed boot waits or dies, and
// the container's CMD chains on `&&` — so a wrong call here is either an outage
// that needed a human, or a wrong password reported six times as "not reachable
// yet". Neither shows up until a deploy.
describe('migrate connect retry', () => {
  it('waits out a server that has not finished starting', () => {
    // 57P03 is the whole reason for the retry, and it arrives as a
    // PostgresError carrying a SQLSTATE — not as a socket error. A socket-only
    // check would call the commonest cold start fatal.
    expect(isTransientConnectError({ code: '57P03' })).toBe(true);
  });

  it('waits out a database that is not listening or not routable', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET']) {
      expect(isTransientConnectError({ code })).toBe(true);
    }
  });

  it("waits out postgres.js's own connection-class failures", () => {
    for (const code of ['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_DESTROYED']) {
      expect(isTransientConnectError({ code })).toBe(true);
    }
  });

  it('waits out the whole 08 connection-exception class, and a full pool', () => {
    expect(isTransientConnectError({ code: '08006' })).toBe(true);
    expect(isTransientConnectError({ code: '08001' })).toBe(true);
    expect(isTransientConnectError({ code: '53300' })).toBe(true);
  });

  it('fails fast on anything a wait cannot fix', () => {
    // Wrong password, wrong database, no such role, missing table: retrying
    // these only delays the same failure behind a misleading message.
    for (const code of ['28P01', '28000', '3D000', '42P01', '42501']) {
      expect(isTransientConnectError({ code })).toBe(false);
    }
  });

  it('fails fast when there is no code to judge', () => {
    expect(isTransientConnectError(new Error('boom'))).toBe(false);
    expect(isTransientConnectError({ code: 42 })).toBe(false);
    expect(isTransientConnectError(undefined)).toBe(false);
  });
});
