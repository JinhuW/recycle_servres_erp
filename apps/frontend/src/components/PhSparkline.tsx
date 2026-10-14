// Lifted from phone-app.jsx — area sparkline with a dot on the latest point.
import { useId } from 'react';
import { sparkGeometry } from '../lib/sparkline';

type Props = { data: { label: string; profit: number }[] };

export function PhSparkline({ data }: Props) {
  // One gradient per instance: a fixed id collided between two sparklines on
  // one page and the second one painted with the first one's fill.
  const gradientId = useId();
  if (data.length === 0) return <svg className="ph-spark" viewBox="0 0 360 110" />;
  const w = 360, h = 110;
  const pad = { l: 6, r: 6, t: 8, b: 18 };
  const innerW = w - pad.l - pad.r, innerH = h - pad.t - pad.b;
  const x = (i: number) => pad.l + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const { y, baseline, crossesZero } = sparkGeometry(data.map(d => d.profit), pad.t, innerH);

  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.profit)}`).join(' ');
  const areaPath = linePath + ` L ${x(data.length - 1)} ${baseline} L ${x(0)} ${baseline} Z`;
  const last = data.length - 1;

  return (
    <svg className="ph-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"    />
        </linearGradient>
      </defs>
      {crossesZero && (
        <line x1={pad.l} x2={w - pad.r} y1={baseline} y2={baseline} stroke="var(--border)" strokeDasharray="2 4" />
      )}
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
      <circle cx={x(last)} cy={y(data[last].profit)} r={3.5} fill="white" stroke="var(--accent)" strokeWidth={2} />
      {data.map((d, i) => (i === 0 || i === last || i === Math.floor(data.length / 2)) ? (
        <text key={'l' + i} x={x(i)} y={h - 4} fill="var(--fg-subtle)" fontSize={9} textAnchor="middle">{d.label}</text>
      ) : null)}
    </svg>
  );
}
