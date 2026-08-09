import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { fmtUSD } from '../lib/format';
import { staleness } from '../lib/marketStaleness';
import type { MarketState, ResolvedMarketValue } from '../lib/useMarketLookup';

// What the recorded market says about the part being captured, shown while the
// buy decision can still change.
//
// The purchaser is standing in front of a pallet deciding what to pay. Until
// now the sell price only appeared after the PO was saved, so "is $20.60 a good
// price for this?" was a question the screen didn't answer. maxBuy already
// exists — lib/market.ts derives it as basis × (1 − target margin) — it just
// never reached this screen.
//
// A part with no recorded value renders nothing: an empty panel is worse than
// silence. Being in flight or having failed is NOT that, and each says its own
// line — a purchaser who reads "no price on record" off a request that never
// arrived pays whatever they were going to pay anyway.

export function MarketAssist({
  market,
  state,
  onRetry,
  unitCost,
  onUseMaxBuy,
  onUseSellPrice,
  locale,
  disabled,
}: {
  /** The recorded value, or null when the part has none. */
  market: ResolvedMarketValue | null;
  /**
   * The request behind that value. Without it the panel can only tell priced
   * from unpriced, which is what made a failed lookup look like a part nobody
   * has ever sold.
   */
  state?: MarketState;
  onRetry?: () => void;
  unitCost: number;
  onUseMaxBuy: (v: number) => void;
  onUseSellPrice: (v: number) => void;
  locale: string;
  disabled?: boolean;
}) {
  const { t } = useT();

  // The skeleton holds the panel's height from the first keystroke, so the
  // cost fields the user's hand is on don't jump when the answer lands ~300ms
  // after they stop typing.
  if (state?.status === 'loading') {
    return (
      <div className="mkt-assist mkt-thin" aria-busy="true">
        <span className="mkt-skeleton" />
      </div>
    );
  }
  if (state?.status === 'error') {
    return (
      <div className="mkt-assist mkt-thin" role="status">
        <Icon name="alert" size={12} />
        <span>{t('mktUnreachable')}</span>
        {onRetry && (
          <button type="button" className="btn sm" onClick={onRetry}>{t('mktRetry')}</button>
        )}
      </div>
    );
  }
  // Over the per-request cap: this part was never asked about, which is not the
  // same as having no price.
  if (state?.status === 'skipped') {
    return (
      <div className="mkt-assist mkt-thin" role="status">
        <Icon name="alert" size={12} />
        <span>{t('mktTooManyParts')}</span>
      </div>
    );
  }

  if (!market) return null;

  // A row can exist with no recorded price at all — the part has been seen but
  // never priced. The team's own recent sell prices (internal_sales, a 30-day
  // aggregate of order_lines.sell_price) are then the best number available,
  // and better than showing an empty panel.
  const internal = market.internalSales.samples > 0 ? market.internalSales.avgPrice : null;
  const suggestedSell = market.lastPrice ?? market.avgSell ?? internal;
  // Same shape the server derives maxBuy with (basis × (1 − target margin)),
  // applied to the internal basis when there is no recorded one — otherwise a
  // suggested sell would appear with no ceiling beside it. The margin comes off
  // the same lookup response the server priced its own maxBuy with, so the two
  // ceilings can't disagree on a workspace that isn't on the default.
  const maxBuy = market.maxBuy
    ?? (internal != null ? +(internal * (1 - market.targetMargin)).toFixed(2) : null);

  const { days, isStale } = staleness(market.lastPriceAt);
  const overMaxBuy = maxBuy != null && unitCost > maxBuy;
  // Which figure maxBuy was derived from — a last recorded sale carries more
  // weight than a rolling average, and the user should know which they're
  // trusting.
  const basisKey = market.lastPrice != null ? 'mktBasisLast'
    : market.avgSell != null ? 'mktBasisAvg'
    : 'mktBasisInternal';

  // Nothing to offer and nothing to warn about: say nothing. A panel of
  // em-dashes is noise the purchaser reads past on every single line.
  if (maxBuy == null && suggestedSell == null) return null;

  return (
    <div className="mkt-assist">
      <div className="mkt-head">
        <Icon name="tag" size={12} />
        <span>{t('mktRecorded')}</span>
        <span className={'mkt-age' + (isStale ? ' stale' : '')}>
          {days == null ? t('mktNeverPriced') : t('mktRecordedDaysAgo', { n: days })}
        </span>
      </div>

      <div className="mkt-figs">
        {maxBuy != null && (
          <div className="mkt-fig">
            <div className="mkt-k">{t('mktMaxBuy')}</div>
            <div className="mkt-v mono">{fmtUSD(maxBuy, locale)}</div>
            <button type="button" className="btn sm" disabled={disabled} onClick={() => onUseMaxBuy(maxBuy)}>
              {t('mktUse')}
            </button>
          </div>
        )}
        {suggestedSell != null && (
          <div className="mkt-fig">
            <div className="mkt-k">{t('mktSuggestedSell')}</div>
            <div className="mkt-v mono">{fmtUSD(suggestedSell, locale)}</div>
            <button type="button" className="btn sm" disabled={disabled} onClick={() => onUseSellPrice(suggestedSell)}>
              {t('mktUse')}
            </button>
          </div>
        )}
      </div>

      <div className="mkt-foot">
        {t(basisKey)}
        {market.internalSales.samples > 0 && market.internalSales.avgPrice != null && (
          <> · {t('mktInternal', { price: fmtUSD(market.internalSales.avgPrice, locale), n: market.internalSales.samples })}</>
        )}
      </div>

      {overMaxBuy && (
        <div className="mkt-warn" role="status">
          <Icon name="alert" size={12} />
          {t('mktOverMaxBuy', { max: fmtUSD(maxBuy!, locale) })}
        </div>
      )}
    </div>
  );
}
