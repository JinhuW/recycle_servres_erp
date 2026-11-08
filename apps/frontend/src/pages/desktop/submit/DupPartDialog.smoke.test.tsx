import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Markup only, no DOM. With no language provider `t` returns its key.
// Modal reads document on mount; the dialog's body renders the same without it.
vi.mock('../../../components/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <>{children}</> }));

const { DupPartDialog } = await import('./DupPartDialog');

const GROUPS = [
  { partNumber: 'M393A4K40DB3-CWE', idxs: [0, 2] },
  { partNumber: 'SSDSC2KB960G8', idxs: [1, 3] },
];

const render = (onOpenLine?: (idx: number) => void) => renderToString(
  <DupPartDialog
    groups={GROUPS}
    refOf={i => `new ${i + 1}`}
    busy={false}
    confirmTone="accent"
    confirmLabel="Submit anyway"
    onClose={() => undefined}
    onConfirm={() => undefined}
    onOpenLine={onOpenLine}
  />,
);

const count = (html: string, s: string) => html.split(s).length - 1;

describe('duplicate-part dialog', () => {
  it('offers to open each repeated part\'s first product when the page can open one', () => {
    const html = render(() => undefined);
    expect(count(html, 'dupPartOpenLine')).toBe(GROUPS.length);
    expect(html).toContain('dupPartReview');
    expect(html).toContain('Submit anyway');
  });

  it('shows only Review and the confirm button when it cannot', () => {
    const html = render();
    expect(html).not.toContain('dupPartOpenLine');
    expect(html).toContain('dupPartReview');
    expect(html).toContain('Submit anyway');
  });
});
