import { useEffect, useState } from 'react';
import { Icon } from '../../../components/Icon';
import {
  cookieHealth,
  poolTotp,
  type PoolAccount,
  type PoolStatus,
} from '../../../lib/facebookPool';
import { useT } from '../../../lib/i18n';
export const STATUS_KEYS: Record<PoolStatus, string> = {
  available: 'fpAvailable',
  taken: 'fpTaken',
  fleet: 'fpInFleet',
  problem: 'fpProblem',
  retired: 'fpRetired',
};
export function StatusChip({ status }: { status: PoolStatus }) {
  const { t } = useT();
  return (
    <span className={`fp-chip fp-${status}`}>
      <i className="fp-dot" />
      {t(STATUS_KEYS[status])}
    </span>
  );
}
export function CookieLabel({
  account,
}: {
  account: Pick<PoolAccount, 'uid' | 'cookie' | 'cookieAt'>;
}) {
  const { t } = useT();
  const health = cookieHealth(account);
  const key = {
    none: 'fpNoCookie',
    missing: 'fpCookieMissing',
    mismatch: 'fpCookieMismatch',
    unknown: 'fpCookieUnknown',
    fresh: 'fpCookieAge',
    stale: 'fpCookieAge',
  }[health.kind];
  return (
    <span className={`fp-cookie fp-cookie-${health.kind}`}>
      {health.kind === 'fresh' && '✓ '}
      {t(key, { n: health.days })}
    </span>
  );
}
export function PoolCode({ secret, large = false }: { secret: string; large?: boolean }) {
  const { t } = useT();
  const [now, setNow] = useState(Date.now);
  const [code, setCode] = useState<string | null>(null);
  const slot = Math.floor(now / 30_000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    let active = true;
    setCode(null);
    void poolTotp(secret, slot * 30_000).then((value) => {
      if (active) setCode(value);
    });
    return () => {
      active = false;
    };
  }, [secret, slot]);
  const left = 30 - (Math.floor(now / 1000) % 30);
  return (
    <span className={`fp-code ${large ? 'fp-code-large' : ''}`}>
      <span className="mono">{code ? `${code.slice(0, 3)} ${code.slice(3)}` : t('fpNoKey')}</span>
      {code && (
        <span className={`fp-countdown ${left <= 5 ? 'fp-low' : ''}`} title={`${left}s`}>
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="8" className="fp-ring-bg" />
            <circle
              cx="11"
              cy="11"
              r="8"
              strokeDasharray="50.27"
              strokeDashoffset={50.27 * (1 - left / 30)}
              transform="rotate(-90 11 11)"
            />
          </svg>
          {!large && <small>{left}s</small>}
        </span>
      )}
    </span>
  );
}
export function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  return (
    <button type="button" className="btn ghost icon sm" aria-label={t('fpClose')} onClick={onClose}>
      <Icon name="x" size={16} />
    </button>
  );
}

// The shared Modal restores focus and handles Escape. Keep Tab inside these
// forms as well, including when a secret's reveal control is added or removed.
export function usePoolDialogFocus() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const panel = document.querySelector<HTMLElement>('.fp-dialog');
      if (!panel) return;
      const targets = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
        ),
      ).filter((element) => element.getClientRects().length);
      const first = targets[0],
        last = targets[targets.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === panel)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
