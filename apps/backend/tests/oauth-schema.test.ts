import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

describe('0046_oauth migration', () => {
  beforeAll(async () => { await resetDb(); });

  async function tableColumns(table: string): Promise<Set<string>> {
    const db = getTestDb();
    const rows = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = ${table}
    `;
    return new Set(rows.map(r => r.column_name));
  }

  it('creates oauth_clients with expected columns', async () => {
    const cols = await tableColumns('oauth_clients');
    for (const c of ['id','secret_hash','name','redirect_uris','grant_types','scopes','created_by','created_at','revoked_at']) {
      expect(cols.has(c), `oauth_clients missing column ${c}`).toBe(true);
    }
  });

  it('creates oauth_authorization_codes with expected columns + indexes', async () => {
    const cols = await tableColumns('oauth_authorization_codes');
    for (const c of ['code_hash','client_id','user_id','redirect_uri','scopes','code_challenge','expires_at','consumed_at']) {
      expect(cols.has(c), `oauth_authorization_codes missing column ${c}`).toBe(true);
    }
    const db = getTestDb();
    const idx = await db<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='oauth_authorization_codes'
    `;
    const inames = new Set(idx.map(i => i.indexname));
    expect(inames.has('oauth_authorization_codes_client_idx')).toBe(true);
    expect(inames.has('oauth_authorization_codes_user_idx')).toBe(true);
  });

  it('creates oauth_refresh_tokens with expected columns + indexes', async () => {
    const cols = await tableColumns('oauth_refresh_tokens');
    for (const c of ['id','token_hash','client_id','user_id','scopes','family_id','parent_id','expires_at','revoked_at']) {
      expect(cols.has(c), `oauth_refresh_tokens missing column ${c}`).toBe(true);
    }
    const db = getTestDb();
    const idx = await db<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='oauth_refresh_tokens'
    `;
    const inames = new Set(idx.map(i => i.indexname));
    expect(inames.has('oauth_refresh_tokens_family_idx')).toBe(true);
    expect(inames.has('oauth_refresh_tokens_user_idx')).toBe(true);
    expect(inames.has('oauth_refresh_tokens_client_idx')).toBe(true);
  });
});
