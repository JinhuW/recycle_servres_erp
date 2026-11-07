import type { FleetSellerTaskKind, SellerTaskPayload } from '@recycle-erp/shared';
import type { SqlLike } from '../db';

// The only way a seller task enters fleet_tasks (CONTRACTS §5.3).

export async function enqueueSellerTask(_tx: SqlLike, _accountNo: number, _kind: FleetSellerTaskKind, _ref: string,
  _payload: SellerTaskPayload, _dueAt: Date): Promise<{ taskId: number } | null> {
  throw new Error('enqueueSellerTask is not implemented');
}
