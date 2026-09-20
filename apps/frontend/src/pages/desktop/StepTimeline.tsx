// The step rail under a shipment or a tracked package: ticks up to the
// current step, a marker on it, the last step ticked only once reached. One
// rendering for the prepaid-label panel and the PO page's package journey, so
// a glyph or styling change lands on both.

type Step = { key: string; label: string };

type Props = {
  steps: Step[];
  /** 0-based index of the step the box is on. */
  pos: number;
  /** Marker for the current step — '!' when the carrier reports an exception. */
  nowGlyph?: string;
};

export function StepTimeline({ steps, pos, nowGlyph = '●' }: Props) {
  const last = steps.length - 1;
  const state = (i: number): '' | 'done' | 'now' =>
    i < pos || (i === pos && i === last) ? 'done' : i === pos ? 'now' : '';
  return (
    <div>
      <div className="ship-timeline">
        {steps.map((s, i) => (
          <div key={s.key} className={'ship-tl-seg' + (i === last ? ' last' : '')}>
            <div className={'ship-tl-node' + (state(i) ? ' ' + state(i) : '')}>
              {state(i) === 'done' ? '✓' : state(i) === 'now' ? nowGlyph : ''}
            </div>
            {i < last && <div className={'ship-tl-bar' + (i < pos ? ' done' : '')} />}
          </div>
        ))}
      </div>
      <div className="ship-tl-labels">
        {steps.map((s, i) => (
          <span key={s.key} className={i === pos ? state(i) : ''}>{s.label}</span>
        ))}
      </div>
    </div>
  );
}
