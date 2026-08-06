import type { ReactNode } from 'react';
import { useT } from '../lib/i18n';
import { fmtUSD } from '../lib/format';
import { catTone, type LineGroup } from '../lib/lineGroups';

// The PO's money, as a receipt.
//
// A purchaser reads this against a supplier invoice, so it is laid out the way
// an invoice is: one figure per line, stacked, dot leaders carrying the eye to
// a right-aligned column, rules where the arithmetic changes gear. The previous
// horizontal strip put goods, fees and cost side by side as peers, which
// misstates them — goods and fees ADD UP to cost.
//
// Two blocks, deliberately separated. Above the tear: what was paid. Below it:
// what it is projected to return, computed over the PRICED lines only, because
// an unpriced line isn't a loss — it's a line nobody has priced.

type Props = {
  /** Per-category goods subtotals. Rendered only when the PO spans categories. */
  groups: LineGroup<unknown>[];
  grouped: boolean;
  lineCount: number;
  units: number;
  goods: number;
  fees: number;
  total: number;
  /** Revenue and cost over priced lines only. */
  revenue: number;
  pricedCost: number;
  pricedProfit: number;
  pricedCount: number;
  /** Share of goods cost that has been priced, 0–100. */
  coveragePct: number;
  locale: string;
  /** Editable cells (goods override, fee amount, fee note) supplied by the page. */
  goodsField?: ReactNode;
  feeField?: ReactNode;
  feeNoteField?: ReactNode;
  goodsReset?: ReactNode;
};

function Row({
  label, value, cls = '', dot, children,
}: {
  label: ReactNode; value?: ReactNode; cls?: string; dot?: string; children?: ReactNode;
}) {
  return (
    <div className={'tape-row ' + cls} style={dot ? catTone(dot) : undefined}>
      <span className="tape-k">
        {dot && <span className="tape-dot" />}
        {label}
      </span>
      <span className="tape-lead" />
      {children ?? <span className="tape-v mono">{value}</span>}
    </div>
  );
}

export function CostTape({
  groups, grouped, lineCount, units, goods, fees, total,
  revenue, pricedCost, pricedProfit, pricedCount, coveragePct,
  locale, goodsField, feeField, feeNoteField, goodsReset,
}: Props) {
  const { t } = useT();
  const margin = revenue > 0 ? (pricedProfit / revenue) * 100 : 0;

  return (
    <div className="tape-wrap">
      <div className="tape">
        <div className="tape-cap">
          <span>{t('costBreakdown')}</span>
          <span className="tape-cap-r">
            {lineCount === 1 ? t('historyLineCountOne', { n: lineCount }) : t('historyLineCountMany', { n: lineCount })}
            {' · '}{t('grpUnits', { n: units.toLocaleString(locale) })}
          </span>
        </div>

        {/* Only worth itemising when there is more than one thing to itemise. */}
        {grouped && groups.map(g => (
          <Row
            key={g.category}
            dot={g.category}
            label={<>{g.category}<span className="muted"> ×{g.lines.length}</span></>}
            value={fmtUSD(g.goods, locale)}
          />
        ))}

        <Row
          cls="sum"
          label={<>{t('goodsTotal')}{goodsReset}</>}
        >
          {goodsField ?? <span className="tape-v mono">{fmtUSD(goods, locale)}</span>}
        </Row>

        <Row label={t('otherFees')}>
          <span className="tape-edit">
            {feeNoteField}
            {feeField ?? <span className="tape-v mono">{fmtUSD(fees, locale)}</span>}
          </span>
        </Row>

        <Row cls="total" label={t('eoCost')} value={fmtUSD(total, locale)} />

        <div className="tape-block">
          <div className="tape-block-cap">{t('projectedReturn')}</div>
          {pricedCount === 0 ? (
            <>
              <Row label={t('eoNoLinePricedShort')} value="—" />
              <div className="tape-foot">{t('eoNoLinePriced')}</div>
            </>
          ) : (
            <>
              <Row label={t('revenue')} value={fmtUSD(revenue, locale)} />
              <Row label={t('costOfPricedLines')} value={'−' + fmtUSD(pricedCost, locale)} />
              <Row
                cls="profit"
                label={t('eoProfitPriced')}
                value={<span className={pricedProfit >= 0 ? 'pos' : 'neg'}>{fmtUSD(pricedProfit, locale)}</span>}
              />
              <Row label={t('margin')} value={margin.toFixed(1) + '%'} />
              <div className="tape-foot">
                {t('eoPricedCoverage', { n: pricedCount, of: lineCount, pct: Math.round(coveragePct) })}
                {fees > 0 && <> {t('tapeFeesNote', { fees: fmtUSD(fees, locale) })}</>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
