import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import { api } from '../../../lib/api';
import { handleFetchError, showSuccessToast, showWarnToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { SendToEbayDialog } from './ListingRows';

/**
 * Send to eBay from a list row. The lot's free quantity is read when the
 * button is pressed, not per row, so a long inventory list costs nothing.
 */
export function SendToEbayButton({ lotId, lotRef, spec, price, compact, onSent }: {
  lotId: string;
  lotRef: string;
  spec: string;
  price: number | null;
  /** An icon button, for a row's actions column. */
  compact?: boolean;
  onSent?: () => void;
}) {
  const { t } = useT();
  const [sellable, setSellable] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const r = await api.post<{ items: { qty: number; committed_qty?: number }[] }>('/api/inventory/rows', { ids: [lotId] });
      const row = r.items[0];
      const free = row ? Math.max(0, row.qty - (row.committed_qty ?? 0)) : 0;
      if (free === 0) {
        showWarnToast(t('ebSendNoneTip'));
        return;
      }
      setSellable(free);
    } catch (err) {
      handleFetchError(err);
    } finally {
      setLoading(false);
    }
  };

  // The dialog renders in place, so its clicks would bubble to the row and
  // fold or open the product group.
  return (
    <span style={{ display: 'contents' }} onClick={e => e.stopPropagation()}>
      {compact ? (
        <button className="btn icon sm" title={t('ebSendTitle')} aria-label={t('ebSendTitle')} disabled={loading} onClick={open}>
          <Icon name="package" size={12} />
        </button>
      ) : (
        <button className="btn sm" disabled={loading} onClick={open} style={{ whiteSpace: 'nowrap' }}>
          <Icon name="package" size={12} /> {t('ebSendTitle')}
        </button>
      )}
      {sellable !== null && (
        <SendToEbayDialog
          inventoryId={lotId}
          lotRef={lotRef}
          sellable={sellable}
          defaultSpec={spec}
          defaultPrice={price}
          onClose={() => setSellable(null)}
          onSent={(ids) => {
            setSellable(null);
            showSuccessToast(t('ebToastSent', { ids: ids.join(', ') }));
            onSent?.();
          }}
        />
      )}
    </span>
  );
}
