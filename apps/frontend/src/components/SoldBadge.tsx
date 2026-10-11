import { useT } from '../lib/i18n';
import { SOLD_LABEL, statusTone } from '../lib/status';

// Sold beside the stage pill: every line with units has sold. Not a stage, so
// it rides next to whichever one the PO is at. `sold` is only ever sent to
// managers, so a purchaser never sees this.
export function SoldBadge({ sold, style }: { sold?: boolean; style?: React.CSSProperties }) {
  const { t } = useT();
  if (!sold) return null;
  return <span className={'chip dot ' + statusTone(SOLD_LABEL)} style={style}>{t('soldBadge')}</span>;
}
