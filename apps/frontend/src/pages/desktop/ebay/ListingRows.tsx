import { useRef, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { createEbayListings, splitEbayListing } from '../../../lib/api';
import { partInputs, partTotals, type PartRow } from '../../../lib/ebay';
import { handleFetchError } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import '../../../styles/ebay.css';

// One row per eBay listing: the spec shown on eBay, its units, its price each.
// Send to eBay and Split share it: a mixed lot goes out as one listing per
// spec, and a listing that turned out to be mixed is split the same way.
function ListingRowsEditor({ rows, setRows, nextKey, badRows }: {
  rows: PartRow[];
  setRows: (rows: PartRow[]) => void;
  nextKey: () => number;
  badRows: number[];
}) {
  const { t } = useT();
  const edit = (key: number, patch: Partial<PartRow>) =>
    setRows(rows.map(r => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <>
      <div className="eb-rows">
        <span className="eb-rows-hd">{t('ebRowSpec')}</span>
        <span className="eb-rows-hd">{t('ebRowUnits')}</span>
        <span className="eb-rows-hd">{t('ebRowPrice')}</span>
        <span />
        {rows.map(r => {
          const bad = badRows.includes(r.key);
          return [
            <input
              key={r.key + 's'} className="input" aria-label={t('ebRowSpec')} value={r.spec}
              placeholder={t('ebRowSpecPh')} onChange={e => edit(r.key, { spec: e.target.value })}
            />,
            <input
              key={r.key + 'q'} className={'input mono' + (bad && !/^\d+$/.test(r.qty) ? ' bad' : '')}
              aria-label={t('ebRowUnits')} inputMode="numeric" value={r.qty}
              onChange={e => edit(r.key, { qty: e.target.value })}
            />,
            <input
              key={r.key + 'p'} className="input mono" aria-label={t('ebRowPrice')} inputMode="decimal"
              value={r.price} placeholder="0.00" onChange={e => edit(r.key, { price: e.target.value })}
            />,
            <button
              key={r.key + 'x'} type="button" className="btn icon sm" aria-label={t('ebRowRemove')}
              title={t('ebRowRemove')} disabled={rows.length <= 1}
              onClick={() => setRows(rows.filter(x => x.key !== r.key))}
            >
              <Icon name="x" size={12} />
            </button>,
          ];
        })}
      </div>
      <div>
        <button
          type="button" className="btn ghost sm"
          onClick={() => setRows([...rows, { key: nextKey(), spec: '', qty: '', price: '' }])}
        >
          <Icon name="plus" size={12} /> {t('ebRowAdd')}
        </button>
      </div>
    </>
  );
}

function useRows(initial: Omit<PartRow, 'key'>[]) {
  const seq = useRef(initial.length);
  const [rows, setRows] = useState<PartRow[]>(() => initial.map((r, i) => ({ ...r, key: i })));
  return { rows, setRows, nextKey: () => ++seq.current };
}

/** Manager: send part or all of a lot to eBay as one listing or several. */
export function SendToEbayDialog({ inventoryId, lotRef, sellable, defaultSpec, defaultPrice, onClose, onSent }: {
  inventoryId: string;
  lotRef: string;
  sellable: number;
  defaultSpec: string;
  defaultPrice: number | null;
  onClose: () => void;
  onSent: (ids: string[]) => void;
}) {
  const { t } = useT();
  const { rows, setRows, nextKey } = useRows([{
    spec: defaultSpec, qty: sellable > 0 ? String(sellable) : '', price: defaultPrice != null ? defaultPrice.toFixed(2) : '',
  }]);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const totals = partTotals(rows, sellable, false);
  const send = async () => {
    if (!totals.ok || sending) return;
    setSending(true);
    try {
      const r = await createEbayListings({ inventoryId, note: note.trim() || null, listings: partInputs(rows) });
      onSent(r.ids);
    } catch (e) {
      handleFetchError(e);
      setSending(false);
    }
  };
  const left = sellable - totals.assigned;
  return (
    <Modal onClose={() => { if (!sending) onClose(); }} shellStyle={{ maxWidth: 640 }} ariaLabel={t('ebSendTitle')}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{t('ebSendTitle')}</div>
          <div className="modal-sub" style={{ lineHeight: 1.5 }}>{t('ebSendSub', { lot: lotRef })}</div>
        </div>
      </div>
      <div className="modal-body" style={{ gap: 14 }}>
        <ListingRowsEditor rows={rows} setRows={setRows} nextKey={nextKey} badRows={totals.badRows} />
        <div className={'eb-total' + (totals.over ? ' over' : '')}>
          <span>{t('ebSendTotal', { n: totals.assigned, total: sellable })}</span>
          <span>
            {totals.over ? t('ebSendOver') : left > 0 ? t('ebSendLeft', { n: left }) : t('ebSendWhole')}
          </span>
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
        <button className="btn accent" disabled={!totals.ok || sending} onClick={send}>
          {sending ? '…' : t('ebSendN', { n: rows.length })}
        </button>
      </div>
    </Modal>
  );
}

/** Break a listing still to post into one listing per spec; the units must all be handed out. */
export function SplitListingDialog({ listing, onClose, onSplit }: {
  listing: { id: string; qty: number; listPrice: number; spec: string | null };
  onClose: () => void;
  onSplit: (newIds: string[]) => void;
}) {
  const { t } = useT();
  const { rows, setRows, nextKey } = useRows([
    { spec: listing.spec ?? '', qty: String(listing.qty), price: listing.listPrice.toFixed(2) },
    { spec: '', qty: '', price: listing.listPrice.toFixed(2) },
  ]);
  const [saving, setSaving] = useState(false);
  const totals = partTotals(rows, listing.qty, true, 2);
  const split = async () => {
    if (!totals.ok || saving) return;
    setSaving(true);
    try {
      const r = await splitEbayListing(listing.id, partInputs(rows));
      onSplit(r.newIds);
    } catch (e) {
      handleFetchError(e);
      setSaving(false);
    }
  };
  const left = listing.qty - totals.assigned;
  return (
    <Modal onClose={() => { if (!saving) onClose(); }} shellStyle={{ maxWidth: 640 }} ariaLabel={t('ebSplitTitle', { id: listing.id })}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{t('ebSplitTitle', { id: listing.id })}</div>
          <div className="modal-sub" style={{ lineHeight: 1.5 }}>{t('ebSplitSub', { id: listing.id, n: listing.qty })}</div>
        </div>
      </div>
      <div className="modal-body" style={{ gap: 14 }}>
        <ListingRowsEditor rows={rows} setRows={setRows} nextKey={nextKey} badRows={totals.badRows} />
        <div className={'eb-total' + (totals.over ? ' over' : '')}>
          <span>{t('ebSplitTotal', { n: totals.assigned, total: listing.qty })}</span>
          <span>{totals.over ? t('ebSplitOver') : left > 0 ? t('ebSplitLeft', { n: left }) : t('ebSplitAll')}</span>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" disabled={saving} onClick={onClose}>{t('cancel')}</button>
        <button className="btn accent" disabled={!totals.ok || saving} onClick={split}>
          {saving ? '…' : t('ebSplitN', { n: rows.length })}
        </button>
      </div>
    </Modal>
  );
}
