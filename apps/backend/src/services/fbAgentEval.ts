import type { EvalExpectation } from '@recycle-erp/shared';
import type { SqlLike } from '../db';

// Replay cases and eval runs for agent profiles (CONTRACTS §6.4, §6.7).

/** Freezes the thread's current AgentInput, Market snapshot included, as a case. */
export async function saveCaseFromThread(_tx: SqlLike, _threadId: number, _name: string, _expected: EvalExpectation): Promise<{ caseId: number }> {
  throw new Error('saveCaseFromThread is not implemented');
}
