import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { fmtUSD, fmtUSD0, fmtDateShort } from '../lib/format';
import { ORDER_STATUSES, isCompleted, statusTone } from '../lib/status';
import { categoryFilterOptions } from '../lib/lookups';
import { usePhScrolled } from '../lib/usePhScrolled';
import { useRoute, match, navigate } from '../lib/route';
import type { OrderSummary, Order } from '../lib/types';
import { Skeleton, PhoneListSkeleton } from '../components/Skeleton';
import { ImageLightbox } from '../components/ImageLightbox';

const realScan = (u?: string | null): u is string =>
  !!u && !u.startsWith('data:image/placeholder');

type Props = {
  onEdit: (o: Order) => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function Orders({ onEdit, onToast }: Props) {
  const { t } = useT();
  const [filter, setFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all');
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openLines, setOpenLines] = useState<Order | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);
  const { path } = useRoute();
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const lastHandledRouteId = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('category', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    api.get<{ orders: OrderSummary[] }>(`/api/orders?${params}`)
      .then(r => setOrders(r.orders))
      .catch(console.error)
      .finally(() => setLoadedOnce(true));
  }, [filter, statusFilter]);

  // When a row is expanded, fetch its lines lazily.
  useEffect(() => {
    if (!openId) { setOpenLines(null); return; }
    api.get<{ order: Order }>(`/api/orders/${openId}`)
      .then(r => setOpenLines(r.order))
      .catch(console.error);
  }, [openId]);

  // CC-5: when the URL matches /purchase-orders/:id, expand that row and (if
  // editable) push to the review screen. Fires whenever route or the
  // currently-loaded list changes. We track the last-handled id in a
  // ref so that orders re-fetches (e.g. chip filter change) don't yank
  // the user back into edit unexpectedly.
  useEffect(() => {
    const m = match('/purchase-orders/:id', path);
    if (!m) {
      lastHandledRouteId.current = null;
      return;
    }
    if (lastHandledRouteId.current === m.id) return; // already handled this id
    lastHandledRouteId.current = m.id;
    setOpenId(m.id);
    const node = rowRefs.current[m.id];
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const summary = orders.find(o => o.id === m.id);
    if (summary && !isCompleted(summary.status)) {
      // Fetch the full order to pass to onEdit (it expects the lines).
      api.get<{ order: Order }>(`/api/orders/${m.id}`).then(r => onEdit(r.order)).catch(() => {});
    }
    // Eslint: omitting onEdit on purpose — the parent provides a stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, orders]);

  return (
    <>
      <PhHeader
        title={t('ordersHeading')}
        sub={t('ordersSubmitted', { n: orders.length })}
        scrolled={scrolled}
        trailing={
          <button
            className="ph-icon-btn"
            onClick={() => setSearchOpen(o => !o)}
            aria-label={t('searchOrders')}
            style={{ color: searchOpen ? 'var(--accent-strong)' : undefined }}
          >
            <Icon name={searchOpen ? 'x' : 'search'} size={16} />
          </button>
        }
      />
      <div className="ph-scroll" ref={scrollRef}>
        {searchOpen && (
          <div className="ph-field" style={{ marginTop: 6 }}>
            <input
              className="input"
              autoFocus
              placeholder={t('searchOrders')}
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
            />
          </div>
        )}
        <div className="ph-chip-scroller">
          {categoryFilterOptions().map(f => (
            <button key={f} className={'ph-chip-btn ' + (filter === f ? 'active' : '')} onClick={() => setFilter(f)}>
              {f === 'all' ? t('filterAll') : f}
            </button>
          ))}
        </div>
        <div className="ph-chip-scroller" style={{ marginTop: -2 }}>
          <button className={'ph-chip-btn ' + (statusFilter === 'all' ? 'active' : '')} onClick={() => setStatusFilter('all')}>
            {t('anyStatus')}
          </button>
          {ORDER_STATUSES.map(s => (
            <button key={s} className={'ph-chip-btn ' + (statusFilter === s ? 'active' : '')} onClick={() => setStatusFilter(s)}>
              {s}
            </button>
          ))}
        </div>
        {!loadedOnce && <PhoneListSkeleton rows={5} variant="order" />}
        {loadedOnce && orders.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
            {t('noOrdersMatch')}
          </div>
        )}

        {loadedOnce && (() => {
          const q = searchQ.trim().toLowerCase();
          const filtered = q
            ? orders.filter(o =>
                o.id.toLowerCase().includes(q) ||
                (o.warehouse?.short ?? '').toLowerCase().includes(q) ||
                (o.warehouse?.region ?? '').toLowerCase().includes(q) ||
                o.userName.toLowerCase().includes(q)
              )
            : orders;
          return filtered.slice(0, 30).map(o => {
          const isOpen = openId === o.id;
          return (
            <div key={o.id} className="ph-order" ref={el => { rowRefs.current[o.id] = el; }}>
              <div className="ph-order-head" onClick={() => setOpenId(isOpen ? null : o.id)} style={{ cursor: 'pointer' }}>
                <span className={'chip ' + (o.category === 'RAM' ? 'info' : o.category === 'SSD' ? 'pos' : o.category === 'HDD' ? 'cool' : 'warn')} style={{ minWidth: 42, justifyContent: 'center' }}>
                  {o.category}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{o.id}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const url = `${location.origin}${location.pathname}#/purchase-orders/${o.id}`;
                        const share = (navigator as Navigator & { share?: (data: { url: string; title: string }) => Promise<void> }).share;
                        if (typeof share === 'function') {
                          share.call(navigator, { url, title: t('shareOrder') }).catch((err: Error) => {
                            if (err.name !== 'AbortError') onToast?.(t('orderIdCopyFailed'), 'error');
                          });
                        } else if (navigator.clipboard?.writeText) {
                          navigator.clipboard.writeText(url)
                            .then(() => onToast?.(t('orderIdCopied')))
                            .catch(() => onToast?.(t('orderIdCopyFailed'), 'error'));
                        } else {
                          onToast?.(t('orderIdCopyFailed'), 'error');
                        }
                      }}
                      aria-label={t('shareOrder')}
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-subtle)', padding: 0, lineHeight: 0, cursor: 'pointer' }}
                    >
                      <Icon name="paperclip" size={12} />
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>· {o.lineCount} {o.lineCount === 1 ? t('item') : t('items')}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fmtDateShort(o.createdAt)}{o.warehouse ? ' · ' + o.warehouse.short : ''} · <span style={{ color: 'var(--fg-muted)' }}>{o.status}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--pos)' }}>+{fmtUSD0(o.profit)}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 1 }}>{fmtUSD0(o.revenue)}</div>
                </div>
                <Icon name="chevronDown" size={16} style={{ color: 'var(--fg-subtle)', transition: 'transform 0.18s', transform: isOpen ? 'rotate(180deg)' : 'none' }} />
              </div>
              {isOpen && openLines && openLines.id === o.id && (
                <div className="ph-order-body">
                  {openLines.lines.map(l => (
                    <div key={l.id} className="ph-line" style={{ display: 'flex', gap: 10 }}>
                      {realScan(l.scanImageUrl) && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setLightboxUrl(l.scanImageUrl!); }}
                          title={t('aiPhotoLabel')}
                          style={{
                            width: 52, height: 52, borderRadius: 10, flexShrink: 0,
                            border: '1px solid var(--border)', overflow: 'hidden',
                            padding: 0, background: 'var(--bg-soft)', cursor: 'pointer',
                          }}
                        >
                          <img
                            src={l.scanImageUrl}
                            alt={t('aiPhotoLabel')}
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                        </button>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {l.category === 'RAM' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`}
                          {l.category === 'SSD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`}
                          {l.category === 'HDD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`}
                          {l.category === 'Other' && (l.description ?? '')}
                        </div>
                        <span className={'chip ' + statusTone(l.status) + ' dot'} style={{ fontSize: 10 }}>{l.status}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>{l.partNumber}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5 }}>
                        <span style={{ color: 'var(--fg-subtle)' }}>
                          Qty {l.qty} · {fmtUSD(l.unitCost)} {l.sellPrice != null && <>→ {fmtUSD(l.sellPrice)}</>}
                        </span>
                        {l.sellPrice != null && (
                          <span className="mono pos" style={{ fontWeight: 600, color: 'var(--pos)' }}>
                            +{fmtUSD0((l.sellPrice - l.unitCost) * l.qty)}
                          </span>
                        )}
                      </div>
                      </div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      className="btn sm"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={isCompleted(o.status)}
                      title={isCompleted(o.status) ? t('completedLocked') : t('editOrder')}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isCompleted(o.status)) {
                          navigate('/purchase-orders/' + o.id);
                          onEdit(openLines);
                        }
                      }}
                    >
                      <Icon name="edit" size={11} /> {t('edit')}
                    </button>
                  </div>
                </div>
              )}
              {isOpen && (!openLines || openLines.id !== o.id) && (
                <div className="ph-order-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Skeleton width="80%" height={13} />
                  <Skeleton width="60%" height={11} />
                  <Skeleton width="40%" height={11} />
                </div>
              )}
            </div>
          );
          });
        })()}
      </div>
      {lightboxUrl && (
        <ImageLightbox url={lightboxUrl} alt={t('aiPhotoLabel')} onClose={() => setLightboxUrl(null)} />
      )}
    </>
  );
}
