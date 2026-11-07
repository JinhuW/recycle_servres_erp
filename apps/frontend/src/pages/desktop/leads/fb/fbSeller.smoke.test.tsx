import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FB_SELLER_DEFAULT_SETTINGS, type FbMessage } from '@recycle-erp/shared';

// The thread's messages, the shadow comparison and the params form render to
// markup with the fetchers swapped out. With no language provider `t`
// answers its key, so the markup carries the key of each label.
vi.mock('../../../../lib/fbSeller', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/fbSeller')>('../../../../lib/fbSeller');
  const never = () => new Promise(() => undefined);
  return {
    ...actual,
    fbSellerApi: Object.fromEntries(Object.keys(actual.fbSellerApi).map(k => [k, vi.fn(never)])),
    fbAgentApi: Object.fromEntries(Object.keys(actual.fbAgentApi).map(k => [k, vi.fn(never)])),
  };
});
vi.mock('../../../../lib/errorToast', () => ({ handleFetchError: vi.fn(), showSuccessToast: vi.fn(), showWarnToast: vi.fn() }));

const { Conversation } = await import('./ThreadView');
const { ParamsForm, shadowDiffers } = await import('./AgentTab');
const { adProblems } = await import('./AdsTab');

const msg = (id: number, patch: Partial<FbMessage>): FbMessage => ({
  id, thread_id: 1, seq: id, direction: 'out', author: 'agent', body: `body ${id}`, has_image: false, send_state: 'sent',
  task_id: null, agent_run_id: null, staff_user_id: null, staff_name: null, error: null,
  created_at: '2026-11-07T10:00:00Z', sent_at: null, ...patch,
});

describe('Conversation', () => {
  it('shows each outbound send state and who wrote it', () => {
    const html = renderToString(<Conversation messages={[
      msg(1, { direction: 'in', author: 'seller', send_state: null }),
      msg(2, { send_state: 'queued' }),
      msg(3, { send_state: 'held' }),
      msg(4, { send_state: 'sending' }),
      msg(5, { send_state: 'sent' }),
      msg(6, { send_state: 'uncertain' }),
      msg(7, { send_state: 'failed', error: 'The message box was not found.' }),
      msg(8, { author: 'staff', staff_name: 'Alex Manager', send_state: 'queued' }),
      msg(9, { author: 'facebook', send_state: 'sent' }),
      msg(10, { direction: 'unknown', author: 'facebook', send_state: null, has_image: true }),
    ]} />);
    for (const s of ['queued', 'held', 'sending', 'sent', 'uncertain', 'failed']) {
      expect(html).toContain(`data-send="${s}"`);
      expect(html).toContain(`fbs_send_${s}`);
    }
    // An inbound message has no send state.
    expect(html.match(/data-send=/g)?.length).toBe(8);
    expect(html).toContain('fbs-msg-in');
    expect(html).toContain('fbs_author_seller');
    expect(html).toContain('fbs_author_agent');
    expect(html).toContain('Alex Manager');
    expect(html).toContain('fbs_author_facebook');
    expect(html).toContain('fbs_unknown_dir');
    expect(html).toContain('fbs_has_image');
    expect(html).toContain('The message box was not found.');
    expect(html).toMatch(/chip neg fbs-send[^>]*data-send="failed"/);
    expect(html).toMatch(/chip warn fbs-send[^>]*data-send="held"/);
  });

  it('says so when there are no messages', () => {
    expect(renderToString(<Conversation messages={[]} />)).toContain('fbs_no_messages');
  });
});

describe('ParamsForm', () => {
  it('renders a field per param from the registry schema', () => {
    const html = renderToString(<ParamsForm
      schema={{ type: 'object', properties: {
        gap_pct: { type: 'integer', label: 'Gap (%)', minimum: 0, maximum: 100 },
        kinds: { type: 'array', label: 'Intents', items: { type: 'string', enum: ['hostile', 'off_topic'] } },
        words: { type: 'array', label: 'Words', items: { type: 'string' } },
        on: { type: 'boolean', label: 'Ask for a photo' },
      } }}
      params={{ gap_pct: 10, kinds: ['hostile'], words: ['venmo', 'zelle'], on: true }}
      onChange={() => undefined} />);
    expect(html).toContain('Gap (%)');
    expect(html).toMatch(/type="number"[^>]*value="10"/);
    expect(html).toMatch(/checked=""[^>]*\/><span class="mono">hostile/);
    expect(html).toContain('venmo\nzelle');
    expect(html).toContain('Ask for a photo');
  });
});

describe('shadowDiffers', () => {
  const run = (offer: number | null, reply: string | null) => ({
    id: 1, profile_id: 1, shadow: false, state: 'done' as const, outcome: 'send' as const, cost_usd: 0, error: null, created_at: '', finished_at: null,
    decision: { outcome: 'send' as const, extract: null, skill: null, reply, offer: offer === null ? null : { offer_usd: offer, ceiling_usd: 1000, round: 0 },
      stage: null, rules_fired: [], guard: { ok: true, failures: [] }, handoff_reason: null, usage: [] },
  });
  it('flags a different offer or reply, not an identical decision', () => {
    expect(shadowDiffers({ live: run(700, 'a'), shadow: run(700, 'a') })).toBe(false);
    expect(shadowDiffers({ live: run(700, 'a'), shadow: run(800, 'a') })).toBe(true);
    expect(shadowDiffers({ live: run(700, 'a'), shadow: run(700, 'b') })).toBe(true);
    expect(shadowDiffers({ live: null, shadow: run(700, 'a') })).toBe(true);
  });
});

describe('adProblems', () => {
  const ok = { title: 'We buy servers', description: 'Any quantity.', price_usd: 1, category: 'Electronics', condition: 'Used - Good',
    renew_days: FB_SELLER_DEFAULT_SETTINGS.pacing.renew_days, photo_pool_id: 1, photos_min: 3, photos_max: 5 };
  it('passes a complete ad and names what a broken one lacks', () => {
    expect(adProblems(ok)).toEqual({});
    expect(adProblems({ ...ok, title: ' ', renew_days: 61, photos_min: 4, photos_max: 3 }))
      .toEqual({ title: 'fbs_err_required', renew_days: 'fbs_err_renew', photos_max: 'fbs_err_photos_max' });
  });
});
