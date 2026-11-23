import { api } from './api';

// Settings ▸ eBay: the seller account behind the eBay desk. The backend is
// apps/backend/src/routes/ebayConnection.ts; it never returns a token.

export type EbayDefaultsField = 'merchantLocationKey' | 'fulfillmentPolicyId' | 'paymentPolicyId' | 'returnPolicyId';

export type EbaySyncFlag = {
  saleId: string; listingId: string; ebayOrderId: string; sellOrderId: string | null;
  reason: 'cancelled_after_confirm'; seenAt: string;
};

export type EbaySyncResult = {
  from?: string; to?: string;
  ordersSeen: number; matched: number; newSales: number; updatedSales: number;
  linkedManual: number; dismissed: number; flags: EbaySyncFlag[];
};

export type EbayConnection = {
  configured: boolean;
  keyAvailable: boolean;
  environment: 'sandbox' | 'production';
  connected: boolean;
  otherEnvironment: 'sandbox' | 'production' | null;
  account: { userId: string | null; username: string | null } | null;
  marketplaceId: string | null;
  refreshTokenExpiresAt: string | null;
  reconnectSoon: boolean;
  expired: boolean;
  missingDefaults: EbayDefaultsField[];
  connectedAt: string | null;
  connectedBy: { id: string; name: string | null } | null;
  sync: {
    lastSyncAt: string | null;
    lastError: string | null;
    lastResult: EbaySyncResult | null;
    cursor: string | null;
  } | null;
};

export const loadEbayConnection = () => api.get<EbayConnection>('/api/ebay/connection');
export const disconnectEbay = () => api.delete<{ ok: true }>('/api/ebay/connection');
export const syncEbayNow = () => api.post<{ ok: true; result: EbaySyncResult }>('/api/ebay/sync', {});

/**
 * Connect and Reconnect are a full-page trip through eBay's consent page; the
 * backend sends the browser back to `/#/settings?section=ebay&ebay=…`.
 */
export function startEbayConnect(): void {
  window.location.assign('/api/ebay/oauth/start');
}

/** The i18n key for the callback's `reason` flag. */
export function ebayCallbackErrorKey(reason: string | null): string {
  switch (reason) {
    case 'state': return 'ebayCbErrState';
    case 'session': return 'ebayCbErrSession';
    case 'declined': return 'ebayCbErrDeclined';
    case 'exchange': return 'ebayCbErrExchange';
    case 'not_configured': return 'ebayNotConfigured';
    case 'no_key': return 'ebayNoKey';
    case 'forbidden': return 'ebayCbErrForbidden';
    default: return 'ebayCbErrOther';
  }
}
