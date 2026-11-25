import { useEffect, useState } from 'react';
import { Modal } from '../../../components/Modal';
import { api, createEbayListings } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import '../../../styles/ebay.css';

export type BulkEbayLot = { id: string; lotRef: string; spec: string; price: number | null };

type Row = BulkEbayLot & { free: number | null; qty: string; priceText: string; specText: string; error?: string };

const isWhole = (s: string) => /^\d+$/.test(s.trim());
const isPrice = (s: string) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) >= 0;

/**
 * The lots picked on Inventory, one eBay listing each. A lot with mixed specs
 * is split later on the eBay page, or sent from its own row.
 */
export function BulkSendToEbayDialog({ lots, onClose, onSent }: {
  lots: BulkEbayLot[];
  onClose: () => void;
  /** `done` is false when some lots failed: they stay on screen with the reason. */
  onSent: (ids: string[], sentLotIds: string[], done: boolean) => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<Row[]>(() => lots.map(l => ({
    ...l, free: null, qty: '', specText: l.spec, priceText: l.price != null ? l.price.toFixed(2) : '',
  })));
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  // What each lot still has free: its qty less what sell orders and eBay hold.
  useEffect(() => {
    let alive = true;
    api.post<{ items: { id: string; qty: number; committed_qty?: number }[] }>('/api/inventory/rows', { ids: lots.map(l => l.id) })
      .then(r => {
        if (!alive) return;
        const byId = new Map(r.items.map(i => [i.id, Math.max(0, i.qty - (i.committed_qty ?? 0))]));
        setRows(prev => prev.map(row => {
          const free = byId.get(row.id) ?? 0;
          return { ...row, free, qty: String(free) };
        }));
      })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [lots]);

  const edit = (id: string, patch: Partial<Row>) =>
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch, error: undefined } : r)));

  const loaded = rows.every(r => r.free !== null);
  const sendable = rows.filter(r => r.free && isWhole(r.qty) && Number(r.qty) > 0);
  const bad = (r: Row) => r.free !== null && r.free > 0 && (
    !isWhole(r.qty) || Number(r.qty) > r.free || (Number(r.qty) > 0 && !isPrice(r.priceText)));
  const ok = loaded && sendable.length > 0 && !rows.some(bad);
  const units = sendable.reduce((a, r) => a + Number(r.qty), 0);

  const send = async () => {
    if (!ok || sending) return;
    setSending(true);
    const ids: string[] = [];
    const sentLots: string[] = [];
    // One call per lot: each lot's free qty is checked on its own, so one
    // lot that changed under us doesn't stop the rest.
    for (const r of sendable) {
      try {
        const res = await createEbayListings({
          inventoryId: r.id,
          note: note.trim() || null,
          listings: [{ qty: Number(r.qty), listPrice: Math.round(Number(r.priceText) * 100) / 100, spec: r.specText.trim() || null }],
        });
        ids.push(...res.ids);
        sentLots.push(r.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setRows(prev => prev.map(x => (x.id === r.id ? { ...x, error: msg } : x)));
      }
    }
    setSending(false);
    if (sentLots.length === sendable.length) onSent(ids, sentLots, true);
    else if (sentLots.length > 0) {
      // Drop what went; leave the failures on screen with their reason.
      setRows(prev => prev.filter(x => !sentLots.includes(x.id)));
      onSent(ids, sentLots, false);
    }
  };

  return (
    <Modal onClose={() => { if (!sending) onClose(); }} shellStyle={{ maxWidth: 820 }} ariaLabel={t('ebBulkTitle', { n: lots.length })}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{t('ebBulkTitle', { n: lots.length })}</div>
          <div className="modal-sub" style={{ lineHeight: 1.5 }}>{t('ebBulkSub')}</div>
        </div>
      </div>
      <div className="modal-body" style={{ gap: 14 }}>
        <div className="eb-bulk">
          <span className="eb-rows-hd">{t('ebBulkLot')}</span>
          <span className="eb-rows-hd">{t('ebRowSpec')}</span>
          <span className="eb-rows-hd">{t('ebBulkFree')}</span>
          <span className="eb-rows-hd">{t('ebRowUnits')}</span>
          <span className="eb-rows-hd">{t('ebRowPrice')}</span>
          {rows.map(r => {
            const none = r.free === 0;
            return [
              <span key={r.id + 'l'} className="mono" style={{ fontSize: 12.5 }}>{r.lotRef}</span>,
              <input
                key={r.id + 's'} className="input" aria-label={t('ebRowSpec')} value={r.specText}
                disabled={none} onChange={e => edit(r.id, { specText: e.target.value })}
              />,
              <span key={r.id + 'f'} className="mono muted">{r.free ?? '…'}</span>,
              none
                ? <span key={r.id + 'q'} className="muted" style={{ fontSize: 12, gridColumn: 'span 2' }}>{t('ebBulkNoneFree')}</span>
                : <input
                    key={r.id + 'q'} className={'input mono' + (bad(r) && (!isWhole(r.qty) || Number(r.qty) > (r.free ?? 0)) ? ' bad' : '')}
                    aria-label={t('ebRowUnits')} inputMode="numeric" value={r.qty}
                    disabled={r.free === null} onChange={e => edit(r.id, { qty: e.target.value })}
                  />,
              none ? null : (
                <input
                  key={r.id + 'p'} className={'input mono' + (bad(r) && !isPrice(r.priceText) ? ' bad' : '')}
                  aria-label={t('ebRowPrice')} inputMode="decimal" placeholder="0.00" value={r.priceText}
                  onChange={e => edit(r.id, { priceText: e.target.value })}
                />
              ),
              r.error ? <span key={r.id + 'e'} className="eb-bulk-err">{r.error}</span> : null,
            ];
          })}
        </div>
        <div className="eb-total">
          <span>{t('ebBulkTotal', { n: sendable.length, units })}</span>
          <span>{t('ebBulkSkipHint')}</span>
        </div>
        <label className="eb-field">
          {t('ebSendNote')}
          <textarea
            className="input" rows={2} value={note} onChange={e => setNote(e.target.value)}
            style={{ height: 60, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit' }}
          />
        </label>
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={sending} onClick={onClose}>{t('cancel')}</button>
        <button className="btn accent" disabled={!ok || sending} onClick={send}>
          {sending ? '…' : t('ebBulkSend', { n: sendable.length })}
        </button>
      </div>
    </Modal>
  );
}
