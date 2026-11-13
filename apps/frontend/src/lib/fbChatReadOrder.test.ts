import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ api: {} }));
vi.mock('./errorToast', () => ({ handleFetchError: vi.fn() }));

const { fbChatReadOrder } = await import('./fbChat');

describe('fbChatReadOrder', () => {
  it('drops the answer of a read that started before one already shown', () => {
    const order = fbChatReadOrder();
    const poll = order.start();
    // A save lands and the page reads again while the poll is still out.
    const afterSave = order.start();
    expect(order.takes(afterSave)).toBe(true);
    expect(order.takes(poll)).toBe(false);
    expect(order.takes(order.start())).toBe(true);
  });

  it('takes answers that arrive in the order their reads started', () => {
    const order = fbChatReadOrder();
    const first = order.start();
    const second = order.start();
    expect(order.takes(first)).toBe(true);
    expect(order.takes(second)).toBe(true);
  });

  it('lets an earlier answer stand in for a later read that failed', () => {
    const order = fbChatReadOrder();
    const first = order.start();
    const second = order.start();
    expect(order.takes(second, false)).toBe(true);
    expect(order.takes(first)).toBe(true);
    // And a failure of a read older than what is shown says nothing.
    const third = order.start();
    const fourth = order.start();
    expect(order.takes(fourth)).toBe(true);
    expect(order.takes(third, false)).toBe(false);
  });

  it('takes nothing started before what is read changed', () => {
    const order = fbChatReadOrder();
    const old = order.start();
    order.reset();
    const fresh = order.start();
    expect(order.takes(old)).toBe(false);
    expect(order.takes(old, false)).toBe(false);
    expect(order.takes(fresh)).toBe(true);
  });
});
