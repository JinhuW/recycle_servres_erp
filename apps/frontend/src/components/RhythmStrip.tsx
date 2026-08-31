// A client's purchase history as marks on a year, with the run of silence
// since the last one drawn as a bar.
//
// The point is that the *gap* is the thing you look at. A purchaser never has
// to know the rule is "past twice the median interval" — they see a bar that
// got too long, next to a bracket showing what normal looks like for that
// client. It is the one piece of data that earns its width on a table row.

type Props = {
  /** Days-ago for each purchase order, any order. */
  poDaysAgo: number[];
  /** Their own median interval, already clamped by the server. */
  gapDays: number | null;
  health: 'new' | 'ok' | 'quiet' | 'lost';
  /** The wide variant adds the reference bracket and a caption. */
  size?: 'row' | 'detail';
  label?: string;
};

const YEAR = 365;

export function RhythmStrip({ poDaysAgo, gapDays, health, size = 'row', label }: Props) {
  const big = size === 'detail';
  const cls = `rhythm rhythm-${size}`;
  if (!poDaysAgo.length) {
    return (
      <div className={cls} role="img" aria-label={label ?? 'No purchase orders yet'}>
        <i className="rhythm-base" />
        <i className="rhythm-now" />
        <span className="rhythm-none">no orders yet</span>
      </div>
    );
  }
  const last = Math.min(...poDaysAgo);
  // Left edge is a year ago, right edge is today.
  const x = (d: number) => (1 - Math.min(d, YEAR) / YEAR) * 100;
  const tone = health === 'lost' ? 'lost' : health === 'quiet' ? 'quiet' : 'ok';

  return (
    <div className={cls} role="img" aria-label={label ?? ariaFor(poDaysAgo.length, last, gapDays)}>
      <i className="rhythm-base" />
      {poDaysAgo.map((d, i) => (
        <i key={`${d}-${i}`} className="rhythm-po" style={{ left: `${x(d).toFixed(2)}%` }} />
      ))}
      <i className={`rhythm-gap rhythm-gap-${tone}`} style={{ left: `${x(last).toFixed(2)}%` }} />
      {big && gapDays ? (
        <i
          className="rhythm-typical"
          style={{ left: `${x(last).toFixed(2)}%`, width: `${((gapDays / YEAR) * 100).toFixed(2)}%` }}
        />
      ) : null}
      <i className="rhythm-now" />
    </div>
  );
}

function ariaFor(count: number, last: number, gap: number | null): string {
  const rhythm = gap ? `, usually every ${gap} days` : '';
  return `${count} purchase order${count === 1 ? '' : 's'}, last one ${last} days ago${rhythm}`;
}
