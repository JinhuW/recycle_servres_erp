import type { ReactNode } from 'react';
import { Icon } from './Icon';

// A section of the phone's PO screens that folds: the desktop's tabs, one
// card each. The header is the section's title with its answer read back
// beside it, so closed it still says what it holds; open, the header tints
// and rules off, and the fields sit inside the same card — the edge says
// which fields belong to which section. The body stays mounted (hidden) so
// a readiness row can scroll to a field inside it.

export type PhFoldMark = 'need' | 'dirty' | null;

type Props = {
  id: string;
  title: string;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** Amber: the next step is waiting on this section. Blue: unsaved edits. */
  mark?: PhFoldMark;
  /** Extra class on the body — `ph-pay` keeps PaymentFields one column. */
  bodyClassName?: string;
  children: ReactNode;
};

export function PhFold({ id, title, summary, open, onToggle, mark = null, bodyClassName, children }: Props) {
  return (
    <section className="ph-fold" data-open={open} id={`ph-fold-${id}`}>
      <button
        type="button"
        className="ph-fold-h"
        aria-expanded={open}
        aria-controls={`ph-fold-${id}-body`}
        onClick={onToggle}
      >
        <span className={'ph-fold-mark' + (mark ? ' ' + mark : '')} aria-hidden="true" />
        <span className="ph-fold-title">{title}</span>
        <span className="ph-fold-sum">{summary}</span>
        <span className="ph-fold-chev"><Icon name="chevronDown" size={14} /></span>
      </button>
      <div id={`ph-fold-${id}-body`} className={'ph-fold-b' + (bodyClassName ? ' ' + bodyClassName : '')} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
