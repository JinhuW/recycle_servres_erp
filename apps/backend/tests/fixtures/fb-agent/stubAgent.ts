import type { AgentDecision, AgentExtract, AgentInput, FbAgentProfile } from '@recycle-erp/shared';
import type { AgentLlm } from '../../../src/services/fbAgent';

// A stand-in for the agent runtime the profile and eval tests drive: a stubbed
// LLM with canned answers keyed by the seller's latest message, and a small
// `decide` with the contract's signature that reads the extract, applies a few
// rules in profile order and fills {{offer}} from the frozen Market rows. It is
// deterministic, so two replays of one input must agree.

export type Canned = { extract: Partial<AgentExtract>; reply?: string };

const DEFAULT_EXTRACT: AgentExtract = { items: [], seller_ask_usd: null, intent: 'question', agreeing: false, confidence: 0.9 };

export function stubLlm(canned: Record<string, Canned>, opts: { replyText?: string } = {}): AgentLlm & { calls: number } {
  const fn = (async (req) => {
    fn.calls++;
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const c = canned[last];
    const usage = { model: req.model, prompt_tokens: 100, completion_tokens: 20, cost_usd: 0.001 };
    if (req.schema.name === 'extract') return { json: { ...DEFAULT_EXTRACT, ...c?.extract }, usage };
    return { json: { text: c?.reply ?? opts.replyText ?? 'Thanks! We can offer {{offer}} for those.' }, usage };
  }) as AgentLlm & { calls: number };
  fn.calls = 0;
  return fn;
}

export async function stubDecide(input: AgentInput, profile: FbAgentProfile, llm: AgentLlm): Promise<AgentDecision> {
  const messages = input.messages.map((m) => ({ role: m.direction === 'in' ? 'user' as const : 'assistant' as const, content: m.body }));
  const ex = await llm({ model: profile.models.extract, system: profile.prompts.extract, messages, schema: { name: 'extract' } });
  const extract = ex.json as AgentExtract;
  const usage = [ex.usage];
  const lastIn = [...input.messages].reverse().find((m) => m.direction === 'in');
  const fired: { kind: string; reason: string }[] = [];
  for (const r of profile.rules) {
    if (!r.enabled) continue;
    if (r.kind === 'closing' && extract.agreeing) fired.push({ kind: r.kind, reason: 'The seller agreed.' });
    if (r.kind === 'has_image' && lastIn?.has_image) fired.push({ kind: r.kind, reason: 'The seller sent a photo.' });
    if (r.kind === 'no_market_match' && extract.items.some((i) => !input.market.some((m) => m.part_number === i.part_number))) {
      fired.push({ kind: r.kind, reason: 'An item is not on the Market page.' });
    }
    if (r.kind === 'keyword' && ((r.params.patterns as string[]) ?? []).some((p) => new RegExp(p, 'i').test(lastIn?.body ?? ''))) {
      fired.push({ kind: r.kind, reason: 'A keyword matched.' });
    }
    if (fired.length) break;
  }
  const base = { extract, skill: null, stage: null, guard: { ok: true, failures: [] }, usage };
  if (fired.length) {
    return { ...base, outcome: 'handoff', reply: null, offer: null, rules_fired: fired, handoff_reason: fired[0]!.reason };
  }
  const ceiling = extract.items.reduce((s, i) => {
    const m = input.market.find((x) => x.part_number === i.part_number);
    return s + (m?.max_buy_unit ?? 0) * (i.qty ?? 0);
  }, 0);
  const round = input.thread.round;
  const offer = Math.min(ceiling, Math.round(ceiling * (input.settings.opening_pct + input.settings.step_pct * round) / 100));
  const rep = await llm({ model: profile.models.reply, system: profile.prompts.system, messages, schema: { name: 'reply' } });
  usage.push(rep.usage);
  return {
    ...base, outcome: 'send', skill: ceiling > 0 ? 'negotiate' : 'screen',
    reply: String(rep.json.text).replace('{{offer}}', `$${offer}`),
    offer: ceiling > 0 ? { offer_usd: offer, ceiling_usd: ceiling, round } : null,
    stage: ceiling > 0 ? 'negotiating' : 'screening', rules_fired: [], handoff_reason: null,
  };
}
