import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { useEffectiveUser } from '../lib/tweaks';
import { shareOrCopy } from '../lib/shareOrCopy';
import { fmtUSD0, fmtDateShort } from '../lib/format';
import { profitTone, signedUSD0 } from '../lib/orderPresentation';
import { ORDER_STATUSES, PO_STATUSES, isCompleted, isClosedBook, statusTone } from '../lib/status';
import { categoryFilterOptions } from '../lib/lookups';
import { usePhScrolled } from '../lib/usePhScrolled';
import { navigate } from '../lib/route';
import type { OrderSummary } from '../lib/types';
import { PhoneListSkeleton } from '../components/Skeleton';
import { OrderCategoryChips } from '../components/OrderCategoryChips';


// Stable hue (0–359) from an id, so a given warehouse/owner always paints the
// same colour across the list. Feeds the `--h` custom prop on the meta tags.
const hueFromId = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
};

type Props = {
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function Orders({ onToast }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  // Backend scopes the list by effectiveRole; track it here so toggling the
  // manager's role-preview tweak re-fetches instead of leaving stale rows.
  const effRole = useEffectiveUser()?.role;
  const [filter, setFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | string>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    // Managers see the whole org's POs here, same as desktop; everyone else
    // stays scoped to their own. The camera capture flow is unaffected — its
    // draft picker pins mine=true itself (MobileApp.startSubmit), so scanned
    // items always land on the manager's own PO.
    const isManager = effRole === 'manager';
    if (!isManager) params.set('mine', 'true');
    if (filter !== 'all') params.set('category', filter);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    // Org-wide, the default view would drown in finished POs — hide Done and
    // Sold until their chips ask for them explicitly.
    else if (isManager) { params.append('excludeStatus', 'Done'); params.append('excludeStatus', 'Sold'); }
    if (showArchived) params.set('includeArchived', 'true');
    api.get<{ orders: OrderSummary[] }>(`/api/orders?${params}`)
      .then(r => { if (alive) setOrders(r.orders); })
      .catch(handleFetchError)
      .finally(() => { if (alive) setLoadedOnce(true); });
    return () => { alive = false; };
  }, [filter, statusFilter, showArchived, effRole]);

  // The all-status view hides Done POs — the "Done" chip is the explicit way
  // to see them. A /purchase-orders/:id link opens the PO's own screen (the
  // shell drives that from the URL), so the list needs no exception for it.
  const visibleOrders = useMemo(
    () => statusFilter === 'all' ? orders.filter(o => !isCompleted(o.status)) : orders,
    [orders, statusFilter],
  );

  return (
    <>
      <PhHeader
        title={t('ordersHeading')}
        sub={t('ordersSubmitted', { n: visibleOrders.length })}
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
          {(effRole === 'manager' ? PO_STATUSES : ORDER_STATUSES).map(s => (
            <button key={s} className={'ph-chip-btn ' + (statusFilter === s ? 'active' : '')} onClick={() => setStatusFilter(s)}>
              {s}
            </button>
          ))}
          <button
            className={'ph-chip-btn ' + (showArchived ? 'active' : '')}
            onClick={() => setShowArchived(v => !v)}
            title={t('includeArchivedHint')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Icon name="box" size={11} />
            {t('archivedChip')}
          </button>
        </div>
        {!loadedOnce && <PhoneListSkeleton rows={5} variant="order" />}
        {loadedOnce && visibleOrders.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
            {t('noOrdersMatch')}
          </div>
        )}

        {loadedOnce && (() => {
          const q = searchQ.trim().toLowerCase();
          const filtered = q
            ? visibleOrders.filter(o =>
                o.id.toLowerCase().includes(q) ||
                (o.warehouse?.short ?? '').toLowerCase().includes(q) ||
                (o.warehouse?.region ?? '').toLowerCase().includes(q) ||
                o.userName.toLowerCase().includes(q)
              )
            : visibleOrders;
          return filtered.slice(0, 30).map(o => {
          const unpriced = o.unpricedLineCount ?? 0;
          // Rows open the PO rather than expanding: an 18-line PO unfolded
          // taller than the phone, and the edit button sat at the bottom of
          // it. The icon on the right says whether the PO is still the
          // purchaser's to change before they open it.
          const locked = isClosedBook(o.status) || !!o.archivedAt;
          const open = () => navigate('/purchase-orders/' + o.id);
          return (
            <div key={o.id} className="ph-order" style={o.archivedAt ? { opacity: 0.6 } : undefined}>
              <div className="ph-order-head" onClick={open} style={{ cursor: 'pointer' }}>
                <OrderCategoryChips categories={o.categories} max={1} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{o.id}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        shareOrCopy({
                          url: `${location.origin}${location.pathname}#/purchase-orders/${o.id}`,
                          title: t('shareOrder'),
                          copiedMsg: t('orderIdCopied'),
                          failedMsg: t('orderIdCopyFailed'),
                          onToast,
                        });
                      }}
                      aria-label={t('shareOrder')}
                      style={{ background: 'transparent', border: 'none', color: 'var(--fg-subtle)', padding: 0, lineHeight: 0, cursor: 'pointer' }}
                    >
                      <Icon name="paperclip" size={12} />
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>· {o.lineCount} {o.lineCount === 1 ? t('item') : t('items')}</span>
                    {o.archivedAt && (
                      <span className="chip muted" style={{ fontSize: 9.5, padding: '1px 5px', lineHeight: 1.3 }}>
                        archived
                      </span>
                    )}
                  </div>
                  <div className="ph-meta-tags">
                    {o.warehouse && (
                      <span
                        className="ph-tag-wh"
                        style={{ ['--h' as string]: hueFromId(o.warehouse.id) }}
                        title={o.warehouse.region ? `${o.warehouse.short} · ${o.warehouse.region}` : o.warehouse.short}
                      >
                        <Icon name="warehouse" size={9} />
                        <span className="ph-tag-wh-label">{o.warehouse.short}</span>
                      </span>
                    )}
                    <span className={'chip ' + statusTone(o.status) + ' dot'}>{o.status}</span>
                    <span
                      className="ph-owner-coin"
                      style={{ ['--h' as string]: hueFromId(o.userId) }}
                      title={o.userName}
                    >
                      {o.userInitials}
                    </span>
                    <span className="ph-meta-date">{fmtDateShort(o.createdAt, locale)}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="mono" style={{
                    fontSize: 13, fontWeight: 600,
                    // Through the shared rule, not a second `< 0`: the desktop
                    // table reads it as a class, the phone as a variable, and
                    // what counts as a loss has to be decided in one place.
                    color: `var(--${profitTone(o.profit)})`,
                  }}>{signedUSD0(o.profit, locale)}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 1 }}>{fmtUSD0(o.revenue, locale)}</div>
                  {/* What the units actually earned, once any have — the
                      figure above stays the projection. Managers only. */}
                  {effRole === 'manager' && o.realized && (
                    <div className="mono" style={{ fontSize: 10.5, marginTop: 1, color: `var(--${profitTone(o.realized.profit)})` }}>
                      {t('realizedShort')} {signedUSD0(o.realized.profit, locale)}
                    </div>
                  )}
                  {/* Revenue counts priced lines only, so a PO nobody has
                      priced reads $0 against a real cost. Say why. */}
                  {unpriced > 0 && (
                    <div
                      style={{ fontSize: 10, color: 'var(--warn)', marginTop: 1 }}
                      title={t('unpricedRevenueHint', { n: unpriced, total: o.lineCount })}
                    >
                      {t('grpUnpriced', { n: unpriced })}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="ph-icon-btn"
                  onClick={(e) => { e.stopPropagation(); open(); }}
                  aria-label={locked ? t('viewOrder') : t('editOrder')}
                  // Compact and borderless: it sits where the chevron was, and
                  // the meta row to its left is already fighting for width.
                  style={{ width: 30, height: 30, marginRight: -4, border: 'none', background: 'var(--bg-soft)', color: locked ? 'var(--fg-subtle)' : 'var(--fg)' }}
                >
                  <Icon name={locked ? 'eye' : 'edit'} size={14} />
                </button>
              </div>
            </div>
          );
          });
        })()}
      </div>
    </>
  );
}
