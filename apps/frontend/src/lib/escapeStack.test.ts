import { describe, it, expect, vi } from 'vitest';
import { createEscapeStack } from './escapeStack';

describe('createEscapeStack', () => {
  it('fires only the top entry', () => {
    const stack = createEscapeStack();
    const page = vi.fn();
    const dialog = vi.fn();
    stack.push(1, page);
    stack.push(2, dialog);
    expect(stack.dispatch()).toBe(true);
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
  });

  it('hands Escape to the next layer once the top is removed', () => {
    const stack = createEscapeStack();
    const page = vi.fn();
    stack.push(1, page);
    const remove = stack.push(2, vi.fn());
    remove();
    stack.dispatch();
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('lets a busy top entry swallow Escape', () => {
    const stack = createEscapeStack();
    const page = vi.fn();
    let busy = true;
    const close = vi.fn();
    stack.push(1, page);
    stack.push(2, () => { if (!busy) close(); });
    stack.dispatch();
    expect(close).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    busy = false;
    stack.dispatch();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps a re-activated entry below a child that is still open', () => {
    const stack = createEscapeStack();
    const parent = vi.fn();
    const child = vi.fn();
    const removeParent = stack.push(1, parent);
    stack.push(2, child);
    removeParent();
    stack.push(1, parent);
    stack.dispatch();
    expect(child).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();
  });

  it('reports nothing handled when empty', () => {
    const stack = createEscapeStack();
    expect(stack.dispatch()).toBe(false);
    expect(stack.size()).toBe(0);
  });
});
