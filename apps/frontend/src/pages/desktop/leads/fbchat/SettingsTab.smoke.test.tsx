import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FbChatConfigEntry, FbChatConfigPage, FbChatKnownConfigField } from '@recycle-erp/shared';

// The Settings form renders to markup without a DOM; with no language
// provider `t` returns its key. The fetchers are swapped out so the module
// graph never reaches lib/api.ts.
vi.mock('../../../../lib/fbChat', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/fbChat')>('../../../../lib/fbChat');
  const never = () => new Promise(() => undefined);
  return { ...actual, fbChatApi: Object.fromEntries(Object.keys(actual.fbChatApi).map(k => [k, vi.fn(never)])) };
});
vi.mock('../../../../lib/errorToast', () => ({ handleFetchError: vi.fn() }));

const { SettingsForm, SettingsTab } = await import('./SettingsTab');

const int = (key: string, def: number, min: number, max: number): FbChatKnownConfigField =>
  ({ key, label: `ext ${key}`, type: 'integer', default: def, min, max, versions: ['0.3.0'] });
const FIELDS: FbChatKnownConfigField[] = [
  { key: 'paused', label: 'ext paused', type: 'boolean', default: false, versions: ['0.3.0'] },
  int('minSendIntervalSec', 20, 10, 600),
  { key: 'typingPace', label: 'ext pace', type: 'number', default: 1, min: 0.5, max: 3, versions: ['0.3.0'] },
  int('inboxRefreshMinSec', 20, 10, 7200),
  int('inboxRefreshMaxSec', 40, 10, 7200),
  int('quietThreadMin', 15, 1, 1440),
  int('configPollSec', 60, 30, 3600),
  { key: 'greeting', label: 'Greeting line', help: 'Sent first.', type: 'string', default: 'Hi', versions: ['0.4.0'] },
];
const entry = (key: string, account_id: number | null, value: unknown): FbChatConfigEntry =>
  ({ key, account_id, value, updated_at: '2026-11-12T00:00:00Z', updated_by: null });
const PAGE: FbChatConfigPage = {
  fields: FIELDS,
  entries: [entry('paused', 4, true), entry('minSendIntervalSec', 2, 45), entry('minSendIntervalSec', 4, 50), entry('oldKnob', null, { a: 1 })],
  accounts: [],
};
const ACCOUNTS = [
  { id: 2, no: 2, label: 'Server Parts Cash', fb_uid: '100091187220' },
  { id: 4, no: 3, label: '', fb_uid: '100077000001' },
];
const noop = async () => undefined;
const form = (over: Partial<Parameters<typeof SettingsForm>[0]> = {}) => renderToString(
  <SettingsForm page={PAGE} accounts={ACCOUNTS} telegram={{ configured: true, topics: 1412 }} scope={null} onScope={noop} onSave={noop} onReset={noop} {...over} />,
);

describe('Settings tab', () => {
  it('draws the three sections from the reported fields, with the page’s own copy for the ones it knows', () => {
    const html = form();
    for (const key of ['fbcs_sending', 'fbcs_reading', 'fbcs_telegram', 'fbcs_advanced']) expect(html).toContain(key);
    for (const key of ['paused', 'minSendIntervalSec', 'typingPace', 'inboxRefresh', 'quietThreadMin', 'configPollSec']) {
      expect(html).toContain(`fbcs_f_${key}`);
    }
    expect(html).not.toContain('ext paused');
    // The two refresh fields are one row with two inputs.
    expect(html).not.toContain('fbcs_f_inboxRefreshMinSec');
    expect(html).toContain('aria-label="fbcs_shortest"');
    expect(html).toContain('aria-label="fbcs_longest"');
    expect(html.indexOf('fbcs_f_quietThreadMin')).toBeLessThan(html.indexOf('fbcs_advanced'));
    expect(html.indexOf('fbcs_advanced')).toBeLessThan(html.indexOf('fbcs_f_configPollSec'));
  });

  it('keeps a field it does not know, and a value no extension reports, under Advanced', () => {
    const html = form();
    const adv = html.slice(html.indexOf('fbcs_advanced'));
    expect(adv).toContain('Greeting line');
    expect(adv).toContain('Sent first.');
    expect(adv).toContain('oldKnob');
    expect(adv).toContain('fbcs_orphan');
    expect(adv).toContain('{&quot;a&quot;:1}');
  });

  it('says how many accounts differ on the every-account view, and offers every account by number', () => {
    const html = form();
    expect(html.match(/fbcs_differ/g)).toHaveLength(2);       // paused, minSendIntervalSec
    expect(html).not.toContain('fbcs-own');
    expect(html).toContain('#<!-- -->2<!-- --> <!-- -->Server Parts Cash');
    expect(html).toContain('#<!-- -->3<!-- --> <!-- -->100077000001');
    expect(html).toContain('fbcs_hintAll');
    expect(html).toContain('aria-checked="false"');
  });

  it('tints an account’s own values and offers to drop them', () => {
    const html = form({ scope: 4 });
    expect(html.match(/fbcs-own fbc-acct/g)).toHaveLength(2);
    expect(html.match(/fbcs_useEvery/g)).toHaveLength(2);
    expect(html).toContain('fbcs_thisAccount');
    expect(html).toContain('fbcs_hintOne');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('value="50"');
    // The shared orphan belongs to the every-account view.
    expect(html).not.toContain('oldKnob');
  });

  it('shows the Telegram status the server gives, and nothing before it answers', () => {
    expect(form()).toContain('fbcs_tgConnected');
    expect(form()).toContain('1,412');
    expect(form({ telegram: { configured: false, topics: 0 } })).toContain('fbcs_tgNotSetUp');
    expect(form({ telegram: null })).not.toContain('fbcs_tgConnected');
  });

  it('says so when no extension has reported a field', () => {
    const html = form({ page: { fields: [], entries: [], accounts: [] } });
    expect(html.match(/fbcs_noFields/g)).toHaveLength(2);
    expect(html).not.toContain('fbcs_advanced');
  });

  it('says it is loading until the settings arrive', () => {
    const html = renderToString(<SettingsTab />);
    expect(html).toContain('fbcs_loading');
    expect(html).not.toContain('fbcs_sending');
  });
});
