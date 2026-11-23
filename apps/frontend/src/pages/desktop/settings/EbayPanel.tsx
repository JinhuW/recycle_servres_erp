import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../lib/i18n';
import { handleFetchError } from '../../../lib/errorToast';
import { fmtDate, relTime } from '../../../lib/format';
import { takeHashParam } from '../../../lib/route';
import {
  disconnectEbay, ebayCallbackErrorKey, loadEbayConnection, startEbayConnect, syncEbayNow,
  type EbayConnection, type EbayDefaultsField,
} from '../../../lib/ebayConnection';

// ─── eBay ─────────────────────────────────────────────────────────────────────
// The seller account the eBay desk publishes to and the order sync reads.
// Connecting is eBay's own consent page; the backend sends the browser back
// here with `?ebay=connected` or `?ebay=error&reason=…`. The owner chose no
// policy or location pickers: the account's defaults are used, and only what
// is missing is named.

const FIELD_KEY: Record<EbayDefaultsField, string> = {
  merchantLocationKey: 'ebayFieldLocation',
  fulfillmentPolicyId: 'ebayFieldFulfillment',
  paymentPolicyId: 'ebayFieldPayment',
  returnPolicyId: 'ebayFieldReturn',
};

export function EbayPanel({ showToast }: { showToast?: (msg: string, kind?: 'success' | 'error') => void }) {
  const { t, locale } = useT();
  const [conn, setConn] = useState<EbayConnection | null>(null);
  const [busy, setBusy] = useState<'sync' | 'disconnect' | null>(null);
  const [confirming, setConfirming] = useState(false);
  // What the consent round trip came back with, read once from the URL.
  const [callback] = useState(() => {
    const outcome = takeHashParam('ebay');
    const reason = takeHashParam('reason');
    return outcome ? { ok: outcome === 'connected', reason } : null;
  });

  const reload = useCallback(() => loadEbayConnection().then(setConn).catch(handleFetchError), []);
  useEffect(() => { void reload(); }, [reload]);

  async function syncNow() {
    setBusy('sync');
    try {
      const r = await syncEbayNow();
      showToast?.(t('ebaySyncDone', { n: r.result.newSales }), 'success');
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(null);
      void reload();
    }
  }

  async function disconnect() {
    setBusy('disconnect');
    try {
      await disconnectEbay();
      setConfirming(false);
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(null);
      void reload();
    }
  }

  const sync = conn?.sync ?? null;
  const flags = sync?.lastResult?.flags ?? [];
  const newSales = sync?.lastResult?.newSales ?? 0;
  const lastSyncLine = !sync?.lastSyncAt
    ? t('ebayNeverSynced')
    : sync.lastError
      ? t('ebaySyncFailed', { ago: relTime(sync.lastSyncAt, locale), error: sync.lastError })
      : t(newSales === 0 ? 'ebayLastSyncNone' : newSales === 1 ? 'ebayLastSyncOne' : 'ebayLastSyncMany',
        { ago: relTime(sync.lastSyncAt, locale), n: newSales });
  const canConnect = Boolean(conn?.configured && conn.keyAvailable);

  return (
    <>
      <div className="settings-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('settingsNavEbay')}</h2>
          <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 3 }}>{t('ebayPanelSub')}</div>
        </div>
      </div>

      {callback && (
        <div className={`help ${callback.ok ? '' : 'rt-help-invalid'}`} role="status" style={{ marginBottom: 12 }}>
          {callback.ok ? t('ebayCbConnected') : t(ebayCallbackErrorKey(callback.reason), { reason: callback.reason ?? '' })}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('ebayConnTitle')}</div>
            <div className="card-sub">{t('ebayConnSub')}</div>
          </div>
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          {!conn ? null : !conn.configured ? (
            <div className="help rt-help-invalid">{t('ebayNotConfigured')}</div>
          ) : (
            <>
              {!conn.keyAvailable && <div className="help rt-help-invalid">{t('ebayNoKey')}</div>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {conn.connected ? (
                  <span className={`chip ${conn.expired ? 'muted' : 'pos'}`}>
                    {conn.account?.username
                      ? t('ebayConnectedAs', { name: conn.account.username })
                      : t('ebayConnectedUnknown')}
                  </span>
                ) : (
                  <span className="chip muted">{t('ebayNotConnected')}</span>
                )}
                {conn.environment === 'sandbox' && <span className="chip accent">{t('ebaySandbox')}</span>}
                {conn.connected && conn.refreshTokenExpiresAt && !conn.expired && (
                  <span className="mono" style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                    {t('ebayReconnectBy', { date: fmtDate(conn.refreshTokenExpiresAt, locale) })}
                  </span>
                )}
              </div>
              {conn.otherEnvironment && (
                <div className="help">{t('ebayOtherEnv', { env: conn.otherEnvironment })}</div>
              )}
              {conn.connected && conn.expired && <div className="help rt-help-invalid">{t('ebayExpired')}</div>}
              {conn.connected && !conn.expired && conn.reconnectSoon && conn.refreshTokenExpiresAt && (
                <div className="help rt-help-invalid">
                  {t('ebayReconnectSoon', { date: fmtDate(conn.refreshTokenExpiresAt, locale) })}
                </div>
              )}

              {conn.connected && (
                <>
                  <div style={{ fontSize: 13 }}>{lastSyncLine}</div>
                  {flags.length > 0 && (
                    <div className="help rt-help-invalid">
                      {t('ebayFlagged', {
                        n: flags.length,
                        ids: flags.map(f => f.sellOrderId ?? f.listingId).join(', '),
                      })}
                    </div>
                  )}
                  <div className="help">{t('ebayPoliciesNote')}</div>
                  {conn.missingDefaults.length > 0 && (
                    <div className="help rt-help-invalid">
                      {t('ebayMissingDefaults', { fields: conn.missingDefaults.map(f => t(FIELD_KEY[f])).join(', ') })}
                    </div>
                  )}
                </>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {conn.connected ? (
                  <>
                    <button className="btn primary" disabled={busy !== null || conn.expired} onClick={syncNow}>
                      {busy === 'sync' ? t('ebaySyncing') : t('ebaySyncNow')}
                    </button>
                    <button className="btn" disabled={busy !== null || !canConnect} onClick={startEbayConnect}>
                      {t('ebayReconnect')}
                    </button>
                    {!confirming && (
                      <button className="btn" disabled={busy !== null} onClick={() => setConfirming(true)}>
                        {t('ebayDisconnect')}
                      </button>
                    )}
                  </>
                ) : (
                  <button className="btn primary" disabled={!canConnect} onClick={startEbayConnect}>
                    {t('ebayConnect')}
                  </button>
                )}
              </div>
              {confirming && (
                <div className="help" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span>{t('ebayDisconnectConfirm')}</span>
                  <button className="btn sm" disabled={busy !== null} onClick={disconnect}>
                    {t('ebayDisconnectYes')}
                  </button>
                  <button className="btn sm" disabled={busy !== null} onClick={() => setConfirming(false)}>
                    {t('cancel')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
