import { describe, it, expect } from 'vitest';
import { getDb } from '../src/db';
import { testEnv } from './helpers/app';

// H3 regression: db.ts created a brand-new pool (max:5) on every getDb()
// call / every request, justified by a Cloudflare Workers I/O constraint.
// The backend runs under @hono/node-server (Node), where module-scope
// sockets are fine, so getDb must return ONE shared pool — otherwise N
// concurrent requests open up to N*5 connections and exhaust Postgres.

describe('getDb shared pool', () => {
  it('returns the same pooled client instance across calls', () => {
    const a = getDb(testEnv);
    const b = getDb(testEnv);
    expect(a).toBe(b);
  });
});
