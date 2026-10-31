import { useSyncExternalStore } from 'react';
import {
  type RedditBuyer, type RedditBuyerTree, type RedditLead, type RedditLeadClosing, type RedditLeadEvent,
  type RedditLeadImport, type RedditLeadStage,
} from '@recycle-erp/shared';
import { api } from './api';

export type { RedditBuyer, RedditBuyerTree, RedditLead, RedditLeadEvent, RedditLeadStage, RedditLeadClosing };

const BASE = '/api/leads/reddit';
const key = (u: string) => encodeURIComponent(u);

export const leadsApi = {
  list: () => api.get<{ leads: RedditLead[]; today: string }>(BASE),
  detail: (u: string) =>
    api.get<{ lead: RedditLead; history: RedditLeadEvent[]; buyers: { username: string; name: string }[] }>(`${BASE}/${key(u)}`),
  buyers: () => api.get<{ buyers: RedditBuyer[] }>(`${BASE}/buyers`),
  buyer: (u: string) => api.get<RedditBuyerTree>(`${BASE}/buyers/${key(u)}`),
  claim: (u: string) => api.post<RedditLead>(`${BASE}/${key(u)}/claim`, {}),
  release: (u: string) => api.post<RedditLead>(`${BASE}/${key(u)}/release`, {}),
  dm: (u: string, template: string) => api.post<RedditLead>(`${BASE}/${key(u)}/dm`, { template }),
  reply: (u: string, text: string) => api.post<RedditLead>(`${BASE}/${key(u)}/reply`, { text }),
  stage: (u: string, stage: RedditLeadStage) => api.put<RedditLead>(`${BASE}/${key(u)}/stage`, { stage }),
  followUp: (u: string, date: string | null) => api.put<RedditLead>(`${BASE}/${key(u)}/follow-up`, { date }),
  close: (u: string, closed: RedditLeadClosing) => api.put<RedditLead>(`${BASE}/${key(u)}/close`, { closed }),
  reopen: (u: string) => api.post<RedditLead>(`${BASE}/${key(u)}/reopen`, {}),
  import: (body: RedditLeadImport) =>
    api.post<{ sellers: number; added: number; updated: number; buyers: number; trades: number }>(`${BASE}/import`, body),
};

// ─── Sidebar badge ────────────────────────────────────────────────────────────
// The viewer's leads waiting on them. The page fires LEADS_CHANGED after every
// write, so the badge follows without polling.

export const LEADS_CHANGED = 'rl-leads-changed';
let attention = 0;
let reading = false;
let stale = false;
const readers = new Set<() => void>();

function readAttention() {
  if (reading) { stale = true; return; }
  reading = true;
  api.get<{ n: number }>(`${BASE}/attention`)
    // A badge that fails to load stays as it was; it is never worth a dialog.
    .then(r => { attention = r.n; for (const l of readers) l(); }, () => {})
    .finally(() => {
      reading = false;
      if (stale) { stale = false; readAttention(); }
    });
}

function watchAttention(onChange: () => void) {
  if (readers.size === 0) window.addEventListener(LEADS_CHANGED, readAttention);
  readers.add(onChange);
  if (!reading) readAttention();
  return () => {
    readers.delete(onChange);
    if (readers.size === 0) window.removeEventListener(LEADS_CHANGED, readAttention);
  };
}

export function useLeadsAttention(): number {
  return useSyncExternalStore(watchAttention, () => attention);
}

export const leadsChanged = () => window.dispatchEvent(new Event(LEADS_CHANGED));

// ─── DM templates ─────────────────────────────────────────────────────────────
// The message goes to a Reddit seller, so it is English whatever the ERP's
// language. Each fills in what the bots' records say about the seller.

export type DmTemplateId = 'bulk' | 'item' | 'follow';
export const DM_TEMPLATES: readonly DmTemplateId[] = ['bulk', 'item', 'follow'];

type Seller = Pick<RedditLead, 'name' | 'sales' | 'subreddits' | 'itemsSold'>;

export function dmDraft(id: DmTemplateId, s: Seller, me: string): { subject: string; body: string } {
  const sub = s.subreddits[0] ?? 'homelabsales';
  const items = s.itemsSold.slice(0, 2);
  if (id === 'item') {
    const item = items[0] ?? 'what you sold recently';
    return {
      subject: `Do you have more ${item}?`,
      body: `Hi u/${s.name},\n\nDo you have any more ${item}? We'd take several at once and pay quickly.\n\nWhat quantity could you do, and at what price?\n\n${me}, Recycle Servers`,
    };
  }
  if (id === 'follow') {
    return {
      subject: 'Following up',
      body: `Hi u/${s.name},\n\nFollowing up on my last message. We're still keen to buy any spare hardware you have, in any quantity. Is there a good time to talk?\n\n${me}, Recycle Servers`,
    };
  }
  const sold = items.length ? items.join(' and ') : 'hardware';
  return {
    subject: `Buying in bulk — saw your sales on r/${sub}`,
    body: `Hi u/${s.name},\n\nI'm ${me} with Recycle Servers in Denver. I saw you've sold ${sold} on r/${sub}, and your ${s.sales} confirmed sales caught our eye.\n\nWe buy used servers, drives and parts in volume and pay fast (PayPal G&S, or cash pickup in Colorado). Do you have more stock you'd like to move? Happy to make one offer on a whole lot.\n\nThanks,\n${me}`,
  };
}

/** Reddit's compose page with the message filled in; the purchaser presses Send. */
export function composeUrl(to: string, subject: string, body: string): string {
  return `https://www.reddit.com/message/compose/?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&message=${encodeURIComponent(body)}`;
}

export const profileUrl = (name: string) => `https://www.reddit.com/user/${encodeURIComponent(name)}/`;

// ─── Import ───────────────────────────────────────────────────────────────────

/**
 * Reads the harvest file: the JSON the harvest script writes, or its sellers
 * CSV (seller, lifetime_sales, lifetime_buys, … as contact_list.csv). A CSV
 * carries no buyer network; that needs the JSON.
 */
export function parseLeadsFile(name: string, text: string): RedditLeadImport {
  if (name.toLowerCase().endsWith('.json')) {
    const body = JSON.parse(text) as RedditLeadImport;
    if (!body || !Array.isArray(body.sellers)) throw new Error('rlImportBadJson');
    return body;
  }
  const rows = parseCsv(text);
  const head = rows.shift()?.map(h => h.trim()) ?? [];
  const col = (r: string[], k: string) => r[head.indexOf(k)]?.trim() ?? '';
  if (!head.includes('seller') || !head.includes('lifetime_sales')) throw new Error('rlImportBadCsv');
  const sellers = rows
    .filter(r => r.length > 1 && Number(col(r, 'lifetime_sales')) > 0)
    .map(r => ({
      name: col(r, 'seller'),
      sales: Number(col(r, 'lifetime_sales')),
      buys: Number(col(r, 'lifetime_buys') || 0),
      recordSource: col(r, 'record_source'),
      subreddits: col(r, 'subs').split(/[;,]/).map(s => s.trim()).filter(Boolean),
      lastDeal: col(r, 'last_trade') || null,
      itemsSold: col(r, 'items_sold').split('|').map(s => s.trim()).filter(s => s && !s.startsWith('http')).slice(0, 5),
      latestPostTitle: col(r, 'latest_post'),
      latestPostUrl: col(r, 'latest_url'),
      trackerAlerts: Number(col(r, 'tracker_alerts') || 0),
    }));
  return { sellers };
}

/** RFC 4180 enough for the harvest's own files: quoted fields, doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
