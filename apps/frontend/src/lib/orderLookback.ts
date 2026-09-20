// What a finished stage recorded, read off the audit log for the status
// section's look-back. Pure: the shells decide how to word and lay it out.
//
// Last match wins. A PO a purchaser edited was reverted and re-submitted, and
// the look-back should show its latest pass, not the first; the log is ASC so
// the last matching event is the newest.

import type { OrderEvent } from './types';

export type StageId = 'draft' | 'in_transit' | 'reviewing' | 'ready_to_pay' | 'done' | 'sold';

export type LookbackFact =
  | { kind: 'submitted'; who: string | null; when: string; lineCount: number; qty: number; totalCost: number }
  | { kind: 'handoffPickup'; who: string | null; when: string; byName: string | null }
  | { kind: 'handoffLabel'; who: string | null; when: string; carrier: string | null; trackingNumber: string | null }
  | { kind: 'advanced'; from: StageId; to: StageId; who: string | null; when: string }
  | { kind: 'doneNote'; note: string; when: string }
  | { kind: 'doneFile'; filename: string; when: string };

const last = (events: OrderEvent[], pred: (e: OrderEvent) => boolean) => {
  for (let i = events.length - 1; i >= 0; i -= 1) if (pred(events[i])) return events[i];
  return undefined;
};
const who = (e: OrderEvent) => e.actor?.name ?? null;

/** The facts recorded at `stage`, in reading order; empty when the log holds
 *  nothing for it (a stage jumped over, or an order older than the events). */
export function lookbackFacts(stage: StageId, events: OrderEvent[]): LookbackFact[] {
  const out: LookbackFact[] = [];
  const advancedFrom = (from: StageId) =>
    last(events, e => e.kind === 'advanced' && e.detail.from === from);
  const advancedTo = (to: StageId) =>
    last(events, e => e.kind === 'advanced' && e.detail.to === to);
  const pushAdvance = (e: OrderEvent | undefined) => {
    if (!e) return;
    out.push({
      kind: 'advanced', from: e.detail.from as StageId, to: e.detail.to as StageId,
      who: who(e), when: e.createdAt,
    });
  };

  switch (stage) {
    case 'draft': {
      const sub = last(events, e => e.kind === 'submitted');
      if (sub) {
        out.push({
          kind: 'submitted', who: who(sub), when: sub.createdAt,
          lineCount: Number(sub.detail.lineCount ?? 0), qty: Number(sub.detail.qty ?? 0),
          totalCost: Number(sub.detail.totalCost ?? 0),
        });
      }
      const ho = last(events, e => e.kind === 'handoff');
      if (ho) {
        out.push(ho.detail.method === 'pickup'
          ? { kind: 'handoffPickup', who: who(ho), when: ho.createdAt, byName: (ho.detail.byName as string) ?? null }
          : {
            kind: 'handoffLabel', who: who(ho), when: ho.createdAt,
            carrier: (ho.detail.carrier as string) ?? null,
            trackingNumber: (ho.detail.trackingNumber as string) ?? null,
          });
      }
      return out;
    }
    case 'in_transit':
      pushAdvance(advancedFrom('in_transit'));
      return out;
    case 'reviewing':
      pushAdvance(advancedFrom('reviewing'));
      return out;
    case 'ready_to_pay':
      pushAdvance(advancedTo('ready_to_pay'));
      pushAdvance(last(events, e => e.kind === 'advanced' && e.detail.from === 'ready_to_pay' && e.detail.to === 'done'));
      return out;
    case 'done': {
      pushAdvance(advancedTo('done'));
      for (const e of events) {
        if (e.kind !== 'status_meta_changed' || e.detail.status !== 'Done') continue;
        if (e.detail.field === 'note' && typeof e.detail.to === 'string' && e.detail.to) {
          out.push({ kind: 'doneNote', note: e.detail.to, when: e.createdAt });
        } else if (e.detail.field === 'attachment_added' && typeof e.detail.filename === 'string') {
          out.push({ kind: 'doneFile', filename: e.detail.filename, when: e.createdAt });
        }
      }
      // Sold shares Done's step, so its settle is Done's last fact.
      pushAdvance(last(events, e => e.kind === 'advanced' && e.detail.from === 'done' && e.detail.to === 'sold'));
      return out;
    }
    case 'sold':
      pushAdvance(advancedTo('sold'));
      return out;
  }
}
