import { describe, it, expect } from 'vitest';
import {
  redditLeadIsDue, redditLeadIsStale, redditLeadNeedsAction, redditLeadRank, type RedditLead,
} from '@recycle-erp/shared';
import { composeUrl, dmDraft, parseCsv, parseLeadsFile } from './redditLeads';
import { leadsTabPath, matchLeadsTab, pathToDesktopView } from './route';

const lead = (over: Partial<RedditLead> = {}): RedditLead => ({
  username: 'newuser156', name: 'NewUser156', sales: 289, buys: 4, recordSource: '', subreddits: ['homelabsales'],
  lastDeal: '2026-10-30', itemsSold: ['HP ProDesk 600 G3', 'EliteDesk 800 G6'], latestPostTitle: '', latestPostUrl: '',
  trackerAlerts: 1, claimed: true, mine: true, holderId: 'u1', holderName: 'Marcus', claimedAt: Date.now(),
  stage: 'claimed', closed: '', followUp: null, dmAt: null, lastReply: null, ...over,
});

describe('lead urgency', () => {
  const today = '2026-10-31';
  it('ranks a due follow-up, then a first DM, then talks, then closed', () => {
    expect(redditLeadRank(lead({ stage: 'replied', followUp: '2026-10-30' }), today)).toBe(0);
    expect(redditLeadRank(lead(), today)).toBe(1);
    expect(redditLeadRank(lead({ stage: 'dm', followUp: '2026-11-03' }), today)).toBe(2);
    expect(redditLeadRank(lead({ stage: 'won' }), today)).toBe(3);
    expect(redditLeadRank(lead({ stage: 'replied', closed: 'nostock', followUp: '2026-10-01' }), today)).toBe(3);
  });
  it('a closed lead is never due, and stale needs 48 hours with no DM', () => {
    expect(redditLeadIsDue(lead({ closed: 'lost', followUp: '2026-10-01' }), today)).toBe(false);
    const now = Date.now();
    expect(redditLeadIsStale(lead({ claimedAt: now - 49 * 3_600_000 }), now)).toBe(true);
    expect(redditLeadIsStale(lead({ claimedAt: now - 47 * 3_600_000 }), now)).toBe(false);
    expect(redditLeadIsStale(lead({ stage: 'dm', claimedAt: now - 99 * 3_600_000 }), now)).toBe(false);
    expect(redditLeadNeedsAction(lead({ stage: 'dm', followUp: '2026-11-05' }), today)).toBe(false);
  });
});

describe('DM drafts', () => {
  it('fills the bulk template from the seller record', () => {
    const d = dmDraft('bulk', lead(), 'Marcus');
    expect(d.subject).toBe('Buying in bulk — saw your sales on r/homelabsales');
    expect(d.body).toContain('Hi u/NewUser156');
    expect(d.body).toContain('HP ProDesk 600 G3 and EliteDesk 800 G6');
    expect(d.body).toContain('289 confirmed sales');
  });
  it('falls back when the seller has no items or subreddit', () => {
    const d = dmDraft('item', lead({ itemsSold: [], subreddits: [] }), 'Priya');
    expect(d.subject).toBe('Do you have more what you sold recently?');
  });
  it('encodes the compose link', () => {
    expect(composeUrl('a_b', 'Hi & bye', 'x\ny')).toBe('https://www.reddit.com/message/compose/?to=a_b&subject=Hi%20%26%20bye&message=x%0Ay');
  });
});

describe('import files', () => {
  it('reads the harvest CSV, skipping sellers with no sale', () => {
    const csv = 'seller,lifetime_sales,lifetime_buys,subs,last_trade,items_sold\n'
      + 'NewUser156,289,4,homelabsales,2026-10-30,"2 x HP ProDesk | https://x | EliteDesk"\n'
      + 'nobody,0,3,hardwareswap,,\n'
      + 'jnecr,74,19,"hardwareswap;homelabsales",2026-09-10,"5x ""coasters"""\n';
    const body = parseLeadsFile('contacts.csv', csv);
    expect(body.sellers.map(s => s.name)).toEqual(['NewUser156', 'jnecr']);
    expect(body.sellers[0].itemsSold).toEqual(['2 x HP ProDesk', 'EliteDesk']);
    expect(body.sellers[1].subreddits).toEqual(['hardwareswap', 'homelabsales']);
    expect(body.sellers[1].itemsSold).toEqual(['5x "coasters"']);
    expect(body.buyers).toBeUndefined();
  });
  it('refuses a CSV without the harvest columns and a JSON without sellers', () => {
    expect(() => parseLeadsFile('x.csv', 'a,b\n1,2')).toThrow('rlImportBadCsv');
    expect(() => parseLeadsFile('x.json', '{"rows":[]}')).toThrow('rlImportBadJson');
  });
  it('parses CRLF and quoted commas', () => {
    expect(parseCsv('a,"b,c"\r\n1,2')).toEqual([['a', 'b,c'], ['1', '2']]);
  });
});

describe('leads routes', () => {
  it('maps the tabs to paths and back', () => {
    expect(leadsTabPath('pool')).toBe('/leads/reddit');
    expect(leadsTabPath('network')).toBe('/leads/reddit/network');
    expect(matchLeadsTab('/leads/reddit/mine')).toBe('mine');
    expect(matchLeadsTab('/leads/reddit/bogus')).toBeNull();
    expect(pathToDesktopView('/leads/reddit')).toBe('leadsReddit');
    expect(pathToDesktopView('/leads/reddit/team')).toBe('leadsReddit');
  });
});
