import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n';
import { fmtUSD0 } from '../../lib/format';
import type { ContribDim, ContribMetricData, ContribRows } from '../../lib/types';

// One "who contributed" card: the metric's total, a tab per dimension, and
// every row with its share of that total. The server already sorted them;
// past a fixed height the list scrolls inside the card, header pinned.

const DIM_LABEL: Record<ContribDim, string> = {
  supplier: 'dimSupplier', purchaser: 'dimPurchaser', customer: 'dimCustomer', category: 'dimCategory',
};

// `purchaserAs` renames the purchaser dimension. On the sale-side cards the
// grouping is the purchaser whose PO supplied the sold units — purchasers never
// create sell orders — so "Purchaser" there reads as the wrong claim.
// `note` says what the total sums — the cards next to each other use
// different rules (Cost counts every PO past Draft, the leaderboard only
// reviewed ones; a purchaser's sale cards are projections), so a figure
// without its definition invites the wrong comparison.
export function ContribCard({ title, note, caption, data, locale, purchaserAs }: {
  title: string; note: string; caption: string; data: ContribMetricData; locale: string;
  purchaserAs?: { dim: string };
}) {
  const { t } = useT();
  const dims = Object.keys(data.byDim) as ContribDim[];
  const dimLabel = (d: ContribDim) => t(d === 'purchaser' && purchaserAs ? purchaserAs.dim : DIM_LABEL[d]);
  const [dim, setDim] = useState<ContribDim>(dims[0]);
  // The lens can change under the card (role preview); fall back to what exists.
  useEffect(() => { if (!dims.includes(dim) && dims[0]) setDim(dims[0]); }, [dims, dim]);
  const rows: ContribRows | undefined = data.byDim[dim];
  const total = data.total;
  const pctOf = (amount: number) => total > 0 ? (amount / total) * 100 : 0;

  return (
    <div className="card dash-contrib">
      <div className="card-head">
        <div>
          <div className="card-title" title={note}>{title}</div>
          <div className="dash-contrib-note">{note}</div>
          <div className="dash-contrib-total mono">{fmtUSD0(total, locale)}</div>
        </div>
        <span className="card-sub">{caption}</span>
      </div>
      {dims.length > 1 && (
        <div className="dash-contrib-tabs">
          <div className="seg" role="tablist" style={{ gridTemplateColumns: `repeat(${dims.length}, 1fr)` }}>
            {dims.map(d => (
              <button key={d} role="tab" aria-selected={dim === d} className={dim === d ? 'active' : ''} onClick={() => setDim(d)}>
                {dimLabel(d)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="card-body" style={{ paddingTop: 4 }}>
        {!rows || rows.rows.length === 0 ? (
          <div className="dash-contrib-empty">{t('dashNoDataYet')}</div>
        ) : (
          <div className="dash-contrib-scroll">
          <table className="dash-contrib-table">
            <thead>
              <tr>
                <th>{dimLabel(dim)}</th>
                <th>{t('contribPctOfTotal')}</th>
                <th className="num">{t('contribAmount')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.rows.map((r, i) => {
                const name = r.name ?? (dim === 'supplier' ? t('contribNoSupplier') : '—');
                const pct = pctOf(r.amount);
                return (
                  <tr key={(r.id ?? 'null') + i}>
                    <td className="dash-contrib-name" title={name}>{name}</td>
                    <td>
                      <div className="dash-contrib-bar">
                        <span className="dash-contrib-pct">{pct.toFixed(1)}%</span>
                        <span className="bar-track">
                          <span className="bar-fill" style={{ display: 'block', width: Math.max(0, Math.min(100, pct)) + '%', background: 'var(--info)' }} />
                        </span>
                      </div>
                    </td>
                    <td className={'num' + (r.amount < 0 ? ' neg' : '')} style={r.amount < 0 ? { color: 'var(--neg)' } : undefined}>
                      {fmtUSD0(r.amount, locale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
