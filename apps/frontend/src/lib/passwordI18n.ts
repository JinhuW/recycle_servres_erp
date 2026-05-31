// Maps the PasswordMeter's strength keys to their localized labels via the
// existing useT() translator. Kept tiny + separate so any caller that already
// has `t` in scope can pass a label map without re-implementing the lookup.

import type { PwStrengthKey } from '../components/PasswordMeter';

type TFn = (key: string) => string;

export function pwStrengthLabels(t: TFn): Record<PwStrengthKey, string> {
  return {
    tooShort:  t('pwStrengthTooShort'),
    weak:      t('pwStrengthWeak'),
    fair:      t('pwStrengthFair'),
    strong:    t('pwStrengthStrong'),
    excellent: t('pwStrengthExcellent'),
  };
}
