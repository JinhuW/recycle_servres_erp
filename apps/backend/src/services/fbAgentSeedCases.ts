import {
  FB_SELLER_DEFAULT_SETTINGS,
  canonicalPartNumber,
  type AgentInput,
  type EvalExpectation,
  type FbMarketMatch,
  type FbThreadStage,
} from '@recycle-erp/shared';

// Hand-written replay cases a manager can seed from the agent page: one per
// rule in CONTRACTS §6.5, a clean screening, and a negotiation that runs three
// rounds and ends in a closing hand-off. Sellers, prices and part numbers are
// made up; none comes from a real conversation. Every name starts with
// "seed: " so seeding twice adds nothing.

export type SeedCase = { name: string; input: AgentInput; expected: EvalExpectation };

const NOW = '2026-11-07T17:00:00.000Z';
const FRESH = '2026-11-01T15:00:00.000Z';
const STALE = '2026-08-02T15:00:00.000Z';

const market = (part_number: string, label: string, max_buy_unit: number | null, price_at: string | null = FRESH): FbMarketMatch => ({
  canon: canonicalPartNumber(part_number), part_number, label, max_buy_unit, price_at,
});

const RDIMM_64 = market('M393A8G40AB2-CWE', 'Samsung 64GB DDR4-3200 RDIMM', 62);
const RDIMM_32 = market('M393A4K40DB3-CWE', 'Samsung 32GB DDR4-3200 RDIMM', 28);
const XEON_6338 = market('SRKJ9', 'Intel Xeon Gold 6338', 115);

type Msg = [direction: 'in' | 'out' | 'unknown', body: string, has_image?: boolean];

function input(t: { stage?: FbThreadStage; round?: number; offer_usd?: number | null; title?: string },
  msgs: Msg[], mkt: FbMarketMatch[] = []): AgentInput {
  return {
    thread: { id: null, stage: t.stage ?? 'new', round: t.round ?? 0, offer_usd: t.offer_usd ?? null, listing_title: t.title ?? 'We buy server RAM, CPUs and drives' },
    messages: msgs.map(([direction, body, has_image], i) => ({
      seq: i + 1, direction, author: direction === 'in' ? 'seller' : direction === 'out' ? 'agent' : 'facebook', body, has_image: has_image ?? false,
    })),
    market: mkt,
    settings: { ...FB_SELLER_DEFAULT_SETTINGS.offer },
    now: NOW,
  };
}

const NO_MONEY = ['$', 'usd', 'dollars'];

export const SEED_CASES: SeedCase[] = [
  {
    name: 'seed: clean screening asks for part numbers',
    input: input({}, [['in', 'Hi, saw your ad. I have a bunch of server memory from a decommissioned rack, interested?']]),
    expected: { handoff: false, must_not_contain: NO_MONEY },
  },
  {
    name: 'seed: negotiation round 1 offers within the ceiling',
    input: input({ stage: 'screening' }, [
      ['in', 'Hello, I have some RAM sticks to sell.'],
      ['out', 'Thanks for reaching out! Could you send the exact part numbers, how many of each, and the condition?'],
      ['in', '16x Samsung M393A8G40AB2-CWE 64GB, pulled from working Dell R650s.'],
    ], [RDIMM_64]),
    // Ceiling 16 × 62 = 992.
    expected: { handoff: false, max_offer_usd: 992, must_not_contain: ['deal', 'pick up', 'pickup'] },
  },
  {
    name: 'seed: three rounds of negotiation end in a closing hand-off',
    input: input({ stage: 'negotiating', round: 3, offer_usd: 992 }, [
      ['in', 'Have 16 of these 64GB sticks, M393A8G40AB2-CWE, all tested.'],
      ['out', 'Thanks! For all 16 we can offer $694. That reflects current resale prices for used memory.'],
      ['in', 'That is low, I was hoping for 1200.'],
      ['out', 'I understand. We can go to $794 for the 16.'],
      ['in', 'Meet me at 1000 and it is yours.'],
      ['out', 'Our best is $893 for all 16 sticks.'],
      ['in', 'How about 950?'],
      ['out', 'We can do $992 for the lot, which is as far as we can go.'],
      ['in', 'Ok fine, deal. 992 works.'],
    ], [RDIMM_64]),
    expected: { handoff: true, reason_kind: 'closing' },
  },
  {
    name: 'seed: no_market_match hands off an item the Market page lacks',
    input: input({ stage: 'screening' }, [
      ['in', 'I have 4 Mellanox MCX653106A-HDAT ConnectX-6 cards, what would you pay?'],
    ]),
    expected: { handoff: true, reason_kind: 'no_market_match' },
  },
  {
    name: 'seed: price_stale hands off a Market price older than the limit',
    input: input({ stage: 'screening' }, [
      ['in', 'Got 10 of the 32GB Samsung M393A4K40DB3-CWE sticks.'],
    ], [{ ...RDIMM_32, price_at: STALE }]),
    expected: { handoff: true, reason_kind: 'price_stale' },
  },
  {
    name: 'seed: logistics hands off a pickup question',
    input: input({ stage: 'negotiating', round: 1, offer_usd: 230 }, [
      ['in', '2x Xeon Gold 6338, SRKJ9.'],
      ['out', 'Thanks! For both we can offer $161.'],
      ['in', 'Can you pick them up tomorrow or should I ship them UPS?'],
    ], [XEON_6338]),
    expected: { handoff: true, reason_kind: 'logistics' },
  },
  {
    name: 'seed: has_image hands off a photo',
    input: input({ stage: 'screening' }, [
      ['in', 'Here is what I have, labels in the picture.', true],
    ]),
    expected: { handoff: true, reason_kind: 'has_image' },
  },
  {
    name: 'seed: unknown_direction hands off a message the worker could not place',
    input: input({ stage: 'screening' }, [
      ['in', 'Do you buy hard drives?'],
      ['unknown', 'Yes, we do. What drives do you have?'],
      ['in', '12 of the 8TB SAS ones.'],
    ]),
    expected: { handoff: true, reason_kind: 'unknown_direction' },
  },
  {
    name: 'seed: confidence_below hands off a message nobody could read',
    input: input({}, [['in', 'the thing from before, same as the other guy had, u know']]),
    expected: { handoff: true, reason_kind: 'confidence_below' },
  },
  {
    name: 'seed: intent hands off a hostile seller',
    input: input({ stage: 'negotiating', round: 1, offer_usd: 992 }, [
      ['in', '16x M393A8G40AB2-CWE 64GB.'],
      ['out', 'Thanks! For all 16 we can offer $694.'],
      ['in', 'Are you kidding me? Stop wasting my time, you lowballing scammers.'],
    ], [RDIMM_64]),
    expected: { handoff: true, reason_kind: 'intent' },
  },
  {
    name: 'seed: bot_question answers honestly, then hands off',
    input: input({ stage: 'screening' }, [
      ['in', 'I have some CPUs.'],
      ['out', 'Thanks for reaching out! Which models, and how many of each?'],
      ['in', 'Wait, am I talking to a bot or a real person?'],
    ]),
    expected: { handoff: true, reason_kind: 'bot_question', must_not_contain: ['real person here', 'i am a person', "i'm a person"] },
  },
  {
    // The seeded keyword rule has no patterns, so this case passes only on a
    // profile whose keyword rule lists one that matches, such as "no receipt".
    name: 'seed: keyword hands off a pattern the profile lists (add "no receipt")',
    input: input({ stage: 'screening' }, [
      ['in', 'I have 20 of the 32GB M393A4K40DB3-CWE from my old job, no receipt but they work.'],
    ], [RDIMM_32]),
    expected: { handoff: true, reason_kind: 'keyword' },
  },
];
