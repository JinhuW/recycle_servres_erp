import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { addDays, addMonths, type Bucket, type IsoDate } from '@recycle-erp/shared';
import { useT } from '../../lib/i18n';
import { fmtUSD0 } from '../../lib/format';
import { useElementWidth } from '../../lib/useElementWidth';

// Sales in above the baseline, spend out below it, and the gross profit on
// what sold as a line — one dollar axis, so the three read against each other.

export type SeriesPoint = { start: IsoDate; revenue: number; cost: number; profit: number };

const H = 260;
const PAD = { l: 58, r: 12, t: 12, b: 26 };

const utc = (d: IsoDate) => new Date(d + 'T00:00:00Z');

function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const f = rough / pow;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * pow;
}

function bucketEnd(start: IsoDate, bucket: Bucket): IsoDate {
  return bucket === 'day' ? start : bucket === 'week' ? addDays(start, 6) : addDays(addMonths(start, 1), -1);
}

// A bar that is rounded on its data end and square on the baseline.
function barPath(x: number, y0: number, y1: number, w: number, roundTop: boolean): string {
  const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const r = Math.min(4, w / 2, (bottom - top) / 2);
  if (r <= 0) return '';
  if (roundTop) {
    return `M${x},${bottom} V${top + r} a${r},${r} 0 0 1 ${r},-${r} H${x + w - r} a${r},${r} 0 0 1 ${r},${r} V${bottom} Z`;
  }
  return `M${x},${top} V${bottom - r} a${r},${r} 0 0 0 ${r},${r} H${x + w - r} a${r},${r} 0 0 0 ${r},-${r} V${top} Z`;
}

export function CashflowChart({ series, bucket, from, to, locale }: {
  series: SeriesPoint[]; bucket: Bucket; from: IsoDate; to: IsoDate; locale: string;
}) {
  const { t } = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrap);
  const [hover, setHover] = useState<number | null>(null);

  const n = series.length;
  const innerW = Math.max(0, width - PAD.l - PAD.r);
  const innerH = H - PAD.t - PAD.b;

  const { yMin, yMax, ticks } = useMemo(() => {
    const up = Math.max(0, ...series.map(s => Math.max(s.revenue, s.profit)));
    const down = Math.max(0, ...series.map(s => Math.max(s.cost, -s.profit)));
    const step = niceStep((up + down) / 4 || 1);
    const yMax = Math.max(step, Math.ceil(up / step) * step);
    const yMin = -Math.ceil(down / step) * step;
    const ticks: number[] = [];
    // `-0` would print as "-$0"; a tick that close to zero is zero.
    for (let v = yMin; v <= yMax + 1e-9; v += step) ticks.push(Math.abs(v) < 1e-9 ? 0 : v);
    return { yMin, yMax, ticks };
  }, [series]);

  const y = (v: number) => PAD.t + ((yMax - v) / (yMax - yMin)) * innerH;
  const slot = n ? innerW / n : 0;
  const cx = (i: number) => PAD.l + slot * (i + 0.5);
  const bw = Math.min(24, slot * 0.6);

  const compact = useMemo(() => new Intl.NumberFormat(locale, {
    notation: 'compact', style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 1,
  }), [locale]);
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }), [locale]);
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }), [locale]);
  const xLabel = (s: SeriesPoint, i: number) => {
    if (bucket !== 'month') return dayFmt.format(utc(s.start));
    const isJan = s.start.slice(5, 7) === '01';
    return isJan || i === 0 ? `${monthFmt.format(utc(s.start))} ${s.start.slice(0, 4)}` : monthFmt.format(utc(s.start));
  };
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  const idxAt = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const i = Math.floor((clientX - rect.left - PAD.l) / slot);
    return Math.max(0, Math.min(n - 1, i));
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => { if (n) setHover(idxAt(e.clientX)); };
  const onKey = (e: KeyboardEvent<SVGRectElement>) => {
    if (!n) return;
    if (e.key === 'ArrowLeft') { setHover(h => Math.max(0, (h ?? n) - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setHover(h => Math.min(n - 1, (h ?? -1) + 1)); e.preventDefault(); }
    else if (e.key === 'Escape') setHover(null);
  };

  // Nothing in the window: say so rather than draw a flat line against a
  // made-up "$1" axis.
  if (n === 0 || series.every(s => s.revenue === 0 && s.cost === 0 && s.profit === 0)) {
    return <div className="dash-chart-empty">{t('dashNoDataYet')}</div>;
  }

  const linePath = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${cx(i)},${y(s.profit)}`).join(' ');
  const h = hover;
  const hp = h == null ? null : series[h];
  const tipLeft = h == null ? 0 : (cx(h) + 160 > width ? cx(h) - 172 : cx(h) + 12);
  const spanLabel = (s: SeriesPoint) => {
    const a = s.start < from ? from : s.start;
    const bEnd = bucketEnd(s.start, bucket);
    const b = bEnd > to ? to : bEnd;
    return a === b ? dayFmt.format(utc(a)) : `${dayFmt.format(utc(a))} – ${dayFmt.format(utc(b))}`;
  };

  return (
    <div className="dash-chart" ref={wrap}>
      <div className="dash-chart-legend" aria-hidden="true">
        <span><i style={{ background: 'var(--info)' }} />{t('revenue')}</span>
        <span><i style={{ background: 'var(--chart-out)' }} />{t('cost')}</span>
        <span><i className="is-line" style={{ background: 'var(--accent)' }} />{t('profit')}</span>
      </div>
      <svg viewBox={`0 0 ${Math.max(1, width)} ${H}`} width={Math.max(1, width)} height={H} role="img"
           aria-label={`${t('chartCashflow')}: ${t('revenue')}, ${t('cost')}, ${t('profit')}`}>
        {ticks.map(v => (
          <g key={v}>
            <line className={v === 0 ? 'dash-chart-zero' : 'dash-chart-grid'}
                  x1={PAD.l} x2={PAD.l + innerW} y1={y(v)} y2={y(v)} />
            <text className="dash-chart-tick" x={PAD.l - 8} y={y(v) + 3.5} textAnchor="end">{compact.format(v)}</text>
          </g>
        ))}
        {series.map((s, i) => (
          <g key={s.start} className={'dash-chart-bar' + (h === i ? ' is-hover' : '')}>
            {s.revenue > 0 && (
              <path className="dash-chart-in" d={barPath(cx(i) - bw / 2, y(s.revenue), y(0) - 1, bw, true)} />
            )}
            {s.cost > 0 && (
              <path className="dash-chart-out" d={barPath(cx(i) - bw / 2, y(0) + 1, y(-s.cost), bw, false)} />
            )}
          </g>
        ))}
        <path className="dash-chart-line" d={linePath} />
        {series.map((s, i) => (n <= 16 || h === i) ? (
          <circle key={s.start} className="dash-chart-dot" cx={cx(i)} cy={y(s.profit)} r={4} />
        ) : null)}
        {series.map((s, i) => (i % labelEvery === 0 || i === n - 1) && (i % labelEvery === 0 || n - 1 - i >= labelEvery / 2) ? (
          <text key={s.start} className="dash-chart-xlabel" x={cx(i)} y={H - 8} textAnchor="middle">{xLabel(s, i)}</text>
        ) : null)}
        {h != null && (
          <line className="dash-chart-crosshair" x1={cx(h)} x2={cx(h)} y1={PAD.t} y2={PAD.t + innerH} />
        )}
        <rect
          className="dash-chart-hit" tabIndex={0}
          x={PAD.l} y={PAD.t} width={innerW} height={innerH}
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}
          onFocus={() => setHover(n - 1)} onBlur={() => setHover(null)} onKeyDown={onKey}
        />
      </svg>
      {hp && (
        <div className="dash-chart-tip" style={{ left: tipLeft }} role="status">
          <div className="dash-chart-tip-title">{spanLabel(hp)}</div>
          <div className="dash-chart-tip-row"><i style={{ background: 'var(--info)' }} /><b>{fmtUSD0(hp.revenue, locale)}</b><span>{t('revenue')}</span></div>
          <div className="dash-chart-tip-row"><i style={{ background: 'var(--chart-out)' }} /><b>{fmtUSD0(hp.cost, locale)}</b><span>{t('cost')}</span></div>
          <div className="dash-chart-tip-row"><i style={{ background: 'var(--accent)' }} /><b>{fmtUSD0(hp.profit, locale)}</b><span>{t('profit')}</span></div>
        </div>
      )}
    </div>
  );
}
