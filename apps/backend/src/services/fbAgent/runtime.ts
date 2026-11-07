import { AGENT_INTENTS, type AgentDecision, type AgentExtract, type AgentInput, type AgentIntent, type FbAgentProfile } from '@recycle-erp/shared';
import { offerFor } from '../../lib/fbOffer';
import { HONEST_LINE, checkReply } from './guards';
import { commitCheckRequest, extractRequest } from './prompt';
import { ruleFor, skillFor } from './registry';
import type { AgentLlm, RuleContext, SkillContext } from './types';

// decide(): extract → rules in profile order → skill → {{offer}} from fbOffer
// → guards. Pure: no DB, no send. Every path returns a whole AgentDecision; a
// model failure becomes a hand-off with the reason in words.

/** Thrown by the loop's llm when the day's spend is used up; its message is the hand-off reason. */
export class AgentBudgetError extends Error {
  constructor() {
    super("The agent's daily budget is used up");
    this.name = 'AgentBudgetError';
  }
}

function blank(): AgentDecision {
  return {
    outcome: 'noop', extract: null, skill: null, reply: null, offer: null, stage: null,
    rules_fired: [], guard: { ok: true, failures: [] }, handoff_reason: null, usage: [],
  };
}

function reasonFor(e: unknown, doing: string): string {
  if (e instanceof AgentBudgetError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  return `The agent could not ${doing}: ${msg.slice(0, 200)}`;
}

const isIntent = (v: unknown): v is AgentIntent => typeof v === 'string' && (AGENT_INTENTS as readonly string[]).includes(v);

/** The model's extract, checked field by field; null when it is not one. */
export function parseExtract(json: Record<string, unknown>): AgentExtract | null {
  if (!Array.isArray(json.items) || !isIntent(json.intent) || typeof json.agreeing !== 'boolean') return null;
  const conf = json.confidence;
  if (typeof conf !== 'number' || !Number.isFinite(conf)) return null;
  const items: AgentExtract['items'] = [];
  for (const raw of json.items) {
    if (!raw || typeof raw !== 'object') return null;
    const it = raw as Record<string, unknown>;
    const pn = typeof it.part_number === 'string' && it.part_number.trim() ? it.part_number.trim() : null;
    const qty = typeof it.qty === 'number' && Number.isInteger(it.qty) && it.qty > 0 ? it.qty : null;
    items.push({ part_number: pn, description: typeof it.description === 'string' ? it.description : '', qty });
  }
  const ask = json.seller_ask_usd;
  return {
    items,
    seller_ask_usd: typeof ask === 'number' && Number.isFinite(ask) && ask > 0 ? ask : null,
    intent: json.intent,
    agreeing: json.agreeing,
    confidence: Math.max(0, Math.min(1, conf)),
  };
}

export async function decide(input: AgentInput, profile: FbAgentProfile, llm: AgentLlm): Promise<AgentDecision> {
  const d = blank();
  const call: AgentLlm = async (req) => {
    const r = await llm(req);
    d.usage.push(r.usage);
    return r;
  };
  const handoff = (reason: string): AgentDecision => ({ ...d, outcome: 'handoff', handoff_reason: reason });

  // Nothing new from the seller since our last word: nothing to answer.
  const last = input.messages[input.messages.length - 1];
  if (!last || last.direction === 'out') return d;

  // 1. Extract.
  let extract: AgentExtract | null;
  try {
    extract = parseExtract((await call(extractRequest(profile, input))).json);
  } catch (e) {
    return handoff(reasonFor(e, 'read the conversation'));
  }
  if (!extract) return handoff('The agent could not read the conversation: the model gave an answer of the wrong shape.');
  d.extract = extract;

  const offer = offerFor(input, extract);
  const latest = [...input.messages].reverse().find((m) => m.direction !== 'out') ?? null;
  const base: Omit<RuleContext, 'params'> = { input, extract, offer, latest };

  // 2. Rules, in profile order. Every enabled one is checked so managers see
  // all the reasons; the first decides the hand-off reason.
  for (const r of profile.rules) {
    if (!r.enabled) continue;
    const rule = ruleFor(r.kind);
    if (!rule) {
      d.rules_fired.push({ kind: r.kind, reason: `The profile names a rule "${r.kind}" this ERP does not have.` });
      continue;
    }
    const res = rule.check({ ...base, params: r.params });
    if (res.fire) d.rules_fired.push({ kind: r.kind, reason: res.reason });
  }
  if (d.rules_fired.length > 0) {
    const reason = d.rules_fired[0]!.reason;
    // Guard 5: asked whether it is a bot, it says so before a person takes over.
    if (d.rules_fired.some((f) => f.kind === 'bot_question')) {
      const g = checkReply(HONEST_LINE, null);
      return { ...handoff(reason), skill: 'answer', reply: g.text, guard: { ok: g.ok, failures: g.failures } };
    }
    return handoff(reason);
  }
  // Guard 5 holds even if a profile turned the bot_question rule off.
  if (extract.intent === 'bot_question') {
    const g = checkReply(HONEST_LINE, null);
    return { ...handoff('The seller asked whether they are talking to a person.'), skill: 'answer', reply: g.text, guard: { ok: g.ok, failures: g.failures } };
  }

  // 3. Skill: the first enabled one whose `when` is true.
  let chosen: { kind: string; ctx: SkillContext } | null = null;
  for (const s of profile.skills) {
    if (!s.enabled) continue;
    const skill = skillFor(s.kind);
    if (!skill) return handoff(`The profile names a skill "${s.kind}" this ERP does not have.`);
    const ctx: SkillContext = { ...base, params: s.params, profile };
    if (skill.when(ctx)) { chosen = { kind: s.kind, ctx }; break; }
  }
  if (!chosen) {
    const why = offer.ok ? '' : ` ${offer.reason}`;
    return handoff(`No skill fits the seller's message (${extract.intent.replace('_', ' ')}).${why}`);
  }
  d.skill = chosen.kind;

  let drafted: { text: string; stage: AgentDecision['stage']; wants_offer: boolean };
  try {
    drafted = await skillFor(chosen.kind)!.reply(chosen.ctx, call);
  } catch (e) {
    return handoff(reasonFor(e, 'write a reply'));
  }
  d.stage = drafted.stage;

  // 4. The offer goes in only through the placeholder, and only fbOffer's.
  const offerUsd = drafted.wants_offer && offer.ok ? offer.offer_usd : null;
  const g = checkReply(drafted.text, offerUsd);
  // 5. Guard 4's second check: the extract model reads the draft on its own.
  if (g.ok) {
    try {
      const { json } = await call(commitCheckRequest(profile, drafted.text));
      if (json.commits !== false) {
        g.ok = false;
        g.text = null;
        g.failures.push(`The check model says the reply commits us: ${typeof json.reason === 'string' ? json.reason.slice(0, 200) : 'no reason given'}.`);
      }
    } catch (e) {
      if (e instanceof AgentBudgetError) return handoff(e.message);
      g.ok = false;
      g.text = null;
      g.failures.push(reasonFor(e, 'check the reply'));
    }
  }
  d.guard = { ok: g.ok, failures: g.failures };
  if (!g.ok) return { ...d, outcome: 'blocked', handoff_reason: `The agent's reply was blocked: ${g.failures[0]}` };

  d.reply = g.text;
  if (offerUsd !== null && offer.ok && drafted.text.includes('{{offer}}')) {
    d.offer = { offer_usd: offer.offer_usd, ceiling_usd: offer.ceiling_usd, round: offer.round };
  }
  return { ...d, outcome: 'send' };
}
