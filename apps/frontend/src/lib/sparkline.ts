// The geometry behind the phone profit sparkline, kept pure so the one rule
// that matters — every point, loss or gain, lands inside the chart — has a
// test. The old scale ran from zero to the largest value: a loss period
// plotted below the baseline and off the canvas, and an all-loss range,
// clamped to a maximum of 1, plotted thousands of units under it.
export type SparkGeometry = {
  // y for a value, within [top, top + height].
  y: (v: number) => number;
  // Where zero sits; the area fill closes on it.
  baseline: number;
  // Negative values are present, so the baseline is worth drawing.
  crossesZero: boolean;
};

export function sparkGeometry(values: readonly number[], top: number, height: number): SparkGeometry {
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const span = hi - lo || 1;
  const y = (v: number) => top + height - ((v - lo) / span) * height;
  return { y, baseline: y(0), crossesZero: lo < 0 };
}
