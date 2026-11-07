import type { RegistryEntry } from '@recycle-erp/shared';
import type { AgentRule, AgentSkill } from './types';
import closing from './rules/closing';
import noMarketMatch from './rules/no_market_match';
import priceStale from './rules/price_stale';
import logistics from './rules/logistics';
import hasImage from './rules/has_image';
import unknownDirection from './rules/unknown_direction';
import confidenceBelow from './rules/confidence_below';
import intent from './rules/intent';
import botQuestion from './rules/bot_question';
import screen from './skills/screen';
import negotiate from './skills/negotiate';
import answer from './skills/answer';

// One line per module. A profile names modules by kind; a kind missing here
// cannot run, and the runtime hands the thread off rather than skip it.

export const RULES: readonly AgentRule[] = [
  closing,
  noMarketMatch,
  priceStale,
  logistics,
  hasImage,
  unknownDirection,
  confidenceBelow,
  intent,
  botQuestion,
];

export const SKILLS: readonly AgentSkill[] = [
  screen,
  negotiate,
  answer,
];

const RULE_BY_KIND = new Map(RULES.map((r) => [r.kind, r]));
const SKILL_BY_KIND = new Map(SKILLS.map((s) => [s.kind, s]));

export const ruleFor = (kind: string): AgentRule | undefined => RULE_BY_KIND.get(kind);
export const skillFor = (kind: string): AgentSkill | undefined => SKILL_BY_KIND.get(kind);

/** GET /api/fb-agent/registry's data (D2 serves the route). */
export function agentRegistry(): { rules: RegistryEntry[]; skills: RegistryEntry[] } {
  const entry = (m: AgentRule | AgentSkill): RegistryEntry => ({ kind: m.kind, label: m.label, params: m.params });
  return { rules: RULES.map(entry), skills: SKILLS.map(entry) };
}
