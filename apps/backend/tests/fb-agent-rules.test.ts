// The agent's registries and fixed guards: every rule fires on its own fixture
// and stays quiet on a plain one; every text guard blocks what it names.

import { describe, it, expect, beforeAll } from 'vitest';
import type { FbAgentProfile } from '@recycle-erp/shared';
import { offerFor } from '../src/lib/fbOffer';
import { agentRegistry, RULES, ruleFor } from '../src/services/fbAgent/registry';
import { HONEST_LINE, MAX_REPLY_CHARS, checkReply } from '../src/services/fbAgent/guards';
import type { RuleContext } from '../src/services/fbAgent/types';
import { resetDb } from './helpers/db';
import { NOW, PN, activeProfile, agentInput, extractOf } from './helpers/fbAgent';

let profile: FbAgentProfile;
beforeAll(async () => {
  await resetDb();
  profile = await activeProfile();
});

const seededParams = (kind: string) => profile.rules.find((r) => r.kind === kind)!.params;

function ctx(over: { input?: RuleContext['input']; extract?: RuleContext['extract']; params?: Record<string, unknown>; kind: string }): RuleContext {
  const input = over.input ?? agentInput();
  const extract = over.extract ?? extractOf();
  const latest = [...input.messages].reverse().find((m) => m.direction !== 'out') ?? null;
  return { input, extract, offer: offerFor(input, extract), latest, params: over.params ?? seededParams(over.kind) };
}

const check = (kind: string, c: RuleContext) => ruleFor(kind)!.check(c);

describe('registry', () => {
  it('lists the ten rules and three skills with their params, and the seeded profile names only those', () => {
    const reg = agentRegistry();
    expect(reg.rules.map((r) => r.kind)).toEqual([
      'closing', 'no_market_match', 'price_stale', 'logistics', 'has_image',
      'unknown_direction', 'confidence_below', 'intent', 'bot_question', 'keyword',
    ]);
    expect(reg.skills.map((s) => s.kind)).toEqual(['screen', 'negotiate', 'answer']);
    for (const e of [...reg.rules, ...reg.skills]) {
      expect(e.label).toBeTruthy();
      expect(e.params.type).toBe('object');
    }
    expect(profile.rules.map((r) => r.kind).sort()).toEqual(reg.rules.map((r) => r.kind).sort());
    expect(profile.skills.map((s) => s.kind)).toEqual(reg.skills.map((s) => s.kind));
    // Every seeded parameter is one the module declares.
    for (const r of profile.rules) {
      const declared = Object.keys(ruleFor(r.kind)!.params.properties);
      for (const k of Object.keys(r.params)) expect(declared).toContain(k);
    }
  });
});

describe('rules', () => {
  const plain = (kind: string) => expect(check(kind, ctx({ kind })).fire).toBe(false);

  it('every rule is quiet on a plain first offer', () => {
    for (const r of RULES) plain(r.kind);
  });

  it('closing: agreeing, a small gap, or the last round', () => {
    expect(check('closing', ctx({ kind: 'closing', extract: extractOf({ agreeing: true }) })).fire).toBe(true);
    expect(check('closing', ctx({ kind: 'closing', extract: extractOf({ intent: 'agree' }) })).fire).toBe(true);
    // Next offer 208; an ask of 225 is 7.6% above it.
    expect(check('closing', ctx({ kind: 'closing', extract: extractOf({ seller_ask_usd: 225 }) })).fire).toBe(true);
    expect(check('closing', ctx({ kind: 'closing', extract: extractOf({ seller_ask_usd: 400 }) })).fire).toBe(false);
    const late = agentInput({ thread: { ...agentInput().thread, round: 2, offer_usd: 237 } });
    expect(check('closing', ctx({ kind: 'closing', input: late }))).toMatchObject({ fire: true, reason: expect.stringMatching(/last round/) });
  });

  it('no_market_match: an item missing from Market', () => {
    const ex = extractOf({ items: [{ part_number: 'HMA84GR7AFR4N-VK', description: '', qty: 2 }] });
    expect(check('no_market_match', ctx({ kind: 'no_market_match', extract: ex })).fire).toBe(true);
  });

  it('price_stale: a price older than price_max_age_days, or none', () => {
    const old = agentInput({ market: [{ ...agentInput().market[0]!, price_at: '2026-09-01T00:00:00Z' }] });
    expect(check('price_stale', ctx({ kind: 'price_stale', input: old })).fire).toBe(true);
    const none = agentInput({ market: [{ ...agentInput().market[0]!, price_at: null }] });
    expect(check('price_stale', ctx({ kind: 'price_stale', input: none })).fire).toBe(true);
  });

  it('logistics: by intent or by the seeded words', () => {
    expect(check('logistics', ctx({ kind: 'logistics', extract: extractOf({ intent: 'logistics' }) })).fire).toBe(true);
    const i = agentInput();
    const msg = (body: string) => ({ ...i, messages: [...i.messages, { seq: 9, direction: 'in' as const, author: 'seller', body, has_image: false }] });
    expect(check('logistics', ctx({ kind: 'logistics', input: msg('can you pick up today?') })).fire).toBe(true);
    expect(check('logistics', ctx({ kind: 'logistics', input: msg('do you take Zelle') })).fire).toBe(true);
    expect(check('logistics', ctx({ kind: 'logistics', input: msg('they are all tested') })).fire).toBe(false);
  });

  it('has_image: the latest seller message has a photo', () => {
    const i = agentInput();
    const withPhoto = { ...i, messages: [...i.messages, { seq: 9, direction: 'in' as const, author: 'seller', body: '', has_image: true }] };
    expect(check('has_image', ctx({ kind: 'has_image', input: withPhoto })).fire).toBe(true);
  });

  it('unknown_direction: any message of unknown author', () => {
    const i = agentInput();
    const odd = { ...i, messages: [{ ...i.messages[0]!, direction: 'unknown' as const }, ...i.messages.slice(1)] };
    expect(check('unknown_direction', ctx({ kind: 'unknown_direction', input: odd })).fire).toBe(true);
  });

  it('confidence_below: under min', () => {
    expect(check('confidence_below', ctx({ kind: 'confidence_below', extract: extractOf({ confidence: 0.4 }) })).fire).toBe(true);
    expect(check('confidence_below', ctx({ kind: 'confidence_below', extract: extractOf({ confidence: 0.6 }) })).fire).toBe(false);
  });

  it('intent: hostile and off-topic by default', () => {
    expect(check('intent', ctx({ kind: 'intent', extract: extractOf({ intent: 'hostile' }) })).fire).toBe(true);
    expect(check('intent', ctx({ kind: 'intent', extract: extractOf({ intent: 'off_topic' }) })).fire).toBe(true);
    expect(check('intent', ctx({ kind: 'intent', extract: extractOf({ intent: 'question' }) })).fire).toBe(false);
  });

  it('bot_question: the bot question', () => {
    expect(check('bot_question', ctx({ kind: 'bot_question', extract: extractOf({ intent: 'bot_question' }) })).fire).toBe(true);
  });

  it('keyword: a pattern on the latest seller message; a broken pattern hands off', () => {
    expect(check('keyword', ctx({ kind: 'keyword', params: { patterns: ['r7\\d0'] } })).fire).toBe(true);
    expect(check('keyword', ctx({ kind: 'keyword', params: { patterns: ['lawyer'] } })).fire).toBe(false);
    expect(check('keyword', ctx({ kind: 'keyword', params: { patterns: ['(unclosed'] } })).fire).toBe(true);
  });
});

describe('guards', () => {
  const blocked = (text: string, offer: number | null = 208) => {
    const g = checkReply(text, offer);
    expect(g.ok, `${text} → ${g.failures.join(' | ')}`).toBe(false);
    expect(g.text).toBeNull();
  };
  const passes = (text: string, offer: number | null = 208) => {
    const g = checkReply(text, offer);
    expect(g.ok, `${text} → ${g.failures.join(' | ')}`).toBe(true);
    return g.text;
  };

  it('fills only {{offer}} with code\'s number', () => {
    expect(passes('We can offer {{offer}} for the lot, based on current resale prices.')).toBe('We can offer $208 for the lot, based on current resale prices.');
    blocked('We can offer {{offer}} for the lot.', null);
    blocked('We can offer {{price}} for the lot.');
  });

  it('guard 3: any money figure the model wrote itself', () => {
    for (const t of [
      'We could do $9,999.', 'How about 250 dollars', 'Best I can do is 2.5k', 'we can go to 1k',
      'two hundred and fifty for all', 'We can do 25 each', 'Maybe 9999 for the lot?', 'We were thinking 297.04',
      'Around 300 bucks?', 'what about 1,200',
    ]) blocked(t);
    // Part numbers, models and small counts are not money.
    passes(`Do you have the exact part number, like ${PN}, and are all 8 the same? Is it from an R740?`);
  });

  it('guard 4: never accepts, pays or arranges a handover', () => {
    for (const t of [
      'Deal!', "It's a deal at {{offer}}", 'Sounds good, I accept.', "I'll pay {{offer}} today.", 'We will take them.',
      'Can you do pickup tomorrow?', 'We can ship a label to you', 'Send me your address', 'We can pay by PayPal',
      'Agreed, sold at {{offer}}', 'We can meet at 5',
    ]) blocked(t);
  });

  it('guard 5: the honest line passes; claiming to be a person does not', () => {
    expect(passes(HONEST_LINE, null)).toBe(HONEST_LINE);
    blocked("No, I'm a real person on the team.");
    blocked('I am not a bot, promise.');
  });

  it('guard 6: one paragraph, at most 600 characters', () => {
    expect(passes('Thanks!\n\nWhat part numbers do you have?', null)).toBe('Thanks! What part numbers do you have?');
    blocked('Tell us more. '.repeat(Math.ceil(MAX_REPLY_CHARS / 14) + 1), null);
    blocked('   ', null);
  });

  it('the seeded prompts say what the guards enforce', () => {
    expect(profile.prompts.system).toMatch(/\{\{offer\}\}/);
    expect(profile.prompts.skills.answer).toContain(HONEST_LINE);
    expect(NOW).toBeTruthy();
  });
});
