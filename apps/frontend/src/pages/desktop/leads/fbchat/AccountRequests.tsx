import { useId, useState } from 'react';
import { FB_CHAT_ACCOUNT_LABEL_MAX, type FbChatDeviceApproval, type FbChatDeviceRow } from '@recycle-erp/shared';
import { relTime } from '../../../../lib/format';
import { useT } from '../../../../lib/i18n';
import { AccountBadge, BuyerAvatar, fbcHueStyle } from './shared';

// Extensions enroll themselves and do nothing until approved here. The enroll
// route is open, so a stranger can ask too: the pairing code the extension
// shows in its Chrome is how a manager tells theirs apart.

/**
 * "Chrome 131 on macOS" from a user agent, as two parts for the page to word.
 * Null when it is not a Chromium desktop browser's, and the page then shows
 * the user agent as sent.
 */
export function fbChatBrowser(userAgent: string): { browser: string; os: string } | null {
  // Edge and Opera also say "Chrome/"; their own token comes later in the string.
  const m = /\b(Edg|OPR)\/(\d+)/.exec(userAgent) ?? /\b(Chrome)\/(\d+)/.exec(userAgent);
  const os = /Windows/.test(userAgent) ? 'Windows'
    : /CrOS/.test(userAgent) ? 'ChromeOS'
      : /Mac OS X|Macintosh/.test(userAgent) ? 'macOS'
        : /Linux/.test(userAgent) ? 'Linux' : null;
  if (!m || !os) return null;
  const name = m[1] === 'Edg' ? 'Edge' : m[1] === 'OPR' ? 'Opera' : 'Chrome';
  return { browser: `${name} ${m[2]}`, os };
}

// The code and the name in the explainer are examples, not data.
const SAMPLE_CODE = 'K7Q-42M';

type RequestsProps = {
  /** Devices with status `pending`. */
  requests: FbChatDeviceRow[];
  /** The number the next new account gets. */
  nextNo: number;
  /** The device id being approved or denied, so its buttons wait. */
  busy: string | null;
  onApprove: (device: FbChatDeviceRow, approval: FbChatDeviceApproval) => void;
  onDeny: (device: FbChatDeviceRow) => void;
};

export function AccountRequests({ requests, nextNo, busy, onApprove, onDeny }: RequestsProps) {
  const { t, locale } = useT();
  return (
    <section className="fbca-sec">
      <header>
        <h3>
          {t('fbca_requests')}
          {requests.length > 0 && <span className="chip warn">{requests.length.toLocaleString(locale)}</span>}
        </h3>
        <p>{t('fbca_requestsSub')}</p>
      </header>
      {requests.length === 0
        ? <div className="fbca-empty">{t('fbca_requestsNone')}</div>
        : requests.map(d => (
          <AccountRequestCard key={d.id} device={d} nextNo={nextNo} busy={busy === d.id} onApprove={onApprove} onDeny={onDeny} />
        ))}
      <details className="fbca-ext-wrap">
        <summary>{t('fbca_extSummary')}</summary>
        <div className="fbca-ext">
          <div className="fbca-ext-step">
            <h5>{t('fbca_extInstalled')}</h5>
            <div className="fbca-ext-code">{SAMPLE_CODE}</div>
            {t('fbca_extInstalledBody')}
          </div>
          <div className="fbca-ext-step">
            <h5>{t('fbca_extApproved')}</h5>
            <b>{t('fbca_extApprovedHead', { n: nextNo, name: t('fbca_extSampleName') })}</b>
            {t('fbca_extApprovedBody')}
          </div>
        </div>
      </details>
    </section>
  );
}

function AccountRequestCard({ device: d, nextNo, busy, onApprove, onDeny }: {
  device: FbChatDeviceRow;
  nextNo: number;
  busy: boolean;
  onApprove: RequestsProps['onApprove'];
  onDeny: RequestsProps['onDeny'];
}) {
  const { t, locale } = useT();
  const nameId = useId();
  const [name, setName] = useState(d.label);
  // On by default: a new account reads first, and types once someone has looked at it.
  const [startPaused, setStartPaused] = useState(true);
  const known = d.matches_account;
  const browser = d.user_agent ? fbChatBrowser(d.user_agent) : null;

  return (
    <article className={`fbca-req${known ? ' reconnect' : ''}`}>
      <div className="fbca-req-who">
        <div className="fbca-req-top">
          <BuyerAvatar name={d.label} size={42} />
          <div>
            <h4>{d.label || t('fbca_unnamedChrome')}</h4>
            <small>{d.fb_uid ? t('fbca_fbUser', { uid: d.fb_uid }) : t('fbca_notSignedIn')}</small>
          </div>
        </div>
        <div className="fbca-req-code">{t('fbca_codeLead')} <b>{d.code}</b> {t('fbca_codeTail')}</div>
        <dl className="fbca-kv">
          <dt>{t('fbca_browser')}</dt>
          <dd title={d.user_agent ?? undefined}>
            {browser ? t('fbca_browserOn', browser) : d.user_agent ?? '–'}
          </dd>
          <dt>{t('fbca_ip')}</dt><dd>{d.created_ip ?? '–'}</dd>
          <dt>{t('fbca_extension')}</dt><dd>{d.ext_version ?? '–'}</dd>
          <dt>{t('fbca_asked')}</dt><dd>{relTime(d.created_at, locale)}</dd>
        </dl>
        {known && (
          <div className="fbca-req-note">
            {t('fbca_reconnectLead')} <b>#{known.no} {known.label}</b>{t('fbca_reconnectTail')}
          </div>
        )}
      </div>
      <div className="fbca-req-act">
        {known ? (
          <>
            <span className="fbca-lbl">{t('fbca_account')}</span>
            <div className="fbca-cell fbc-acct" style={fbcHueStyle(known.no)}>
              <AccountBadge no={known.no} label={known.label} />
              <b>{known.label}</b>
            </div>
          </>
        ) : (
          <>
            <label className="fbca-lbl" htmlFor={nameId}>{t('fbca_nameIt')}</label>
            <input
              className="input"
              id={nameId}
              value={name}
              maxLength={FB_CHAT_ACCOUNT_LABEL_MAX}
              onChange={e => setName(e.target.value)}
            />
            <span className="fbca-hint">{t('fbca_nameHint', { n: nextNo })}</span>
            <label className="fbca-chk">
              <input type="checkbox" checked={startPaused} onChange={e => setStartPaused(e.target.checked)} />
              <span>{t('fbca_startPaused')}</span>
            </label>
          </>
        )}
        <div className="fbca-req-btns">
          <button className="btn" disabled={busy} onClick={() => onDeny(d)}>{t('fbca_deny')}</button>
          <button
            className="btn accent"
            disabled={busy}
            // A reconnect keeps the account's name and pause as they are; the server ignores both.
            onClick={() => onApprove(d, known ? {} : { label: name.trim(), startPaused })}
          >
            {known ? t('fbca_reconnect') : t('fbca_approve')}
          </button>
        </div>
      </div>
    </article>
  );
}
