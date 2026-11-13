import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FbChatAccountRow, FbChatDeviceRow } from '@recycle-erp/shared';

// The Accounts tab's pieces render to markup without a DOM; with no language
// provider `t` returns its key. The client is swapped out so nothing reaches
// lib/api.ts.
vi.mock('../../../../lib/fbChat', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/fbChat')>('../../../../lib/fbChat');
  const never = () => new Promise(() => undefined);
  return { ...actual, fbChatApi: Object.fromEntries(Object.keys(actual.fbChatApi).map(k => [k, vi.fn(never)])) };
});
vi.mock('../../../../lib/errorToast', () => ({ handleFetchError: vi.fn() }));

const { AccountRequests, fbChatBrowser } = await import('./AccountRequests');
const { AccountDetail, AccountsTable } = await import('./AccountsTable');
const { AccountsTab, fbChatWaitingDevices } = await import('./AccountsTab');
const { LoadState } = await import('./shared');

const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEVICE: FbChatDeviceRow = {
  id: 'a1b2c3', code: 'K7Q-42M', status: 'pending', label: 'Buyer 11', fb_uid: '100095512087', ext_version: '0.3.0',
  created_ip: '73.14.202.18', user_agent: MAC, created_at: ago(180), last_seen_at: ago(20),
  decided_by: null, decided_at: null, matches_account: null,
};
const ACCOUNT: FbChatAccountRow = {
  id: 3, no: 1, fb_uid: '100089231457', label: 'Denver RAM Buyer', ext_version: '0.3.0', restricted: null, restricted_at: null,
  last_seen_at: ago(40), created_at: ago(86400), threads: 41, unread: 2, replies_waiting: 0, last_sync_at: ago(40),
  paused: false, stale_after_sec: 300, config_state: 'up_to_date', config_seen_at: ago(40),
  device: {
    id: 'dev1', label: 'Buyer 1', status: 'approved', ext_version: '0.3.0', user_agent: MAC, created_ip: '73.14.202.18',
    last_seen_at: ago(40), decided_by: 'Jin Hu', decided_at: ago(3600),
  },
};
const noop = () => undefined;
const table = { waiting: [], latestVersion: '0.3.0', busy: null, onRename: async () => true, onPause: noop, onDisconnect: noop };

describe('Accounts tab', () => {
  it('reads the browser out of a user agent', () => {
    expect(fbChatBrowser(MAC)).toEqual({ browser: 'Chrome 131', os: 'macOS' });
    expect(fbChatBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'))
      .toEqual({ browser: 'Edge 131', os: 'Windows' });
    expect(fbChatBrowser('curl/8.4.0')).toBeNull();
  });

  it('shows a request as a card to name and approve', () => {
    const html = renderToString(<AccountRequests requests={[DEVICE]} nextNo={11} busy={null} onApprove={noop} onDeny={noop} />);
    expect(html).toContain('K7Q-42M');
    expect(html).toContain('fbca_fbUser');
    expect(html).toContain('fbca_browserOn');
    expect(html).toContain('73.14.202.18');
    expect(html).toContain('value="Buyer 11"');
    expect(html).toContain('fbca_startPaused');
    expect(html).toContain('fbca_approve');
    expect(html).toContain('fbca_deny');
    expect(html).not.toContain('fbca_reconnect');
    expect(html).toContain('fbca_extSummary');
  });

  it('offers Reconnect, with no name to choose, when the Facebook user is already an account', () => {
    const known = { ...DEVICE, matches_account: { id: 9, no: 7, label: 'Westside Parts' } };
    const html = renderToString(<AccountRequests requests={[known]} nextNo={11} busy={null} onApprove={noop} onDeny={noop} />);
    expect(html).toContain('fbca_reconnectLead');
    expect(html).toContain('Westside Parts');
    expect(html).toContain('>fbca_reconnect<');
    expect(html).not.toContain('fbca_nameIt');
    expect(html).not.toContain('fbca_startPaused');
  });

  it('says so when a request has no Facebook user, and when nobody is waiting', () => {
    const html = renderToString(<AccountRequests requests={[{ ...DEVICE, fb_uid: null }]} nextNo={1} busy={null} onApprove={noop} onDeny={noop} />);
    expect(html).toContain('fbca_notSignedIn');
    expect(renderToString(<AccountRequests requests={[]} nextNo={1} busy={null} onApprove={noop} onDeny={noop} />))
      .toContain('fbca_requestsNone');
  });

  it('lists accounts with status, waiting replies, version and settings state', () => {
    const rows: FbChatAccountRow[] = [
      ACCOUNT,
      { ...ACCOUNT, id: 4, no: 2, label: 'Server Parts Cash', paused: true, replies_waiting: 2, ext_version: '0.2.0', config_state: 'waiting' },
      { ...ACCOUNT, id: 5, no: 3, label: 'Westside Parts', restricted: 'login' },
      { ...ACCOUNT, id: 6, no: 4, label: 'Englewood Exchange', last_seen_at: ago(4000), last_sync_at: null },
    ];
    const html = renderToString(<AccountsTable {...table} accounts={rows} />);
    for (const key of ['fbc_statusRunning', 'fbc_statusPaused', 'fbc_statusLogin', 'fbc_statusStale']) expect(html).toContain(key);
    expect(html.match(/fbca_update</g)).toHaveLength(1);
    expect(html.match(/fbca_cfgWaiting</g)).toHaveLength(1);
    expect(html.match(/fbca_cfgUpToDate/g)).toHaveLength(3);
    expect(html).toContain('<td class="num">2</td>');
    // Rows start closed.
    expect(html).not.toContain('fbca_disconnect');
    expect(renderToString(<AccountsTable {...table} accounts={[]} />)).toContain('fbca_accountsNone');
  });

  it('opens a row onto its Chrome and the three actions', () => {
    const detail = (account: FbChatAccountRow) => renderToString(
      <table><tbody><AccountDetail account={account} busy={false} onRename={noop} onPause={noop} onDisconnect={noop} /></tbody></table>,
    );
    const html = detail(ACCOUNT);
    for (const key of ['fbca_chromeVersion', 'fbca_approvedBy', 'fbca_rename', 'fbca_pause', 'fbca_disconnect']) expect(html).toContain(key);
    expect(detail({ ...ACCOUNT, paused: true })).toContain('fbca_resume');
    // Nothing to disconnect once the Chrome is revoked, or for an account that never had one.
    const revoked = detail({ ...ACCOUNT, device: { ...ACCOUNT.device!, status: 'revoked' } });
    expect(revoked).toContain('fbca_chromeGone');
    expect(revoked).not.toContain('fbca_disconnect');
    expect(detail({ ...ACCOUNT, device: null })).toContain('fbca_chromeNone');
  });

  it('keeps an approved Chrome visible until its account checks in', () => {
    const approved: FbChatDeviceRow = { ...DEVICE, id: 'new1', status: 'approved' };
    const relaying: FbChatDeviceRow = { ...DEVICE, id: 'dev1', status: 'approved' };
    const revoked: FbChatDeviceRow = { ...DEVICE, id: 'old1', status: 'revoked' };
    expect(fbChatWaitingDevices([DEVICE, approved, relaying, revoked], [ACCOUNT]).map(d => d.id)).toEqual(['new1']);
    expect(renderToString(<AccountsTable {...table} accounts={[]} waiting={[approved]} />)).toContain('fbca_waitingFirst');
  });

  it('says it is loading until both lists have arrived, and offers another try when a read failed', () => {
    const html = renderToString(<AccountsTab />);
    expect(html).toContain('fbca_loading');
    expect(html).not.toContain('fbca_tryAgain');
    const failed = renderToString(<LoadState failed loading="l" failedText="did not load" retryText="again" onRetry={noop} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('did not load');
    expect(failed).toContain('>again</button>');
  });
});
