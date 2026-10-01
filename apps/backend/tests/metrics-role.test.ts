import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { resetDb, TEST_DATABASE_URL } from './helpers/db';

describe('the metrics role (0042, locked by 0141)', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('keeps the role and its pg_monitor grant but cannot log in', async () => {
    const sql = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
    try {
      const rows = await sql<{ rolcanlogin: boolean }[]>`
        SELECT rolcanlogin FROM pg_roles WHERE rolname = 'metrics'
      `;
      expect(rows).toEqual([{ rolcanlogin: false }]);

      const grants = await sql`
        SELECT pg_has_role('metrics', 'pg_monitor', 'MEMBER') AS has
      `;
      expect(grants[0]!.has).toBe(true);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('refuses the password that used to be committed to the repo', async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.username = 'metrics';
    url.password = 'metrics';
    const sql = postgres(url.toString(), { max: 1, prepare: false, connect_timeout: 5 });
    try {
      await expect(sql`SELECT 1`).rejects.toThrow();
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
