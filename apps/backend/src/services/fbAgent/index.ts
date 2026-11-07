import type { AgentDecision, AgentInput, FbAgentProfile, FbSellerSettings } from '@recycle-erp/shared';
import type { SqlLike } from '../../db';
import type { Env } from '../../types';

// The agent's entry points (CONTRACTS §6.2).

export type AgentLlm = (req: { model: string; system: string; messages: { role: 'user' | 'assistant'; content: string }[];
  schema: Record<string, unknown> }) => Promise<{ json: Record<string, unknown>; usage: AgentDecision['usage'][number] }>;

export async function enqueueAgentRun(_tx: SqlLike, _threadId: number, _triggerMessageId: number): Promise<void> {}

/** Pure: no DB writes, no sends. The model call goes through `llm`, so tests and replays can stub it. */
export async function decide(_input: AgentInput, _profile: FbAgentProfile, _llm: AgentLlm): Promise<AgentDecision> {
  throw new Error('decide is not implemented');
}

export function startFbAgentLoop(_env: Env): { stop: () => void } {
  return { stop: () => {} };
}

/** The OpenRouter-backed AgentLlm the loop and eval runs use. */
export function agentLlmFor(_env: Env): AgentLlm {
  return () => { throw new Error('agentLlmFor is not implemented'); };
}

/** Spend on every run (live, shadow, eval) since midnight in settings.active_hours.tz. */
export async function agentSpentTodayUsd(_sql: SqlLike, _settings: FbSellerSettings): Promise<number> {
  throw new Error('agentSpentTodayUsd is not implemented');
}
