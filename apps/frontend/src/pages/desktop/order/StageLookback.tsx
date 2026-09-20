import { Icon } from '../../../components/Icon';
import { fmtDate, fmtUSD } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { lookbackFacts, type StageId } from '../../../lib/orderLookback';
import { LIFECYCLE_LABEL } from '../../../lib/orderPresentation';
import type { OrderEvent, OrderPackage } from '../../../lib/types';
import { PackageJourney } from '../PackageJourney';

// What a finished stage recorded, shown in the status section when a reached
// step is clicked. Read-only — the audit log is the source — with the way
// back, and the manager's move back to that stage when the order allows it.

type Props = {
  stage: string;
  stageId: StageId;
  currentStage: string;
  events: OrderEvent[];
  eventsLoaded: boolean;
  pkg: OrderPackage | null | undefined;
  onBack: () => void;
  /** The manager's backward move, when this stage may be returned to. */
  moveBack: (() => void) | null;
  locale: string;
};

export function StageLookback(p: Props) {
  const { t } = useT();
  const facts = lookbackFacts(p.stageId, p.events);
  const who = (name: string | null) => name ?? t('eoSomeone');
  return (
    <div className="oe-stage">
      <div className="oe-box oe-lookback">
        <div className="oe-box-h">
          <span><Icon name="clock" size={12} /> {t('eoLookbackTitle', { s: p.stage })}</span>
          <span className="r">
            {p.moveBack && (
              <button type="button" className="btn sm" onClick={p.moveBack}>{t('eoMoveBackTo', { s: p.stage })}</button>
            )}
            <button type="button" className="btn sm primary" onClick={p.onBack}>
              {t('eoBackToCurrent', { s: p.currentStage })} <Icon name="chevronRight" size={12} />
            </button>
          </span>
        </div>
        {!p.eventsLoaded ? null : facts.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>{t('eoLookbackNone')}</div>
        ) : (
          <ul className="oe-facts">
            {facts.map((f, i) => {
              switch (f.kind) {
                case 'submitted':
                  return (
                    <li key={i}>
                      <b>{t('eoLookbackSubmitted', { who: who(f.who), when: fmtDate(f.when, p.locale) })}</b>
                      <span className="muted"> · {t('subUnitsCost', { n: f.qty, cost: fmtUSD(f.totalCost, p.locale) })}</span>
                    </li>
                  );
                case 'handoffPickup':
                  return <li key={i}>{t('acHandoffPickup')}<span className="muted"> · {f.byName ?? '—'}</span></li>;
                case 'handoffLabel':
                  return <li key={i}>{t('acHandoffLabel')}<span className="mono muted"> · {[f.carrier, f.trackingNumber].filter(Boolean).join(' ')}</span></li>;
                case 'advanced':
                  // The move to Sold is the system's, not anyone's.
                  return (
                    <li key={i}>
                      {f.to === 'sold'
                        ? t('eoLookbackSoldOut', { when: fmtDate(f.when, p.locale) })
                        : t('eoLookbackAdvanced', {
                          who: who(f.who), when: fmtDate(f.when, p.locale),
                          to: LIFECYCLE_LABEL[f.to] ?? f.to,
                        })}
                    </li>
                  );
                case 'doneNote':
                  return <li key={i} style={{ whiteSpace: 'pre-wrap' }}>{f.note}</li>;
                case 'doneFile':
                  return <li key={i}><Icon name="paperclip" size={11} /> {f.filename}</li>;
              }
            })}
          </ul>
        )}
        {p.stageId === 'in_transit' && p.pkg && (
          <div style={{ marginTop: 6 }}><PackageJourney pkg={p.pkg} /></div>
        )}
      </div>
    </div>
  );
}
