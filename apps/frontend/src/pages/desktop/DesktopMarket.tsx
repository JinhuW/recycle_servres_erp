import { Fragment, useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { fmtUSD, fmtUSD0, relTime } from '../../lib/format';
import { priceSources, categoryFilterOptions } from '../../lib/lookups';
import type { RefPrice } from '../../lib/types';
import { TableSkeleton } from '../../components/Skeleton';

// ─── Sparkline ───────────────────────────────────────────────────────────────
function Sparkline({
  values, color = 'var(--accent)', width = 100, height = 28,
}: { values: number[]; color?: string; width?: number; height?: number }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pad = 3;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)}`).join(' ');
  const area = path + ` L ${x(values.length - 1)} ${height - pad} L ${x(0)} ${height - pad} Z`;
  const lastIdx = values.length - 1;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={area} fill={color} fillOpacity="0.12" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(lastIdx)} cy={y(values[lastIdx])} r={2.4} fill="white" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function TrendBadge({ value }: { value: number }) {
  if (Math.abs(value) < 0.005) {
    return (
      <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <Icon name="minus" size={11} /> Flat
      </span>
    );
  }
  const up = value > 0;
  const color = up ? 'var(--pos)' : 'var(--neg)';
  return (
    <span style={{ fontSize: 11.5, color, display: 'inline-flex', alignItems: 'center', gap: 3, fontWeight: 500 }}>
      <Icon name={up ? 'arrowUp' : 'arrowDown'} size={11} />
      {(up ? '+' : '−')}{Math.abs(value * 100).toFixed(1)}%
    </span>
  );
}

function DemandPill({ level }: { level: 'high' | 'medium' | 'low' }) {
  const map: Record<string, { label: string; cls: string; icon: IconName }> = {
    high:   { label: 'High demand', cls: 'pos',  icon: 'zap' },
    medium: { label: 'Steady',      cls: 'info', icon: 'minus' },
    low:    { label: 'Slow',        cls: 'warn', icon: 'clock' },
  };
  const m = map[level] || map.medium;
  return <span className={'chip ' + m.cls} style={{ fontSize: 10.5 }}><Icon name={m.icon} size={10} /> {m.label}</span>;
}

// ─── Main ────────────────────────────────────────────────────────────────────
// Fallback only — the live value comes from /api/market (workspace_settings).
const TARGET_MARGIN_FALLBACK = 0.30;

type Sort = 'recent' | 'sell-high' | 'rising' | 'falling' | 'samples';

export function DesktopMarket() {
  const { t } = useT();
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [items, setItems] = useState<RefPrice[]>([]);
  const [targetMargin, setTargetMargin] = useState(TARGET_MARGIN_FALLBACK);
  const [loadedOnce, setLoadedOnce] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('category', filter);
      if (search.trim()) params.set('q', search.trim());
      api.get<{ items: RefPrice[]; targetMargin?: number }>(`/api/market?${params}`)
        .then(r => {
          setItems(r.items);
          if (typeof r.targetMargin === 'number') setTargetMargin(r.targetMargin);
        })
        .catch(console.error)
        .finally(() => setLoadedOnce(true));
    }, 200);
    return () => clearTimeout(handle);
  }, [filter, search]);

  // Enrich with derived max buy (sell × (1 - target margin)).
  const allRows = useMemo(
    () => items.map(p => ({
      ...p,
      maxBuy: p.maxBuy || +(p.avgSell * (1 - targetMargin)).toFixed(2),
    })),
    [items, targetMargin],
  );

  const rows = useMemo(() => {
    const arr = [...allRows];
    if (sort === 'recent')    arr.sort((a, b) => +new Date(b.updated) - +new Date(a.updated));
    if (sort === 'sell-high') arr.sort((a, b) => b.avgSell - a.avgSell);
    if (sort === 'rising')    arr.sort((a, b) => b.trend - a.trend);
    if (sort === 'falling')   arr.sort((a, b) => a.trend - b.trend);
    if (sort === 'samples')   arr.sort((a, b) => b.samples - a.samples);
    return arr;
  }, [allRows, sort]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('marketValue')}</h1>
          <div className="page-sub">
            Latest <strong style={{ color: 'var(--accent-strong)' }}>sell prices</strong> our team is achieving — use them to decide what you can afford to pay. Stay below the recommended max buy and you'll hit our 30% margin target.
          </div>
        </div>
      </div>

      {/* How-to banner */}
      <div style={{
        display: 'flex', gap: 14, padding: '14px 16px',
        background: 'linear-gradient(135deg, var(--accent-soft), var(--bg-elev))',
        border: '1px solid color-mix(in oklch, var(--accent) 22%, var(--border))',
        borderRadius: 12,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: 'white', color: 'var(--accent-strong)',
          display: 'grid', placeItems: 'center', flexShrink: 0,
          border: '1px solid color-mix(in oklch, var(--accent) 30%, transparent)',
        }}>
          <Icon name="zap" size={18} />
        </div>
        <div style={{ flex: 1, fontSize: 13, lineHeight: 1.55 }}>
          <strong>How to use this page</strong>
          <div style={{ color: 'var(--fg-muted)', marginTop: 2 }}>
            For each part, look at the <strong style={{ color: 'var(--pos)' }}>avg sell price</strong> we're getting, then aim to <strong>buy under the green ceiling</strong>. Rising sell trends mean more buying headroom; falling trends mean tighter discipline. Always note the demand badge — slow-moving parts shouldn't be stocked deep.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="seg">
              {categoryFilterOptions().map(f => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f === 'all' ? t('all') : f}
                </button>
              ))}
            </div>
            <select
              className="select"
              style={{ width: 'auto', minWidth: 240, height: 32, fontSize: 12.5, paddingRight: 28 }}
              value={sort}
              onChange={e => setSort(e.target.value as Sort)}
            >
              <option value="recent">Sort: most recent</option>
              <option value="sell-high">Sort: sell price (high → low)</option>
              <option value="rising">Sort: sell rising fastest</option>
              <option value="falling">Sort: sell falling fastest</option>
              <option value="samples">Sort: most data points</option>
            </select>
          </div>
          <div style={{ position: 'relative' }}>
            <Icon name="search" size={13} style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--fg-subtle)',
            }} />
            <input
              className="input"
              placeholder={t('searchPart')}
              style={{ paddingLeft: 30, height: 32, fontSize: 12.5, width: 260 }}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="table-scroll">
          {!loadedOnce ? (
            <TableSkeleton rows={10} cols={7} />
          ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ minWidth: 240 }}>Item / Spec</th>
                <th>{t('partNumber')}</th>
                <th className="num" style={{ color: 'var(--pos)' }}>Avg sell price</th>
                <th>12-week sell trend</th>
                <th className="num" style={{ color: 'var(--accent-strong)' }}>Max buy (target)</th>
                <th className="num">Last paid</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 40).map(r => {
                const isOpen = openKey === r.id;
                const sellHistory = r.history.map(c => +(c * 1.35).toFixed(2));
                const trendColor = r.trend > 0.005 ? 'var(--pos)' : r.trend < -0.005 ? 'var(--neg)' : 'var(--fg-muted)';
                const onTarget = r.target <= r.maxBuy;
                return (
                  <Fragment key={r.id}>
                    <tr
                      className="row-hover"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setOpenKey(isOpen ? null : r.id)}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                            background: r.category === 'RAM' ? 'var(--info-soft)'
                                      : r.category === 'SSD' ? 'var(--pos-soft)'
                                      : r.category === 'HDD' ? 'oklch(0.96 0.04 295)'
                                      : 'var(--warn-soft)',
                            color: r.category === 'RAM' ? 'oklch(0.45 0.13 250)'
                                 : r.category === 'SSD' ? 'var(--accent-strong)'
                                 : r.category === 'HDD' ? 'oklch(0.45 0.16 295)'
                                 : 'oklch(0.45 0.13 75)',
                            display: 'grid', placeItems: 'center',
                          }}>
                            <Icon name={r.category === 'RAM' ? 'chip' : (r.category === 'SSD' || r.category === 'HDD') ? 'drive' : 'box'} size={15} />
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 500 }}>{r.label}</div>
                            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span>{r.sub}</span>
                              <DemandPill level={r.demand} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="mono muted" style={{ fontSize: 11 }}>{r.partNumber}</td>
                      <td className="num">
                        <div className="mono" style={{ fontWeight: 600, fontSize: 14, color: 'var(--pos)' }}>{fmtUSD(r.avgSell)}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>n = {r.samples}</div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Sparkline values={sellHistory} color={trendColor} />
                          <TrendBadge value={r.trend} />
                        </div>
                      </td>
                      <td className="num">
                        <div style={{
                          display: 'inline-flex', alignItems: 'baseline', gap: 4,
                          padding: '4px 8px', borderRadius: 6,
                          background: 'color-mix(in oklch, var(--accent) 8%, transparent)',
                          border: '1px dashed color-mix(in oklch, var(--accent) 35%, transparent)',
                        }}>
                          <span style={{ fontSize: 10, color: 'var(--accent-strong)', fontWeight: 600 }}>≤</span>
                          <span className="mono" style={{ fontWeight: 600, color: 'var(--accent-strong)' }}>{fmtUSD(r.maxBuy)}</span>
                        </div>
                      </td>
                      <td className="num">
                        <div className="mono" style={{ color: onTarget ? 'var(--fg)' : 'var(--neg)', fontWeight: 500 }}>
                          {fmtUSD(r.target)}
                        </div>
                        <div style={{ fontSize: 10.5, color: onTarget ? 'var(--pos)' : 'var(--neg)' }}>
                          {onTarget ? '✓ on target' : 'over ceiling'}
                        </div>
                      </td>
                      <td className="muted" style={{ fontSize: 11.5 }}>{relTime(r.updated)}</td>
                      <td>
                        <Icon
                          name={isOpen ? 'chevronDown' : 'chevronRight'}
                          size={14}
                          style={{ color: 'var(--fg-subtle)' }}
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr style={{ background: 'var(--bg-soft)' }}>
                        <td colSpan={8} style={{ padding: 18 }}>
                          <DetailExpand row={r} sellHistory={sellHistory} targetMargin={targetMargin} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 32, textAlign: 'center', color: 'var(--fg-subtle)' }}>
                    No matching prices.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          )}
        </div>

        <div style={{
          padding: '12px 18px', borderTop: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 12, color: 'var(--fg-subtle)',
        }}>
          <div>Showing {Math.min(40, rows.length)} of {rows.length} tracked SKUs</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="info" size={11} />
            Max buy = avg sell × (1 − {(targetMargin * 100).toFixed(0)}% target margin)
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Expanded row ────────────────────────────────────────────────────────────
function DetailExpand({
  row, sellHistory, targetMargin,
}: { row: RefPrice & { maxBuy: number }; sellHistory: number[]; targetMargin: number }) {
  const buyHistory = row.history;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 18 }}>
      <div className="card" style={{ padding: 16, background: 'var(--bg-elev)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
              Sell vs cost — 12 weeks
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
              The gap between the lines is your margin headroom.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 2, background: 'var(--pos)', display: 'inline-block' }} /> Sell
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 2, background: 'var(--fg-muted)', display: 'inline-block' }} /> Cost
            </span>
          </div>
        </div>
        <DualLineChart sell={sellHistory} cost={buyHistory} />
      </div>

      <div className="card" style={{ padding: 16, background: 'var(--bg-elev)' }}>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 12 }}>
          Your buying guide
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <GuideRow label="Avg sell price"        value={fmtUSD(row.avgSell)} tone="pos" emphasis />
          <GuideRow label="Recommended max buy"   value={fmtUSD(row.maxBuy)}  tone="accent" emphasis sub={`${(targetMargin * 100).toFixed(0)}% margin floor`} />
          <GuideRow label="Last paid (this team)" value={fmtUSD(row.target)}  sub={row.target <= row.maxBuy ? 'within target' : 'above ceiling — push back'} />
          <GuideRow label="Range seen"            value={`${fmtUSD0(row.low)} — ${fmtUSD0(row.high)}`} sub="Recent broker quotes" />
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <GuideRow
            label="Current stock"
            value={`${row.stock} units`}
            sub={row.stock > 30 ? 'well-stocked — go light' : row.stock < 8 ? 'low — replenish' : 'normal'}
          />
        </div>
      </div>

      <div className="card" style={{ padding: 16, background: 'var(--bg-elev)' }}>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 12 }}>
          Price sources
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {priceSources.map((s, i) => {
            const offset = (i - (priceSources.length - 1) / 2) * 0.04;
            const v = row.avgSell * (1 + offset);
            return (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                <span style={{ color: 'var(--fg-muted)' }}>{s.label}</span>
                <span className="mono" style={{ fontWeight: 500 }}>{fmtUSD(v)}</span>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--fg-subtle)' }}>
          Confidence:{' '}
          <strong style={{ color: row.samples > 20 ? 'var(--pos)' : row.samples > 10 ? 'var(--warn)' : 'var(--neg)' }}>
            {row.samples > 20 ? 'High' : row.samples > 10 ? 'Medium' : 'Low'}
          </strong>{' '}
          — based on {row.samples} data points across {priceSources.length} sources.
        </div>
      </div>
    </div>
  );
}

function GuideRow({
  label, value, tone, emphasis, sub,
}: { label: string; value: string; tone?: 'pos' | 'accent'; emphasis?: boolean; sub?: string }) {
  const color = tone === 'pos' ? 'var(--pos)' : tone === 'accent' ? 'var(--accent-strong)' : 'var(--fg)';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{label}</span>
        <span className="mono" style={{ fontSize: emphasis ? 16 : 13, fontWeight: emphasis ? 600 : 500, color }}>{value}</span>
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function DualLineChart({ sell, cost }: { sell: number[]; cost: number[] }) {
  const w = 460, h = 160, padL = 36, padR = 8, padT = 10, padB = 22;
  const all = [...sell, ...cost];
  const max = Math.max(...all);
  const min = Math.min(...all) * 0.85;
  const range = max - min || 1;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const x = (i: number) => padL + (i / (sell.length - 1)) * innerW;
  const y = (v: number) => padT + innerH - ((v - min) / range) * innerH;
  const path = (arr: number[]) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)}`).join(' ');
  const ticks = [min, min + range / 2, max];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 160 }}>
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={padL} x2={w - padR} y1={y(tv)} y2={y(tv)} stroke="var(--border)" strokeDasharray="2 4" />
          <text x={padL - 6} y={y(tv) + 3} fontSize={9} textAnchor="end" fill="var(--fg-subtle)">
            {'$' + Math.round(tv)}
          </text>
        </g>
      ))}
      <path d={path(cost)} fill="none" stroke="var(--fg-muted)" strokeWidth={1.5} strokeDasharray="3 3" />
      <path d={`${path(sell)} L ${x(sell.length - 1)} ${y(min)} L ${x(0)} ${y(min)} Z`} fill="var(--pos)" fillOpacity="0.08" />
      <path d={path(sell)} fill="none" stroke="var(--pos)" strokeWidth={2} />
      <circle cx={x(sell.length - 1)} cy={y(sell[sell.length - 1])} r={3.5} fill="white" stroke="var(--pos)" strokeWidth={2} />
      <circle cx={x(cost.length - 1)} cy={y(cost[cost.length - 1])} r={3}   fill="white" stroke="var(--fg-muted)" strokeWidth={1.5} />
      {[0, Math.floor(sell.length / 2), sell.length - 1].map(i => (
        <text key={i} x={x(i)} y={h - 6} fontSize={9} textAnchor="middle" fill="var(--fg-subtle)">W{i + 1}</text>
      ))}
    </svg>
  );
}
