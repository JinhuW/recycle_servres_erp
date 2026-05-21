import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { resetDb, TEST_DATABASE_URL } from './helpers/db';

describe('migration 0042_metrics_role', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('creates a `metrics` role granted pg_monitor', async () => {
    const sql = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
    try {
      const rows = await sql`
        SELECT rolname FROM pg_roles
        WHERE rolname = 'metrics'
      `;
      expect(rows.length).toBe(1);

      const grants = await sql`
        SELECT pg_has_role('metrics', 'pg_monitor', 'MEMBER') AS has
      `;
      expect(grants[0]!.has).toBe(true);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('metrics role can read pg_stat_database but not user tables', async () => {
    // Connect as the metrics role itself.
    const url = new URL(TEST_DATABASE_URL);
    url.username = 'metrics';
    url.password = 'metrics';
    const sql = postgres(url.toString(), { max: 1, prepare: false });
    try {
      // pg_monitor grants this.
      const stats = await sql`SELECT count(*)::int AS n FROM pg_stat_database`;
      expect(stats[0]!.n).toBeGreaterThan(0);

      // No grant on user tables — should fail with permission denied.
      let denied = false;
      try {
        await sql`SELECT count(*) FROM users`;
      } catch (e) {
        denied = String(e).includes('permission denied');
      }
      expect(denied).toBe(true);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
