import { Fragment, useState } from 'react';
import { FB_CHAT_ACCOUNT_LABEL_MAX, type FbChatAccountRow, type FbChatDeviceRow } from '@recycle-erp/shared';
import { fbChatAccountName, fbChatStatusOf } from '../../../../lib/fbChat';
import { relTime } from '../../../../lib/format';
import { useT } from '../../../../lib/i18n';
import { AccountBadge, AccountHealth } from './shared';

// One row per Facebook account. The Chrome that relays it is a detail of the
// row, since a Chrome can be replaced while the account and its chats stay.

/** What "Disconnect this Chrome" acts on: a device, and the account it relays when it has one. */
export type AccountDisconnect = { deviceId: string; chrome: string; account: string | null };

type TableProps = {
  accounts: FbChatAccountRow[];
  /** Approved Chromes that have not checked in yet, so have no account row. */
  waiting: FbChatDeviceRow[];
  latestVersion: string | null;
  /** The account id a write is running for. */
  busy: number | null;
  onRename: (account: FbChatAccountRow, label: string) => Promise<boolean>;
  onPause: (account: FbChatAccountRow, paused: boolean) => void;
  onDisconnect: (target: AccountDisconnect) => void;
};

const COLUMNS = 6;

export function AccountsTable({ accounts, waiting, latestVersion, busy, onRename, onPause, onDisconnect }: TableProps) {
  const { t, locale } = useT();
  const [open, setOpen] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);

  return (
    <section className="fbca-sec">
      <header>
        <h3>{t('fbca_accounts')}</h3>
        <p>{t('fbca_accountsSub')}</p>
      </header>
      <div className="card">
        {accounts.length === 0 && waiting.length === 0
          ? <div className="fbca-empty" style={{ border: 0 }}>{t('fbca_accountsNone')}</div>
          : (
            <table className="table fbca-table">
              <thead>
                <tr>
                  <th>{t('fbca_colAccount')}</th>
                  <th>{t('fbca_colStatus')}</th>
                  <th className="num">{t('fbca_colWaiting')}</th>
                  <th>{t('fbca_colSync')}</th>
                  <th>{t('fbca_colExtension')}</th>
                  <th>{t('fbca_colSettings')}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map(a => {
                  const isOpen = open === a.id;
                  const name = fbChatAccountName(a);
                  const toggle = () => { setOpen(isOpen ? null : a.id); setRenaming(null); };
                  return (
                    <Fragment key={a.id}>
                      <tr
                        className={`fbca-row${isOpen ? ' open' : ''}`}
                        tabIndex={0}
                        aria-expanded={isOpen}
                        onClick={toggle}
                        onKeyDown={e => {
                          // Keys typed in the rename field bubble up to the row.
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                        }}
                      >
                        <td>
                          <div className="fbca-cell">
                            <AccountBadge no={a.no} label={name} />
                            {renaming === a.id
                              ? (
                                <RenameField
                                  initial={a.label}
                                  busy={busy === a.id}
                                  onCancel={() => setRenaming(null)}
                                  onSave={async label => { if (await onRename(a, label)) setRenaming(null); }}
                                />
                              )
                              : <div>{name}<small>{t('fbca_fbUser', { uid: a.fb_uid })}</small></div>}
                          </div>
                        </td>
                        <td><AccountHealth status={fbChatStatusOf(a)} /></td>
                        <td className="num">{a.replies_waiting > 0 ? a.replies_waiting.toLocaleString(locale) : '–'}</td>
                        <td className="fbca-muted">{a.last_sync_at ? relTime(a.last_sync_at, locale) : '–'}</td>
                        <td>
                          <span className="fbca-ver">
                            {a.ext_version ?? '–'}
                            {a.ext_version && latestVersion && a.ext_version !== latestVersion && (
                              <span className="chip warn" title={t('fbca_updateHint', { version: latestVersion })}>{t('fbca_update')}</span>
                            )}
                          </span>
                        </td>
                        <td>
                          {a.config_state === 'up_to_date'
                            ? <span className="chip pos">{t('fbca_cfgUpToDate')}</span>
                            : (
                              <span
                                className="chip warn"
                                title={a.config_seen_at
                                  ? t('fbca_cfgWaitingHint', { when: relTime(a.config_seen_at, locale) })
                                  : t('fbca_cfgNeverHint')}
                              >
                                {t('fbca_cfgWaiting')}
                              </span>
                            )}
                        </td>
                      </tr>
                      {isOpen && (
                        <AccountDetail
                          account={a}
                          busy={busy === a.id}
                          onRename={() => setRenaming(a.id)}
                          onPause={onPause}
                          onDisconnect={onDisconnect}
                        />
                      )}
                    </Fragment>
                  );
                })}
                {waiting.map(d => {
                  const chrome = d.label || t('fbca_unnamedChrome');
                  return (
                    <tr key={d.id} className="fbca-waiting">
                      <td colSpan={COLUMNS}>
                        <div className="fbca-wait-line">
                          <span>{t('fbca_waitingFirst', { chrome, code: d.code })}</span>
                          <button className="btn sm fbca-danger" onClick={() => onDisconnect({ deviceId: d.id, chrome, account: null })}>
                            {t('fbca_disconnect')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </div>
    </section>
  );
}

/** The opened row: what the server knows about the account's Chrome, and what a manager can do to it. */
export function AccountDetail({ account: a, busy, onRename, onPause, onDisconnect }: {
  account: FbChatAccountRow;
  busy: boolean;
  /** Turns the name in the row above into a field. */
  onRename: () => void;
  onPause: TableProps['onPause'];
  onDisconnect: TableProps['onDisconnect'];
}) {
  const { t, locale } = useT();
  const device = a.device;
  const chrome = device?.label || t('fbca_unnamedChrome');
  return (
    <tr className="fbca-detail">
      <td colSpan={COLUMNS}>
        <div className="fbca-detail-grid">
          <dl className="fbca-kv">
            <dt>{t('fbca_detailUser')}</dt><dd>{a.fb_uid}</dd>
            <dt>{t('fbca_detailChrome')}</dt>
            <dd>
              {!device
                ? t('fbca_chromeNone')
                : device.status !== 'approved'
                  ? t('fbca_chromeGone', { chrome })
                  : device.ext_version
                    ? t('fbca_chromeVersion', { chrome, version: device.ext_version })
                    : chrome}
            </dd>
            <dt>{t('fbca_detailSeen')}</dt><dd>{relTime(a.last_seen_at, locale)}</dd>
            {/* decided_at is the time of the last decision: on a disconnected Chrome that is the disconnect. */}
            {device?.status === 'approved' && device.decided_at && (
              <>
                <dt>{t('fbca_detailApproved')}</dt>
                <dd>
                  {device.decided_by
                    ? t('fbca_approvedBy', { when: relTime(device.decided_at, locale), who: device.decided_by })
                    : relTime(device.decided_at, locale)}
                </dd>
              </>
            )}
          </dl>
          <div className="fbca-btns">
            <button className="btn sm" disabled={busy} onClick={onRename}>{t('fbca_rename')}</button>
            <button className="btn sm" disabled={busy} onClick={() => onPause(a, !a.paused)}>
              {a.paused ? t('fbca_resume') : t('fbca_pause')}
            </button>
            {device?.status === 'approved' && (
              <button
                className="btn sm fbca-danger"
                disabled={busy}
                onClick={() => onDisconnect({ deviceId: device.id, chrome, account: fbChatAccountName(a) })}
              >
                {t('fbca_disconnect')}
              </button>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function RenameField({ initial, busy, onSave, onCancel }: {
  initial: string;
  busy: boolean;
  onSave: (label: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState(initial);
  const label = draft.trim();
  const save = () => { if (label && !busy) onSave(label); };
  return (
    // The field sits in a row that opens on click.
    <div className="fbca-rename" onClick={e => e.stopPropagation()}>
      <input
        className="input"
        autoFocus
        aria-label={t('fbca_renameLabel')}
        value={draft}
        maxLength={FB_CHAT_ACCOUNT_LABEL_MAX}
        disabled={busy}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button className="btn sm primary" disabled={busy || !label} onClick={save}>{t('fbca_save')}</button>
      <button className="btn sm ghost" disabled={busy} onClick={onCancel}>{t('fbca_cancel')}</button>
    </div>
  );
}
