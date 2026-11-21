import type postgres from 'postgres';
import type { SqlLike } from '../db';
import type { QuotePayload, SellLotPayload } from '../routes/publicForms';

// Tells the team on Telegram about a new website submission. The alert rides
// the Facebook chat hub's queue: an fb_chat_events row with no account or
// thread, which the hub posts as its bot or service account, whichever it runs
// as: to WEB_LEAD_TELEGRAM_CHAT_ID, a group that bot or account is in, or else
// to its own group's General topic. Written in the submission's own
// transaction, so a rolled-back row is never announced, and a Telegram outage
// only delays the alert. With the hub unconfigured the row waits unposted.

// Telegram's sendMessage limit is 4096 characters.
const MAX_MESSAGE = 4000;
const MAX_NOTES = 600;

export type WebLead =
  | { kind: 'sell_lot'; ref: string; payload: SellLotPayload; photos: number }
  | { kind: 'quote'; ref: string; payload: QuotePayload };

export async function queueWebLeadAlert(tx: SqlLike, lead: WebLead): Promise<void> {
  const detail = { submission_id: lead.ref, form: lead.kind } as postgres.JSONValue;
  await tx`
    INSERT INTO fb_chat_events (kind, detail, alert)
    VALUES ('web_lead', ${tx.json(detail)}, ${formatWebLead(lead)})`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Plain text: the hub sends no parse_mode, so a sender's own text can't break formatting. */
export function formatWebLead(lead: WebLead): string {
  const out: string[] = [];
  if (lead.kind === 'sell_lot') {
    const p = lead.payload;
    const units = p.lines.reduce((n, l) => n + l.qty, 0);
    out.push(`🟢 New sell request ${lead.ref} · ram4cash.com`);
    out.push(`Email: ${p.email}`);
    out.push(`Source: ${p.source}`);
    out.push(p.handoff === 'pickup' ? `Handoff: pickup in ${p.pickup_location}` : 'Handoff: ship');
    out.push([plural(p.lines.length, 'line'), plural(units, 'unit'), ...(lead.photos ? [plural(lead.photos, 'photo')] : [])]
      .join(' · '));
    for (const l of p.lines) {
      const f = l.fields;
      const spec = [f.brand, f.capacity, f.classification, f.speed, f.rank, f.interface, f.form_factor, f.description]
        .filter(Boolean).join(' ');
      out.push(`• ${l.qty}× ${l.category}${spec ? ` ${spec}` : ''}${f.part_number ? ` [${f.part_number}]` : ''}`);
    }
  } else {
    const q = lead.payload;
    out.push(`🟢 New quote request ${lead.ref} · recycleservers.com`);
    out.push(`Name: ${q.name}${q.company ? ` (${q.company})` : ''} · ${q.customer_type}`);
    out.push(`Email: ${q.email}`);
    if (q.phone) out.push(`Phone: ${q.phone}`);
    out.push(`Hardware: ${q.hardware.join(', ')}`);
    const extra: [string, string | null][] = [
      ['Quantity', q.quantity], ['Condition', q.condition], ['Data', q.data_handling],
      ['Pickup', q.pickup_method], ['ZIP', q.origin_zip], ['Timeline', q.timeline],
    ];
    for (const [k, v] of extra) if (v) out.push(`${k}: ${v}`);
  }
  if (lead.payload.notes) out.push(`Notes: ${clip(lead.payload.notes, MAX_NOTES)}`);
  out.push('ERP ▸ Web submissions');
  return clip(out.join('\n'), MAX_MESSAGE);
}
