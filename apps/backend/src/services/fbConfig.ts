import type { FbSellerSettings } from '@recycle-erp/shared';
import type { SqlLike } from '../db';

// The seller domain's one source of configuration: the single
// fb_seller_settings row. Callers read it per tick or per run and never cache
// it past one, so a manager's save takes effect without a restart.

export async function loadFbSellerSettings(sql: SqlLike): Promise<FbSellerSettings> {
  const [row] = await sql<{ value: FbSellerSettings }[]>`SELECT value FROM fb_seller_settings WHERE id = 1`;
  if (!row) throw new Error('fb_seller_settings has no row; migration 0232 seeds it');
  return row.value;
}
