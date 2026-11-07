import type { AgentExtract, FbThreadSnapshot, FbThreadStage } from '@recycle-erp/shared';
import type { SqlLike } from '../db';

// The thread operations the agent and the routes share (CONTRACTS §5.2). Every
// function takes a transaction.

const notImplemented = (fn: string): never => { throw new Error(`fbThreads.${fn} is not implemented`); };

export async function loadThreadSnapshot(_tx: SqlLike, _threadId: number): Promise<FbThreadSnapshot> {
  return notImplemented('loadThreadSnapshot');
}

export async function queueOutbound(_tx: SqlLike, _threadId: number, _body: string,
  _by: { author: 'agent'; agentRunId: number } | { author: 'staff'; userId: string }): Promise<{ messageId: number }> {
  return notImplemented('queueOutbound');
}

export async function flagHuman(_tx: SqlLike, _threadId: number, _reason: string, _detail?: Record<string, unknown>): Promise<void> {
  return notImplemented('flagHuman');
}

export async function setStage(_tx: SqlLike, _threadId: number, _stage: FbThreadStage): Promise<void> {
  return notImplemented('setStage');
}

export async function recordOffer(_tx: SqlLike, _threadId: number, _o: { offerUsd: number; ceilingUsd: number; round: number }): Promise<void> {
  return notImplemented('recordOffer');
}

export async function recordExtract(_tx: SqlLike, _threadId: number, _extracted: AgentExtract): Promise<void> {
  return notImplemented('recordExtract');
}
