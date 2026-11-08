// The agent's keyless model (stubLlm.ts) for dev and local walks: it must
// carry a conversation from screening to a closing hand-off, and pass the
// seeded eval cases through the real decide(), or a local eval run says
// nothing about a profile.

import { describe, it, expect, beforeAll } from 'vitest';
import type { AgentInput, FbAgentProfile } from '@recycle-erp/shared';
import { FB_SELLER_DEFAULT_SETTINGS } from '@recycle-erp/shared';
import { agentLlmFor, decide } from '../src/services/fbAgent';
import { stubAgentLlm } from '../src/services/fbAgent/stubLlm';
import { grade } from '../src/services/fbAgentEval';
import { SEED_CASES } from '../src/services/fbAgentSeedCases';
import { resetDb } from './helpers/db';
import { testEnv } from './helpers/app';
import { activeProfile } from './helpers/fbAgent';

let profile: FbAgentProfile;
beforeAll(async () => {
  await resetDb();
  profile = await activeProfile();
});

const PN = 'M393A3893D4-64';
const market: AgentInput['market'] = [
  { canon: 'M393A3893D464', part_number: PN, label: 'Samsung 64GB DDR4', max_buy_unit: 101.61, price_at: new Date().toISOString() },
];

function conversation(turns: [AgentInput['messages'][number]['direction'], string][], thread: Partial<AgentInput['thread']> = {}): AgentInput {
  return {
    thread: { id: 1, stage: 'screening', round: 0, offer_usd: null, listing_title: 'We buy server RAM', ...thread },
    messages: turns.map(([direction, body], i) => ({ seq: i + 1, direction, author: direction === 'in' ? 'seller' : 'agent', body, has_image: false })),
    market,
    settings: FB_SELLER_DEFAULT_SETTINGS.offer,
    now: new Date().toISOString(),
  };
}

describe('agentLlmFor without a key', () => {
  it('answers with the stub outside production', () => {
    expect(agentLlmFor({ ...testEnv, OPENROUTER_API_KEY: undefined, NODE_ENV: 'development' })).toBe(stubAgentLlm);
  });
  it('never in production', () => {
    expect(agentLlmFor({ ...testEnv, OPENROUTER_API_KEY: undefined, NODE_ENV: 'production' })).not.toBe(stubAgentLlm);
  });
});

describe('a walk with the stub', () => {
  it('screens a vague first message', async () => {
    const d = await decide(conversation([['in', 'Hi, I saw your ad. I have some server RAM to sell.']], { stage: 'new' }), profile, stubAgentLlm);
    expect(d).toMatchObject({ outcome: 'send', skill: 'screen' });
    expect(d.reply).not.toMatch(/\$/);
  });

  it('offers once it has a part number and a quantity', async () => {
    const d = await decide(conversation([
      ['in', 'Hi, I have some server RAM to sell.'],
      ['out', 'Thanks for reaching out! What are the exact part numbers, and how many of each do you have?'],
      ['in', `They are Samsung ${PN}, 20 sticks.`],
    ]), profile, stubAgentLlm);
    expect(d).toMatchObject({ outcome: 'send', skill: 'negotiate', offer: { round: 1, offer_usd: 1423 } });
    expect(d.reply).toContain('$1423');
  });

  it('hands off a counter close to the next offer', async () => {
    const d = await decide(conversation([
      ['in', `${PN}, 20 sticks.`],
      ['out', 'Thanks for the details. For those we can offer $1423.'],
      ['in', 'Could you do $1,500 for all 20?'],
    ], { stage: 'negotiating', round: 1, offer_usd: 1423 }), profile, stubAgentLlm);
    expect(d.outcome).toBe('handoff');
    expect(d.rules_fired[0]?.kind).toBe('closing');
  });
});

describe('the seeded eval cases', () => {
  // The keyword case needs a profile whose keyword rule lists a pattern; the seeded one lists none.
  const cases = SEED_CASES.filter((c) => c.expected.reason_kind !== 'keyword');
  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const d = await decide(c.input, profile, stubAgentLlm);
    expect(grade(d, c.expected)).toEqual([]);
  });
});
