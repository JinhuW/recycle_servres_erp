import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

describe('MCP sell-order migration seed', () => {
  beforeAll(async () => { await resetDb(); });

  it('seeds the MCP customer and the default-customer setting', async () => {
    const sql = getTestDb();
    const cust = (await sql<{ name: string }[]>`
      SELECT name FROM customers WHERE id = 'f30f98bc-09c7-4108-b083-c7d69cc9968c'
    `)[0];
    expect(cust?.name).toBe('MCP');
    const setting = (await sql<{ value: string }[]>`
      SELECT value FROM workspace_settings WHERE key = 'mcp.sellOrderCustomerId'
    `)[0];
    expect(setting?.value).toBe('f30f98bc-09c7-4108-b083-c7d69cc9968c');
  });
});
