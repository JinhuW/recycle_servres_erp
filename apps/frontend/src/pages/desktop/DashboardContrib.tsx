import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n';
import { fmtUSD0 } from '../../lib/format';
import type { ContribDim, ContribMetricData, ContribRows } from '../../lib/types';

// One "who contributed" card: the metric's total, a tab per dimension, and the
// top rows with their share of that total. The server already sorted and
// folded the tail, so this only draws.

const DIM_LABEL: Record<ContribDim, string> = {
  supplier: 'dimSupplier', purchaser: 'dimPurchaser', customer: 'dimCustomer', category: 'dimCategory',
};
const REMAINING: Record<ContribDim, string> = {
  supplier: 'contribRemainingSupplier', purchaser: 'contribRemainingPurchaser',
  customer: 'contribRemainingCustomer', category: 'contribRemainingCategory',
};

export function ContribCard({ title, caption, data, locale }: {
  title: string; caption: string; data: ContribMetricData; locale: string;
}) {
  const { t } = useT();
  const dims = Object.keys(data.byDim) as ContribDim[];
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
          <div className="card-title">{title}</div>
          <div className="dash-contrib-total mono">{fmtUSD0(total, locale)}</div>
        </div>
        <span className="card-sub">{caption}</span>
      </div>
      {dims.length > 1 && (
        <div className="dash-contrib-tabs">
          <div className="seg" role="tablist" style={{ gridTemplateColumns: `repeat(${dims.length}, 1fr)` }}>
            {dims.map(d => (
              <button key={d} role="tab" aria-selected={dim === d} className={dim === d ? 'active' : ''} onClick={() => setDim(d)}>
                {t(DIM_LABEL[d])}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="card-body" style={{ paddingTop: 4 }}>
        {!rows || rows.rows.length === 0 ? (
          <div className="dash-contrib-empty">{t('dashNoDataYet')}</div>
        ) : (
          <table className="dash-contrib-table">
            <thead>
              <tr>
                <th>{t(DIM_LABEL[dim])}</th>
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
              {rows.others && (
                <tr className="dash-contrib-others">
                  <td className="dash-contrib-name">{t(REMAINING[dim], { n: rows.others.n })}</td>
                  <td>
                    <div className="dash-contrib-bar">
                      <span className="dash-contrib-pct">{pctOf(rows.others.amount).toFixed(1)}%</span>
                      <span className="bar-track">
                        <span className="bar-fill" style={{ display: 'block', width: Math.max(0, Math.min(100, pctOf(rows.others.amount))) + '%', background: 'var(--border-strong)' }} />
                      </span>
                    </div>
                  </td>
                  <td className="num">{fmtUSD0(rows.others.amount, locale)}</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
