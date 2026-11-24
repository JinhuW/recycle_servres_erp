import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Rendered to markup without a DOM, so effects never run; with no language
// provider `t` returns its key. The API is swapped out so the module graph
// never reaches the network.
vi.mock('../../../lib/api', () => ({ api: { get: vi.fn(() => new Promise(() => undefined)), patch: vi.fn() } }));
vi.mock('../../../lib/errorToast', () => ({ handleFetchError: vi.fn() }));

const { AiModelsPanel, ProviderKeyRow } = await import('./AiModelsPanel');

describe('a provider key row', () => {
  const row = (over: Record<string, unknown>, canStore = true) => renderToString(
    <ProviderKeyRow
      p={{ id: 'anthropic', label: 'Anthropic (Claude)', configured: false, source: null, last4: null, trackerSynced: null, ...over }}
      canStore={canStore}
      onChanged={() => undefined}
    />,
  );

  it('shows a saved key, and offers Remove only for one', () => {
    const ui = row({ configured: true, source: 'ui', last4: 'ab12', trackerSynced: true });
    expect(ui).toContain('aiKeySetHere');
    expect(ui).toContain('aiKeyRemove');
    expect(ui).not.toContain('aiKeyTrackerUnsynced');

    const none = row({});
    expect(none).toContain('aiProviderNoKey');
    expect(none).not.toContain('aiKeyRemove');
    expect(none).not.toContain('_API_KEY');
  });

  it('never fills the key field, and warns when the tracker missed the key', () => {
    const html = row({ configured: true, source: 'ui', last4: 'ab12', trackerSynced: false });
    expect(html).toMatch(/type="password"[^>]*value=""/);
    expect(html).toContain('aiKeyTrackerUnsynced');
  });

  it('offers a retry for a key, or a removal, the tracker missed', () => {
    const missedKey = row({ configured: true, source: 'ui', last4: 'ab12', trackerSynced: false });
    expect(missedKey).toContain('aiKeyRetrySync');
    expect(missedKey).not.toContain('aiKeyTrackerRemovalUnsynced');
    const missedRemoval = row({ source: null, trackerSynced: false });
    expect(missedRemoval).toContain('aiKeyTrackerRemovalUnsynced');
    expect(missedRemoval).toContain('aiKeyRetrySync');
    expect(row({ source: 'ui', last4: 'ab12', configured: true, trackerSynced: true })).not.toContain('aiKeyRetrySync');
  });

  it('says when a saved key cannot be read here', () => {
    expect(row({ source: 'ui', last4: 'ab12', unreadable: true, trackerSynced: true })).toContain('aiKeyUnreadable');
  });

  it('locks the field when the server cannot store keys', () => {
    expect(row({}, false)).toMatch(/id="ai-key-anthropic"[^>]*disabled=""/);
  });
});
const { ProviderModelSelect } = await import('../../../components/ProviderModelSelect');

describe('Settings ▸ AI models', () => {
  it('draws a provider and a model field for the default and every feature', () => {
    const html = renderToString(<AiModelsPanel />);
    for (const id of ['default', 'scan', 'receipt', 'paypal', 'serial']) {
      expect(html).toContain(`id="ai-model-${id}-provider"`);
    }
    for (const key of ['aiProvidersTitle', 'aiFeatureScan', 'aiFeatureSerial', 'aiModelsTrackerNote']) {
      expect(html).toContain(key);
    }
  });
});

describe('ProviderModelSelect', () => {
  const render = (value: string, defaultLabel?: string) => renderToString(
    <ProviderModelSelect id="m" value={value} onChange={() => undefined} defaultLabel={defaultLabel} />,
  );

  it('splits a prefixed ref into its provider and its own model id', () => {
    const html = render('anthropic:claude-sonnet-5-5');
    expect(html).toMatch(/<option value="anthropic" selected="">/);
    expect(html).toContain('value="claude-sonnet-5-5"');
  });

  it('reads a bare saved id as OpenRouter', () => {
    const html = render('openai/gpt-6-luna');
    expect(html).toMatch(/<option value="openrouter" selected="">/);
    expect(html).toContain('value="openai/gpt-6-luna"');
  });

  it('offers the default when the caller allows one, and lists every provider', () => {
    const html = render('', 'Default (x)');
    expect(html).toMatch(/<option value="" selected="">Default \(x\)<\/option>/);
    for (const p of ['openrouter', 'anthropic', 'openai']) expect(html).toContain(`<option value="${p}"`);
  });

  it("marks a provider by the keys the caller passes, such as the tracker's", () => {
    const html = renderToString(
      <ProviderModelSelect id="m" value="" onChange={() => undefined} noKeyText="no key on the tracker"
        providers={[
          { id: 'openrouter', label: 'OpenRouter', configured: true, source: 'ui', last4: 'ab12', trackerSynced: true },
          { id: 'anthropic', label: 'Anthropic', configured: false, source: null, last4: null, trackerSynced: null },
          { id: 'openai', label: 'OpenAI', configured: false, source: null, last4: null, trackerSynced: null },
        ]} />,
    );
    expect(html).toMatch(/<option value="anthropic" disabled="">[^<]*(<!-- -->[^<]*)*— no key on the tracker<\/option>/);
    expect(html).toMatch(/<option value="openrouter">OpenRouter(<!-- -->)*<\/option>/);
  });
});
