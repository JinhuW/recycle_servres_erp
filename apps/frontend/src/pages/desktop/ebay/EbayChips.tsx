import { RouteLink } from '../../../components/RouteLink';
import type { EbayLink } from '../../../lib/api';
import { shortItemId } from '../../../lib/ebay';
import { useT } from '../../../lib/i18n';
import { ebayListingPath } from '../../../lib/route';
import '../../../styles/ebay.css';

const DOT: Record<EbayLink['status'], string> = { Queued: 'post', Listed: 'live', Sold: 'sold', Ended: 'ended' };

/**
 * A lot's eBay listings, one chip each. A live one opens the item on eBay; the
 * rest open the listing on the eBay desk. `links` is undefined where the
 * backend sent none (a purchaser's view), which draws nothing at all.
 */
export function EbayChips({ links }: { links: EbayLink[] | undefined }) {
  const { t } = useT();
  if (!links) return null;
  if (links.length === 0) return <span className="eb-none">{t('ebNotOnEbay')}</span>;
  return (
    <div className="eb-chips" onClick={e => e.stopPropagation()}>
      {links.map(l => {
        const text = [
          l.spec,
          l.status === 'Queued' ? t('ebChipToPost', { n: l.remaining })
            : l.status === 'Listed' ? t('ebChipLeft', { n: l.remaining })
            : t('ebChipSoldOut'),
          l.status === 'Listed' && l.ebayItemId ? t('ebChipItem', { item: shortItemId(l.ebayItemId) }) : null,
        ].filter(Boolean).join(', ');
        const body = (
          <>
            <span className={'eb-dot ' + DOT[l.status]} />
            <span className="mono">{l.listingNo}</span>
            <span>{text}</span>
          </>
        );
        return l.status === 'Listed' && l.ebayUrl
          ? <a key={l.listingId} className="eb-chip" href={l.ebayUrl} target="_blank" rel="noreferrer" title={t('ebChipOpensEbay')}>{body}</a>
          : <RouteLink key={l.listingId} to={ebayListingPath(l.listingNo)} className="eb-chip" title={t('ebChipOpensDesk')}>{body}</RouteLink>;
      })}
    </div>
  );
}
