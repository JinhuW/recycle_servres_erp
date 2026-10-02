import type { RefObject } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { useScrollEdges } from '../lib/useScrollEdges';

type Props = {
  scrollRef: RefObject<HTMLElement | null>;
  /** One element that stays mounted around the content, so growth is seen. */
  contentRef: RefObject<HTMLElement | null>;
};

// One button rather than an up/down pair: a pair whose spent half disappears
// slides the other under the thumb, and a second tap on "bottom" lands on
// "top". Positioned by `.ph-scroll-jump` above whichever dock it sits in.
export function PhScrollJump({ scrollRef, contentRef }: Props) {
  const { t } = useT();
  const { atTop, atBottom } = useScrollEdges(scrollRef, contentRef);
  if (atTop && atBottom) return null;
  const label = atBottom ? t('scrollToTop') : t('scrollToBottom');
  return (
    <button
      type="button"
      className="ph-icon-btn ph-scroll-jump"
      aria-label={label}
      title={label}
      onClick={() => {
        const el = scrollRef.current;
        el?.scrollTo({ top: atBottom ? 0 : el.scrollHeight, behavior: 'smooth' });
      }}
    >
      <Icon name={atBottom ? 'chevronUp' : 'chevronDown'} size={16} />
    </button>
  );
}
