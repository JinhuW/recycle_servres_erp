import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { STATUS_CHIP, fmtEta } from '../../lib/shippingList';
import type { OrderPackage } from '../../lib/types';
import type { PackageStatus } from '../../lib/packages';
import { StepTimeline } from './StepTimeline';

// Where the hand-off's box stands, on the PO page while the order is In
// Transit. The carrier's updates land on the package by webhook and poll
// (shipping/track.ts); the PO itself stays In Transit until a person receives
// it, so this is the only place the page says the box is already here.

type Props = { pkg: OrderPackage };

// Tracking added → in transit → delivered. An exception is a badge state, not
// a step on the way.
const STEP_POS: Record<PackageStatus, number> = {
  purchased: 0, in_transit: 1, delivered: 2, exception: 1,
};

export function PackageJourney({ pkg }: Props) {
  const { t, locale } = useT();
  const pos = STEP_POS[pkg.status];
  const eta = fmtEta(pkg.trackingEta, locale);
  const exception = pkg.status === 'exception';
  const chip = STATUS_CHIP[pkg.status];

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={'chip dot ' + chip.cls} style={{ fontSize: 11 }}>{t(chip.key)}</span>
        <span className="mono" style={{ fontSize: 12.5 }}>{pkg.carrier} · {pkg.trackingNumber}</span>
      </div>

      <StepTimeline
        pos={pos}
        nowGlyph={exception ? '!' : '●'}
        steps={[
          { key: 'purchased', label: t('pkgStepAdded') },
          { key: 'in_transit', label: t('shipStatusInTransit') },
          { key: 'delivered', label: t('shipStatusDelivered') },
        ]}
      />

      {exception && pkg.trackingStatus && (
        <div className="ship-exception-note">
          {t('shipExceptionNote', { status: pkg.trackingStatus })}
        </div>
      )}

      <div className="ship-meta">
        {eta && pkg.status !== 'delivered' && (
          <span>
            <span className="ship-eta-label">{t('shipEta')}</span>
            <span className="ship-eta-value">{eta}</span>
          </span>
        )}
        {pkg.trackingUrl && (
          <a href={pkg.trackingUrl} target="_blank" rel="noopener noreferrer">
            {t('shipTrackOnCarrier', { carrier: pkg.carrier })} ↗
          </a>
        )}
        <span style={{ color: 'var(--fg-subtle)' }}>
          {pkg.lastTrackedAt
            ? t('shipLastUpdate', { when: relTime(pkg.lastTrackedAt, locale) })
            : t('shipNoUpdateYet')}
        </span>
      </div>
    </div>
  );
}
