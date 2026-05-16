import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Icon } from '../../components/Icon';

type TransferRow = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  description: string | null;
  part_number: string | null;
  qty: number;
  to_wh: string | null;
  to_short: string | null;
  from_wh: string | null;
  from_short: string | null;
  transferred_at: string;
  note: string | null;
  actor_name: string | null;
};

type Props = {
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

function rowLabel(r: TransferRow): string {
  return [r.brand, r.capacity, r.type, r.part_number]
    .filter(Boolean)
    .join(' ') || r.description || r.category;
}

function downloadCsv(rows: TransferRow[]): void {
  const head = ['Item', 'Qty', 'From', 'To', 'Transferred', 'Note', 'By'];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      rowLabel(r),
      String(r.qty),
      r.from_short ?? r.from_wh ?? '',
      r.to_short ?? r.to_wh ?? '',
      new Date(r.transferred_at).toISOString(),
      r.note ?? '',
      r.actor_name ?? '',
    ]
      .map((c) => esc(String(c)))
      .join(','),
  );
  const csv = [head.map(esc).join(','), ...lines].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transfers-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DesktopTransfers({ onToast }: Props = {}) {
  const { t } = useT();
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .get<{ items: TransferRow[] }>('/api/inventory/transfers')
      .then((r) => { setRows(r.items); setSelected(new Set()); })
      .catch((e) => onToast?.(String(e), 'error'));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Group rows under a "from → to" batch header.
  const groups = useMemo(() => {
    const m = new Map<string, TransferRow[]>();
    for (const r of rows) {
      const key = `${r.from_short ?? r.from_wh ?? '?'} → ${r.to_short ?? r.to_wh ?? '?'}`;
      const bucket = m.get(key);
      if (bucket) bucket.push(r);
      else m.set(key, [r]);
    }
    return [...m.entries()];
  }, [rows]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const confirmReceived = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const ids = [...selected];
      await api.post<{ ok: true; ids: string[] }>('/api/inventory/receive', { ids });
      onToast?.(t('transfersReceived', { n: ids.length }));
      load();
    } catch (e) {
      onToast?.(t('transfersReceiveError') + ': ' + String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('transfersTitle')}</h1>
          <div className="page-sub">{t('transfersSubtitle')}</div>
        </div>
        <div className="page-actions">
          <button className="btn" disabled={!rows.length} onClick={() => downloadCsv(rows)}>
            <Icon name="download" size={14} /> {t('transfersExport')}
          </button>
          <button
            className="btn accent"
            disabled={!selected.size || busy}
            onClick={confirmReceived}
          >
            <Icon name="check" size={14} /> {t('transfersConfirm')}
            {selected.size > 0 && (
              <span style={{
                marginLeft: 4, padding: '1px 7px',
                background: 'rgba(255,255,255,0.22)', borderRadius: 999,
                fontSize: 11, fontWeight: 600,
              }}>{selected.size}</span>
            )}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="page-sub" style={{ padding: 24 }}>{t('transfersEmpty')}</div>
      ) : (
        groups.map(([label, grp]) => (
          <div key={label} style={{ marginBottom: 20 }}>
            <div className="nav-section" style={{ marginBottom: 6 }}>
              <Icon name="truck" size={12} /> {label} · {grp.length}
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  <th>{t('transfersColItem')}</th>
                  <th style={{ textAlign: 'right' }}>{t('transfersColQty')}</th>
                  <th>{t('transfersColDate')}</th>
                  <th>{t('transfersColNote')}</th>
                  <th>{t('transfersColBy')}</th>
                </tr>
              </thead>
              <tbody>
                {grp.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                    <td>{rowLabel(r)}</td>
                    <td style={{ textAlign: 'right' }}>{r.qty}</td>
                    <td>{new Date(r.transferred_at).toLocaleDateString()}</td>
                    <td>{r.note ?? ''}</td>
                    <td>{r.actor_name ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </>
  );
}
