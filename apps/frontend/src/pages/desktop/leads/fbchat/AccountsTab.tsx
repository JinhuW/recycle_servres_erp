import { useState } from 'react';
import type { FbChatAccountRow, FbChatDeviceApproval, FbChatDeviceRow } from '@recycle-erp/shared';
import { Modal } from '../../../../components/Modal';
import { handleFetchError } from '../../../../lib/errorToast';
import {
  FB_CHAT_POLL_MS, fbChatAccountName, fbChatApi, fbChatChanged, setFbChatAccountPaused, usePolled,
} from '../../../../lib/fbChat';
import { useT } from '../../../../lib/i18n';
import { AccountRequests } from './AccountRequests';
import { AccountsTable, type AccountDisconnect } from './AccountsTable';
import type { FbChatTabProps } from './FbChatsPage';
import { LoadState } from './shared';
import '../../../../styles/fbChatAccounts.css';

// ─── Leads ▸ Facebook ▸ Accounts ──────────────────────────────────────────────
// Who may connect, and what is connected. Requests and check-ins come from the
// extensions, not from this app, so both lists poll: a new request shows up
// while a manager waits for it, and "Waiting" turns to "Up to date" by itself.

/**
 * Approved Chromes with no account row yet: the account appears at the
 * extension's first check-in, and until then the device is all there is.
 */
export function fbChatWaitingDevices(devices: FbChatDeviceRow[], accounts: FbChatAccountRow[]): FbChatDeviceRow[] {
  const relaying = new Set(accounts.map(a => a.device?.id));
  return devices.filter(d => d.status === 'approved' && d.matches_account === null && !relaying.has(d.id));
}

export function AccountsTab({ showToast }: FbChatTabProps) {
  const { t } = useT();
  const accounts = usePolled(fbChatApi.accounts, FB_CHAT_POLL_MS.accounts);
  const devices = usePolled(fbChatApi.devices, FB_CHAT_POLL_MS.devices);
  const [requestBusy, setRequestBusy] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState<number | null>(null);
  const [disconnect, setDisconnect] = useState<AccountDisconnect | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const reloadAll = () => Promise.all([accounts.reload(), devices.reload()]);

  if (!accounts.data || !devices.data) {
    return (
      <LoadState
        failed={(!accounts.data && accounts.failed) || (!devices.data && devices.failed)}
        loading={t('fbca_loading')} failedText={t('fbca_loadFailed')} retryText={t('fbca_tryAgain')}
        onRetry={() => void reloadAll()}
      />
    );
  }
  const rows = accounts.data.accounts;
  const all = devices.data.devices;

  // Decides a request. The lists are read again either way: a refusal usually
  // means another manager got to it first, and the card should go.
  const decide = async (device: FbChatDeviceRow, write: () => Promise<unknown>, done: string) => {
    setRequestBusy(device.id);
    try {
      await write();
      showToast?.(done, 'success');
    } catch (err) {
      handleFetchError(err);
    } finally {
      await reloadAll();
      fbChatChanged();
      setRequestBusy(null);
    }
  };

  const approve = (device: FbChatDeviceRow, approval: FbChatDeviceApproval) => {
    const known = device.matches_account;
    const name = approval.label || device.label || device.code;
    const done = known
      ? t('fbca_toastReconnected', { no: known.no, name: known.label })
      : t(approval.startPaused ? 'fbca_toastApprovedPaused' : 'fbca_toastApproved', { name });
    return decide(device, () => fbChatApi.approveDevice(device.id, approval), done);
  };
  const deny = (device: FbChatDeviceRow) =>
    decide(device, () => fbChatApi.rejectDevice(device.id), t('fbca_toastDenied', { code: device.code }));

  const onAccount = async (account: FbChatAccountRow, write: () => Promise<unknown>, done: string): Promise<boolean> => {
    setAccountBusy(account.id);
    try {
      await write();
      await accounts.reload();
      showToast?.(done, 'success');
      return true;
    } catch (err) {
      handleFetchError(err);
      return false;
    } finally {
      setAccountBusy(null);
    }
  };
  const rename = (account: FbChatAccountRow, label: string) =>
    onAccount(account, () => fbChatApi.renameAccount(account.id, label), t('fbca_toastRenamed', { name: label }));
  const pause = (account: FbChatAccountRow, paused: boolean) =>
    void onAccount(
      account,
      () => setFbChatAccountPaused(account.id, paused),
      t(paused ? 'fbca_toastPaused' : 'fbca_toastResumed', { name: fbChatAccountName(account) }),
    );

  const confirmDisconnect = async () => {
    if (!disconnect) return;
    setDisconnecting(true);
    try {
      await fbChatApi.revokeDevice(disconnect.deviceId);
      showToast?.(t('fbca_toastDisconnected', { chrome: disconnect.chrome }), 'success');
      setDisconnect(null);
    } catch (err) {
      handleFetchError(err);
    } finally {
      await reloadAll();
      setDisconnecting(false);
    }
  };
  const closeDisconnect = () => { if (!disconnecting) setDisconnect(null); };

  return (
    <div className="fbca">
      <AccountRequests
        requests={all.filter(d => d.status === 'pending')}
        nextNo={accounts.data.next_no}
        busy={requestBusy}
        onApprove={approve}
        onDeny={deny}
      />
      <AccountsTable
        accounts={rows}
        waiting={fbChatWaitingDevices(all, rows)}
        latestVersion={accounts.data.latest_ext_version}
        busy={accountBusy}
        onRename={rename}
        onPause={pause}
        onDisconnect={setDisconnect}
      />
      {disconnect && (
        <Modal onClose={closeDisconnect} shellStyle={{ maxWidth: 460 }}>
          <div className="modal-head">
            <div className="modal-title">{t('fbca_disconnectTitle', { chrome: disconnect.chrome })}</div>
          </div>
          <div className="modal-body">
            {disconnect.account === null
              ? t('fbca_disconnectBodyNoAccount', { chrome: disconnect.chrome })
              : t('fbca_disconnectBody', { chrome: disconnect.chrome, account: disconnect.account })}
          </div>
          <div className="modal-foot">
            <button className="btn" disabled={disconnecting} onClick={closeDisconnect}>{t('fbca_cancel')}</button>
            <button className="btn fbca-danger" disabled={disconnecting} onClick={() => void confirmDisconnect()}>
              {t('fbca_disconnect')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
