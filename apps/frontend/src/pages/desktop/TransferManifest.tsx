import { useEffect } from 'react';
import { useT } from '../../lib/i18n';
import type { TransferOrder } from './DesktopTransfers';
import { lineLabel } from './DesktopTransfers';

export function printManifest(): void {
  window.print();
}

type Props = {
  order: TransferOrder;
  onClose: () => void;
  onReady: () => void;
};

// Renders a print-only packing list. `.transfer-manifest` is hidden on screen
// and shown for print; the app shell is hidden for print. See index.css.
export function TransferManifest({ order, onClose, onReady }: Props) {
  const { t } = useT();

  useEffect(() => {
    const after = () => onClose();
    window.addEventListener('afterprint', after);
    const id = window.setTimeout(onReady, 50);
    return () => {
      window.removeEventListener('afterprint', after);
      window.clearTimeout(id);
    };
  }, [onClose, onReady]);

  const to = order.to_short ?? order.to_warehouse_id;
  const from = order.from_short ?? order.from_warehouse_id ?? t('transfersMixed');
  const units = order.lines.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="transfer-manifest">
      <h1 style={{ marginBottom: 4 }}>{t('transfersManifestTitle')}</h1>
      <div style={{ fontFamily: 'monospace', fontSize: 18, marginBottom: 12 }}>{order.id}</div>
      <table style={{ width: '100%', marginBottom: 16, fontSize: 13 }}>
        <tbody>
          <tr><td><strong>From</strong></td><td>{from}</td>
              <td><strong>To</strong></td><td>{to}</td></tr>
          <tr><td><strong>Created</strong></td><td>{new Date(order.created_at).toLocaleString()}</td>
              <td><strong>By</strong></td><td>{order.created_by_name ?? ''}</td></tr>
          <tr><td><strong>Status</strong></td><td>{order.status}</td>
              <td><strong>Note</strong></td><td>{order.note ?? ''}</td></tr>
        </tbody>
      </table>
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{t('transfersColItem')}</th>
            <th style={{ textAlign: 'right' }}>{t('transfersColQty')}</th>
            <th style={{ textAlign: 'left' }}>{t('transfersColFrom')}</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.id}>
              <td>{lineLabel(l)}</td>
              <td style={{ textAlign: 'right' }}>{l.qty}</td>
              <td>{l.from_short ?? l.from_wh ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 16, fontSize: 13 }}>
        <strong>{t('transfersItems', { n: order.item_count })}</strong> · {units} units
      </div>
    </div>
  );
}
