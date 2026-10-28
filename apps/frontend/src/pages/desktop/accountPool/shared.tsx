import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Icon } from '../../../components/Icon';
import {
  base32Bytes,
  cookieHealth,
  poolTotp,
  type PoolAccount,
  sessionContents,
  type PoolStatus,
} from '../../../lib/facebookPool';
import { relTime } from '../../../lib/format';
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
  account: Pick<PoolAccount, 'uid' | 'cookie' | 'cookieAt'> & { cookieBy?: string | null };
}) {
  const { t, locale } = useT();
  const health = cookieHealth(account);
  const key = {
    none: 'fpNoCookie',
    missing: 'fpCookieMissing',
    mismatch: 'fpCookieMismatch',
    unknown: 'fpCookieUnknown',
    fresh: 'fpCookieAge',
    stale: 'fpCookieAge',
  }[health.kind];
  // Whole days hid a worker's half-hourly saves: a backup minutes old and
  // one 23 h old both read "0 d".
  const at = health.kind === 'fresh' || health.kind === 'stale' ? new Date(account.cookieAt!) : null;
  const title = at
    ? t(account.cookieBy ? 'fpCookieSavedBy' : 'fpCookieSavedAt', {
        when: at.toLocaleString(locale),
        who: account.cookieBy ?? '',
      })
    : undefined;
  return (
    <span className={`fp-cookie fp-cookie-${health.kind}`} title={title}>
      {health.kind === 'fresh' && '✓ '}
      {at ? t(key, { age: relTime(at, locale) }) : t(key)}
    </span>
  );
}
/** What the stored session holds, and who saved it: the editor's line under the cookie. */
export function SessionSummary({ cookie, cookieBy }: { cookie: string; cookieBy: string | null }) {
  const { t } = useT();
  const held = sessionContents(cookie);
  if (!held) return null;
  return (
    <span className="fp-muted">
      {' · '}
      {t(held.origins ? 'fpSessionHolds' : 'fpSessionCookiesOnly', held)}
      {cookieBy && <> · {t('fpSessionBy', { who: cookieBy })}</>}
    </span>
  );
}

// One clock for every code on the page. Each code used to own a one-second
// interval, so a table of N accounts ran N timers.
const clock = {
  now: Date.now(),
  listeners: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
};
function subscribeClock(listener: () => void) {
  clock.listeners.add(listener);
  if (clock.listeners.size === 1) {
    clock.now = Date.now();
    clock.timer = setInterval(() => {
      clock.now = Date.now();
      clock.listeners.forEach((fn) => fn());
    }, 1000);
  }
  return () => {
    clock.listeners.delete(listener);
    if (!clock.listeners.size) clearInterval(clock.timer);
  };
}
const readClock = () => clock.now;
const usePoolClock = () => useSyncExternalStore(subscribeClock, readClock, readClock);

export function PoolCode({ secret, large = false }: { secret: string; large?: boolean }) {
  const { t } = useT();
  const now = usePoolClock();
  const slot = Math.floor(now / 30_000);
  const hasKey = useMemo(() => base32Bytes(secret) !== null, [secret]);
  // The last code computed, with the key it came from: it stays on screen
  // while the next slot's code is being computed, instead of blinking through
  // an empty state at every :00 and :30. `value` null after a computation
  // means crypto.subtle is missing, which is an http page.
  const [code, setCode] = useState<{ secret: string; value: string | null } | null>(null);
  useEffect(() => {
    if (!hasKey) return;
    let active = true;
    void poolTotp(secret, slot * 30_000).then((value) => {
      if (active) setCode({ secret, value });
    });
    return () => {
      active = false;
    };
  }, [secret, slot, hasKey]);
  const className = `fp-code ${large ? 'fp-code-large' : ''}`;
  if (!hasKey) {
    return (
      <span className={className}>
        <span className="mono">{t('fpNoKey')}</span>
      </span>
    );
  }
  const current = code?.secret === secret ? code : null;
  const unavailable = current !== null && current.value === null;
  const value = current?.value ?? null;
  const left = 30 - (Math.floor(now / 1000) % 30);
  return (
    <span className={className} title={unavailable ? t('fpCodeUnavailable') : undefined}>
      <span className="mono">{value ? `${value.slice(0, 3)} ${value.slice(3)}` : '··· ···'}</span>
      {value && (
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
