// Picks the open sell order that an Inventory selection is added to. Lists
// Draft / Shipped / Awaiting payment orders; the caller opens the chosen one
// in the sell-order edit modal with the selection appended.

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { useEscapeKey } from '../lib/useEscapeKey';
import { useT } from '../lib/i18n';
import { fmtUSD0, fmtDateShort } from '../lib/format';
import { sellOrderStatuses } from '../lib/lookups';
import { openSellOrders, type SellOrderPick } from '../lib/openSellOrders';
import { forEachKeysetPage } from '../lib/keysetPages';

type Props = {
  lineCount: number;
  locale: string;
  onClose: () => void;
  onPick: (id: string) => void;
};

const toneFor = (s: string) => sellOrderStatuses.find(o => o.id === s)?.tone ?? 'muted';

export function SellOrderPickerDialog({ lineCount, locale, onClose, onPick }: Props) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SellOrderPick[] | null>(null);
  useEscapeKey(onClose);

  useEffect(() => {
    let alive = true;
    // A page is the newest orders of every status, so the open ones can sit
    // past any single page — walk them all.
    forEachKeysetPage<SellOrderPick>(
      cursor => api.get<{ items: SellOrderPick[]; nextCursor: string | null }>(
        `/api/sell-orders?limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      ),
      (items, { first }) => {
        if (!alive) return false;
        setRows(prev => (first || !prev ? items : [...prev, ...items]));
      },
    ).catch(e => { if (alive) { setRows(prev => prev ?? []); handleFetchError(e); } });
    return () => { alive = false; };
  }, []);

  const visible = useMemo(() => openSellOrders(rows ?? [], q), [rows, q]);

  return (
    <div
      className="modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ zIndex: 120 }}
    >
      <div className="modal-shell" style={{ maxWidth: 640, width: 'calc(100vw - 80px)', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 80px)' }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Icon name="tag" size={18} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{t('invAddToSoTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {t('invAddToSoSub', { n: lineCount })}
            </div>
          </div>
          <button className="btn icon sm" onClick={onClose} title={t('cancel')}>
            <Icon name="x" size={13} />
          </button>
        </div>

        <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)' }}>
              <Icon name="search" size={14} />
            </span>
            <input
              className="input"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={t('invAddToSoSearch')}
              autoFocus
              style={{ paddingLeft: 32 }}
            />
          </div>
        </div>

        <div style={{ padding: '8px 16px', overflowY: 'auto', flex: 1 }}>
          {rows === null ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>{t('invAddToSoLoading')}</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>{t('invAddToSoEmpty')}</div>
          ) : (
            visible.map(o => (
              <button
                key={o.id}
                className="btn ghost"
                onClick={() => onPick(o.id)}
                style={{
                  display: 'flex', width: '100%', alignItems: 'center', gap: 12,
                  padding: '10px 8px', height: 'auto', justifyContent: 'flex-start', textAlign: 'left',
                }}
              >
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, width: 76, flexShrink: 0 }}>{o.id}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.customer.name}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1 }}>
                    {t('invAddToSoMeta', { lines: o.lineCount, units: o.qty })} · {fmtDateShort(o.createdAt, locale)}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12.5 }}>{fmtUSD0(o.total, locale)}</span>
                <span className={'chip dot ' + toneFor(o.status)}>{o.status}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
