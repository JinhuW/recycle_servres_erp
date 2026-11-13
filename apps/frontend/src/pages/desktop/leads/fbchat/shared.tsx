import type { CSSProperties } from 'react';
import type { FbChatAccountStatus } from '@recycle-erp/shared';
import { FB_CHAT_STATUS_KEY, fbChatHue, fbChatInitials, fbChatNameHue } from '../../../../lib/fbChat';
import { useT } from '../../../../lib/i18n';

// Pieces all three tabs draw: an account's numbered badge in its own hue, a
// buyer's avatar, and the one-line account status.

/** Sets the account's hue on a wrapper, so `.fbc-acct` children can use `--c` and `--cs`. */
export const fbcHueStyle = (no: number) => ({ '--h': fbChatHue(no) }) as CSSProperties;

export function AccountBadge({ no, label, small }: { no: number; label: string; small?: boolean }) {
  return (
    <span className={`fbc-acct fbc-badge${small ? ' sm' : ''}`} style={fbcHueStyle(no)} title={`#${no} ${label}`}>{no}</span>
  );
}

/** A buyer's initials on a tint of their own. `size` in px; the default is the chat list's. */
export function BuyerAvatar({ name, size = 44 }: { name: string | null; size?: number }) {
  const style = { '--ah': fbChatNameHue(name ?? ''), width: size, height: size, fontSize: Math.round(size * 0.34) } as CSSProperties;
  return <span className="fbc-av" style={style} aria-hidden="true">{fbChatInitials(name)}</span>;
}

export function AccountHealth({ status }: { status: FbChatAccountStatus }) {
  const { t } = useT();
  return <span className={`fbc-health fbc-h-${status}`}><i />{t(FB_CHAT_STATUS_KEY[status])}</span>;
}
