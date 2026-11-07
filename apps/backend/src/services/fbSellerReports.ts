import type { SellerReport } from '@recycle-erp/shared';
import type { SqlLike } from '../db';

// What a seller worker's report does to the domain (placements, threads,
// messages). The report route stores the report and calls this in the same
// transaction (CONTRACTS §4.4).

export async function applySellerReport(_tx: SqlLike, _accountNo: number, _report: SellerReport): Promise<{ accepted: boolean; detail?: string }> {
  return { accepted: true };
}
