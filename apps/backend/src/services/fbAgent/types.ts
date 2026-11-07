import type { AgentDecision, AgentExtract, AgentInput, FbAgentProfile, FbThreadStage, ParamSchema } from '@recycle-erp/shared';
import type { OfferResult } from '../../lib/fbOffer';

// The module shapes of CONTRACTS §6.4. A rule or skill is one file under
// rules/ or skills/ that default-exports one of these, plus one line in
// registry.ts.

export type AgentLlm = (req: { model: string; system: string; messages: { role: 'user' | 'assistant'; content: string }[];
  schema: Record<string, unknown> }) => Promise<{ json: Record<string, unknown>; usage: AgentDecision['usage'][number] }>;

export type InboundMessage = AgentInput['messages'][number];

export type RuleContext = {
  input: AgentInput;
  extract: AgentExtract;
  /** What fbOffer would offer next; rules read it, the model never does. */
  offer: OfferResult;
  /** The newest message from the seller, if the window has one. */
  latest: InboundMessage | null;
  params: Record<string, unknown>;
};

export type SkillContext = RuleContext & { profile: FbAgentProfile };

export type AgentRule = {
  kind: string;
  label: string;
  params: ParamSchema;
  check(ctx: RuleContext): { fire: false } | { fire: true; reason: string };
};

export type AgentSkill = {
  kind: string;
  label: string;
  params: ParamSchema;
  when(ctx: SkillContext): boolean;
  reply(ctx: SkillContext, llm: AgentLlm): Promise<{ text: string; stage: FbThreadStage; wants_offer: boolean }>;
};

export const NO_PARAMS: ParamSchema = { type: 'object', properties: {} };

export function numParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function stringsParam(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
