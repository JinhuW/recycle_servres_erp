import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Icon } from '../../components/Icon';
import { statusTone } from '../../lib/status';
import { TransferManifest, printManifest } from './TransferManifest';

export type TransferLine = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  description: string | null;
  part_number: string | null;
  qty: number;
  from_wh: string | null;
  from_short: string | null;
  transferred_at: string;
};

export type TransferOrder = {
  id: string;
  from_warehouse_id: string | null;
  from_short: string | null;
  to_warehouse_id: string;
  to_short: string | null;
  note: string | null;
  status: string;
  created_at: string;
  received_at: string | null;
  created_by_name: string | null;
  item_count: number;
  unit_count: number;
  lines: TransferLine[];
};

type StatusFilter = 'pending' | 'received' | 'all';

type Props = {
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function lineLabel(l: TransferLine): string {
  return [l.brand, l.capacity, l.generation, l.part_number]
    .filter(Boolean)
    .join(' ') || l.description || l.category;
}

function downloadOrderCsv(order: TransferOrder): void {
  const head = ['Item', 'Qty', 'From', 'To', 'Transferred'];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const to = order.to_short ?? order.to_warehouse_id;
  const rows = order.lines.map((l) =>
    [
      lineLabel(l),
      String(l.qty),
      l.from_short ?? l.from_wh ?? '',
      to,
      new Date(l.transferred_at).toISOString(),
    ].map((c) => esc(String(c))).join(','),
  );
  const csv = [head.map(esc).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transfer-${order.id}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DesktopTransfers({ onToast }: Props = {}) {
  const { t } = useT();
  const [orders, setOrders] = useState<TransferOrder[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('pending');
  const [busy, setBusy] = useState<string | null>(null);
  const [printing, setPrinting] = useState<TransferOrder | null>(null);

  const load = (f: StatusFilter) => {
    api
      .get<{ orders: TransferOrder[] }>(`/api/inventory/transfer-orders?status=${f}`)
      .then((r) => setOrders(r.orders))
      .catch((e) => onToast?.(String(e), 'error'));
  };
  useEffect(() => load(filter), [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (order: TransferOrder, kind: 'receive' | 'reopen') => {
    setBusy(order.id);
    try {
      await api.post<{ ok: true; id: string }>(
        `/api/inventory/transfer-orders/${order.id}/${kind}`, {},
      );
      onToast?.(t(kind === 'receive' ? 'transfersReceived' : 'transfersReopened', { id: order.id }));
      load(filter);
    } catch (e) {
      onToast?.(t('transfersActionError') + ': ' + String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const fromLabel = (o: TransferOrder) =>
    o.from_warehouse_id ? (o.from_short ?? o.from_warehouse_id) : t('transfersMixed');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('transfersTitle')}</h1>
          <div className="page-sub">{t('transfersSubtitle')}</div>
        </div>
        <div className="page-actions">
          {(['pending', 'received', 'all'] as StatusFilter[]).map((f) => (
            <button
              key={f}
              className={'btn' + (filter === f ? ' accent' : '')}
              onClick={() => setFilter(f)}
            >
              {t(f === 'pending' ? 'transfersFilterPending'
                : f === 'received' ? 'transfersFilterReceived'
                : 'transfersFilterAll')}
            </button>
          ))}
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="page-sub" style={{ padding: 24 }}>{t('transfersEmpty')}</div>
      ) : (
        orders.map((o) => (
          <div key={o.id} className="card" style={{ marginBottom: 16, padding: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 12, flexWrap: 'wrap', marginBottom: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontWeight: 600 }}>{o.id}</span>
                <span style={{ fontSize: 13 }}>
                  <span className="mono">{fromLabel(o)}</span>
                  <Icon name="arrow" size={11} style={{ margin: '0 6px', verticalAlign: 'middle' }} />
                  <span className="mono">{o.to_short ?? o.to_warehouse_id}</span>
                </span>
                <span className={'chip ' + statusTone(o.status)} style={{ fontSize: 11 }}>{o.status}</span>
                <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                  {t('transfersItems', { n: o.item_count })} · {new Date(o.created_at).toLocaleDateString()}
                  {o.created_by_name ? ' · ' + o.created_by_name : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => setPrinting(o)}>
                  <Icon name="file" size={13} /> {t('transfersManifest')}
                </button>
                <button className="btn" onClick={() => downloadOrderCsv(o)}>
                  <Icon name="download" size={13} /> {t('transfersExport')}
                </button>
                {o.status === 'Pending' && (
                  <button className="btn accent" disabled={busy === o.id}
                          onClick={() => act(o, 'receive')}>
                    <Icon name="check" size={13} /> {t('transfersConfirm')}
                  </button>
                )}
                {o.status === 'Received' && (
                  <button className="btn" disabled={busy === o.id}
                          onClick={() => act(o, 'reopen')}>
                    <Icon name="refresh" size={13} /> {t('transfersReopen')}
                  </button>
                )}
              </div>
            </div>
            {o.note && (
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 8 }}>{o.note}</div>
            )}
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('transfersColItem')}</th>
                  <th style={{ textAlign: 'right' }}>{t('transfersColQty')}</th>
                  <th>{t('transfersColFrom')}</th>
                  <th>{t('transfersColDate')}</th>
                </tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{lineLabel(l)}</td>
                    <td style={{ textAlign: 'right' }}>{l.qty}</td>
                    <td>{l.from_short ?? l.from_wh ?? ''}</td>
                    <td>{new Date(l.transferred_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {printing && (
        <TransferManifest
          order={printing}
          onClose={() => setPrinting(null)}
          onReady={printManifest}
        />
      )}
    </>
  );
}
