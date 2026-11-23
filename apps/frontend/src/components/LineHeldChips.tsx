import type { CSSProperties } from 'react';
import { Icon } from './Icon';
import { splitLineHolders } from '../lib/ebay';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Why a held PO line is view-only, naming every holder. */
export function lineHeldTitle(t: T, holders: readonly string[]): string {
  const { sellOrders, ebay } = splitLineHolders(holders);
  return [
    sellOrders.length > 0 && t('lineShippedReadOnly', { so: sellOrders.join(', ') }),
    ebay.length > 0 && t('lineOnEbayReadOnly', { eb: ebay.join(', ') }),
  ].filter(Boolean).join(' ');
}

// A line held by a shipped sell order reads "Shipped"; one an eBay listing
// holds isn't shipped anywhere, so it says where it is instead.
export function LineHeldChips({ holders, t, style }: { holders: readonly string[]; t: T; style?: CSSProperties }) {
  const { sellOrders, ebay } = splitLineHolders(holders);
  return (
    <>
      {sellOrders.length > 0 && (
        <span className="chip info" style={style} title={t('lineShippedReadOnly', { so: sellOrders.join(', ') })}>
          <Icon name="lock" size={10} /> {t('lineShippedChip', { so: sellOrders.join(', ') })}
        </span>
      )}
      {ebay.length > 0 && (
        <span className="chip warn" style={style} title={t('lineOnEbayReadOnly', { eb: ebay.join(', ') })}>
          <Icon name="lock" size={10} /> {t('lineOnEbayChip', { eb: ebay.join(', ') })}
        </span>
      )}
    </>
  );
}
