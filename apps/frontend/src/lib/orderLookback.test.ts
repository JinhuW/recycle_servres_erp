import { describe, it, expect } from 'vitest';
import { lookbackFacts } from './orderLookback';
import type { OrderEvent } from './types';

let n = 0;
const ev = (kind: OrderEvent['kind'], detail: Record<string, unknown>, name: string | null = 'Marcus'): OrderEvent => ({
  id: String(++n), kind, detail, createdAt: `2026-09-${String(10 + n).padStart(2, '0')}T10:00:00Z`,
  actor: name ? { id: 'u', name, initials: name[0] } : null,
});

describe('lookbackFacts', () => {
  it('Draft: who submitted and how it was handed off', () => {
    const events = [
      ev('created', {}),
      ev('handoff', { method: 'label', carrier: 'UPS', trackingNumber: '1Z1' }),
      ev('submitted', { lineCount: 1, qty: 71, totalCost: 7100 }),
    ];
    expect(lookbackFacts('draft', events)).toEqual([
      expect.objectContaining({ kind: 'submitted', who: 'Marcus', lineCount: 1, qty: 71, totalCost: 7100 }),
      expect.objectContaining({ kind: 'handoffLabel', carrier: 'UPS', trackingNumber: '1Z1' }),
    ]);
  });

  it('after a revert and a second submission, the latest pass is what shows', () => {
    const events = [
      ev('handoff', { method: 'pickup', byName: 'Alex' }),
      ev('submitted', { lineCount: 1, qty: 2, totalCost: 100 }),
      ev('reverted', { from: 'in_transit', to: 'draft' }),
      ev('handoff', { method: 'label', carrier: 'USPS', trackingNumber: '9400' }),
      ev('submitted', { lineCount: 2, qty: 4, totalCost: 200 }, 'Priya'),
    ];
    const facts = lookbackFacts('draft', events);
    expect(facts[0]).toMatchObject({ kind: 'submitted', who: 'Priya', totalCost: 200 });
    expect(facts[1]).toMatchObject({ kind: 'handoffLabel', carrier: 'USPS' });
  });

  it('each later stage is the advance that closed it', () => {
    const events = [
      ev('submitted', {}),
      ev('advanced', { from: 'in_transit', to: 'reviewing' }, 'Alex'),
      ev('advanced', { from: 'reviewing', to: 'ready_to_pay' }, 'Alex'),
      ev('advanced', { from: 'ready_to_pay', to: 'done' }, 'Alex'),
      ev('status_meta_changed', { status: 'Done', field: 'note', to: 'Paid in the September batch' }),
      ev('status_meta_changed', { status: 'Done', field: 'attachment_added', filename: 'transfer.png' }),
    ];
    expect(lookbackFacts('in_transit', events)).toEqual([
      expect.objectContaining({ kind: 'advanced', from: 'in_transit', to: 'reviewing', who: 'Alex' }),
    ]);
    expect(lookbackFacts('reviewing', events)).toEqual([
      expect.objectContaining({ kind: 'advanced', from: 'reviewing', to: 'ready_to_pay' }),
    ]);
    expect(lookbackFacts('ready_to_pay', events).map(f => f.kind)).toEqual(['advanced', 'advanced']);
    expect(lookbackFacts('done', events).map(f => f.kind)).toEqual(['advanced', 'doneNote', 'doneFile']);
  });

  it('a sell-out is Done\'s last fact and the system\'s, not anyone\'s', () => {
    const events = [
      ev('advanced', { from: 'ready_to_pay', to: 'done' }, 'Alex'),
      ev('status_meta_changed', { status: 'Done', field: 'note', to: 'Paid' }),
      ev('advanced', { from: 'done', to: 'sold' }, null),
    ];
    expect(lookbackFacts('done', events).map(f => f.kind)).toEqual(['advanced', 'doneNote', 'advanced']);
    expect(lookbackFacts('done', events).at(-1)).toMatchObject({ kind: 'advanced', to: 'sold', who: null });
    expect(lookbackFacts('sold', events)).toEqual([
      expect.objectContaining({ kind: 'advanced', from: 'done', to: 'sold', who: null }),
    ]);
  });

  it('a stage the order jumped over, or a log from before the events, has nothing', () => {
    expect(lookbackFacts('reviewing', [ev('submitted', {}), ev('advanced', { from: 'in_transit', to: 'ready_to_pay' })]))
      .toEqual([]);
    expect(lookbackFacts('draft', [])).toEqual([]);
  });
});
