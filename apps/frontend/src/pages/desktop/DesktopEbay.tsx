import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { RouteLink } from '../../components/RouteLink';
import {
  confirmEbaySale, dismissEbaySale, endEbayListing, getEbayListing, listEbayListings, listEbaySales,
  patchEbayListing, recordEbaySale,
  type EbayCounts, type EbayEndReason, type EbayEvent, type EbayListing, type EbayListingDetail,
  type EbayListingStatus, type EbaySaleWithListing,
} from '../../lib/api';
import { useAuth } from '../../lib/auth';
import {
  EBAY_TABS, ebayTabCount, firstTabWithWork, shelfBar, shortItemId, stockShortfall, tabForStatus, type EbayTab,
} from '../../lib/ebay';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDateShort, fmtUSD } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { parseEbayListingRef } from '@recycle-erp/shared';
import { ebayListingPath, matchEbayListing, navigate, useRoute } from '../../lib/route';
import { SplitListingDialog } from './ebay/ListingRows';
import '../../styles/ebay.css';

type Toast = (msg: string, kind?: 'success' | 'error') => void;

const TAB_STATUS: Partial<Record<EbayTab, EbayListingStatus>> = { post: 'Queued', live: 'Listed', ended: 'Ended' };
const TAB_LABEL: Record<EbayTab, string> = {
  post: 'ebTabPost', confirm: 'ebTabConfirm', live: 'ebTabLive', sold: 'ebTabSold', ended: 'ebTabEnded',
};
const STATUS_CHIP: Record<EbayListingStatus, [string, string]> = {
  Queued: ['ebTabPost', 'warn'], Listed: ['ebTabLive', 'info'], Sold: ['ebTabSold', 'pos'], Ended: ['ebTabEnded', 'muted'],
};
const END_REASONS: readonly EbayEndReason[] = ['no_buyer', 'damaged', 'sold_elsewhere', 'other'];
const CONDITIONS = ['Used', 'Seller refurbished', 'New other', 'For parts'] as const;
const PAGE = 50;

type ListingLike = Pick<EbayListing, 'id' | 'title' | 'spec' | 'product' | 'photos' | 'warehouse' | 'lot'>;
const itemTitle = (l: ListingLike) => l.title || l.spec || l.product?.label || l.id;

function Thumb({ l }: { l: ListingLike }) {
  const url = l.photos[0]?.url;
  return <span className="eb-thumb">{url ? <img src={url} alt="" /> : (l.product?.category ?? '—')}</span>;
}

function StatusChip({ status }: { status: EbayListingStatus }) {
  const { t } = useT();
  const [key, tone] = STATUS_CHIP[status];
  return <span className={'chip ' + tone} style={{ fontSize: 11 }}>{t(key)}</span>;
}

/** The eBay desk: the eBay operator's whole app, and a manager's view of it. */
export function DesktopEbay({ onToast }: { onToast: Toast }) {
  const { t, locale } = useT();
  const { user } = useAuth();
  const isManager = user?.role === 'manager';
  const { path } = useRoute();
  const selId = matchEbayListing(path);

  const [tab, setTab] = useState<EbayTab | null>(null);
  const [counts, setCounts] = useState<EbayCounts | null>(null);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<EbayListing[]>([]);
  const [sales, setSales] = useState<EbaySaleWithListing[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [detail, setDetail] = useState<EbayListingDetail | null>(null);
  const refresh = useCallback(() => setReload(n => n + 1), []);

  useEffect(() => {
    const h = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(h);
  }, [search]);

  // The desk opens on the first queue with work in it; a link to one listing
  // opens on that listing's queue instead (below).
  useEffect(() => {
    let alive = true;
    listEbayListings('limit=1').then(r => {
      if (!alive) return;
      setCounts(r.counts);
      if (!selId) setTab(cur => cur ?? firstTabWithWork(r.counts));
    }).catch(handleFetchError);
    return () => { alive = false; };
    // Once per visit: the tab is the user's after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selId) { setDetail(null); return; }
    let alive = true;
    getEbayListing(selId).then(r => {
      if (!alive) return;
      setDetail(r.listing);
      setTab(cur => cur ?? tabForStatus(r.listing.status));
    }).catch(e => {
      if (!alive) return;
      navigate('/ebay');
      handleFetchError(e);
    });
    return () => { alive = false; };
  }, [selId, reload]);

  const query = (cursor: string | null) => {
    const p = new URLSearchParams();
    p.set('status', TAB_STATUS[tab!]!);
    if (q) p.set('q', q);
    p.set('limit', String(PAGE));
    if (cursor) p.set('cursor', cursor);
    return p.toString();
  };

  // Bumped per load, so a superseded load's answer never lands on the new tab.
  const gen = useRef(0);
  useEffect(() => {
    if (!tab) return;
    const g = ++gen.current;
    setLoaded(false);
    const status = TAB_STATUS[tab];
    if (status) {
      listEbayListings(query(null)).then(r => {
        if (g !== gen.current) return;
        setRows(r.rows);
        setCounts(r.counts);
        setNextCursor(r.nextCursor);
        setLoaded(true);
      }).catch(handleFetchError);
    } else {
      Promise.all([listEbaySales(tab === 'confirm' ? 'Detected' : 'Confirmed'), listEbayListings('limit=1')])
        .then(([s, c]) => {
          if (g !== gen.current) return;
          setSales(s.sales);
          setCounts(c.counts);
          setNextCursor(null);
          setLoaded(true);
        }).catch(handleFetchError);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, reload]);

  const loadMore = () => {
    if (!nextCursor || !tab) return;
    const g = gen.current;
    listEbayListings(query(nextCursor)).then(r => {
      if (g !== gen.current) return;
      setRows(prev => [...prev, ...r.rows]);
      setNextCursor(r.nextCursor);
    }).catch(handleFetchError);
  };

  const pickTab = (next: EbayTab) => {
    setTab(next);
    if (selId) navigate('/ebay');
  };
  const open = (id: string) => navigate(ebayListingPath(id));
  const close = () => navigate('/ebay');

  // Sales have no search of their own on the server: the queue is short.
  const needle = q.toLowerCase();
  const shownSales = needle
    ? sales.filter(s => [s.listingId, s.listing.title, s.listing.spec, s.ebayOrderId, s.sellOrderId]
      .some(v => v?.toLowerCase().includes(needle)))
    : sales;

  const confirm = async (s: EbaySaleWithListing) => {
    try {
      const r = await confirmEbaySale(s.id);
      onToast(t('ebToastConfirmed', { so: r.sellOrderId }));
      refresh();
    } catch (e) { handleFetchError(e); }
  };
  const dismiss = async (s: EbaySaleWithListing) => {
    try {
      await dismissEbaySale(s.id);
      onToast(t('ebToastDismissed'));
      refresh();
    } catch (e) { handleFetchError(e); }
  };

  const selectedRow = (id: string) => (selId === id ? ' selected' : '');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('ebTitle')}</h1>
          <div className="page-sub eb-head-sub">{t('ebSub')}</div>
        </div>
      </div>

      <div className="eb-tabs">
        <div role="tablist" aria-label={t('ebQueues')} style={{ display: 'contents' }}>
          {EBAY_TABS.map(k => {
            const n = counts ? ebayTabCount(k, counts) : null;
            const loud = k === 'confirm' && (n ?? 0) > 0 && tab !== k;
            return (
              <button
                key={k} type="button" role="tab" aria-selected={tab === k}
                className={'eb-tab' + (loud ? ' eb-loud' : '')} onClick={() => pickTab(k)}
              >
                <span className={'eb-dot ' + k} />
                <span>{t(TAB_LABEL[k])}</span>
                <span className="eb-tab-count">{n ?? '…'}</span>
              </button>
            );
          })}
        </div>
        <label className="eb-search">
          <span style={{ position: 'absolute', left: -9999 }}>{t('ebSearch')}</span>
          <span style={{ position: 'relative', width: '100%', maxWidth: 340 }}>
            <Icon name="search" size={13} style={{ left: 10 }} />
            <input className="input" placeholder={t('ebSearchPh')} value={search} onChange={e => setSearch(e.target.value)} />
          </span>
        </label>
      </div>

      <div className="eb-layout">
        <section className="card eb-main">
          {!tab || !loaded ? (
            <div className="eb-empty">…</div>
          ) : tab === 'confirm' ? (
            <div className="eb-cards">
              {shownSales.length === 0 && <p className="eb-empty" style={{ padding: 4 }}>{t('ebConfirmEmpty')}</p>}
              {shownSales.map(s => (
                <article key={s.id} className="eb-card">
                  <header>
                    <span>{t('ebOrder')} <span className="mono" style={{ fontWeight: 600 }}>{s.ebayOrderId ?? '—'}</span></span>
                    <span style={{ color: 'var(--warn-strong)' }}>{fmtDateShort(s.soldAt, locale)}</span>
                  </header>
                  <div className="eb-card-cols">
                    <div>
                      <span className="eb-label">{t('ebFromEbay')}</span>
                      <span style={{ fontWeight: 500 }}>{s.listing.title || s.listing.spec || s.listingId}</span>
                      <span className="mono">{s.qty} × {fmtUSD(s.unitPrice, locale)}</span>
                    </div>
                    <div>
                      <span className="eb-label">{t('ebWillRecord')}</span>
                      <span>
                        <button type="button" className="eb-sib" onClick={() => open(s.listingId)} style={{ marginRight: 6 }}>
                          <span className="mono" style={{ fontWeight: 600 }}>{s.listingId}</span>
                        </button>
                        {t('ebWillRecordLine', { n: s.qty, left: Math.max(0, s.listing.remaining - s.qty) })}
                      </span>
                      <span style={{ color: 'var(--fg-muted)' }}>{t('ebWillRecordSo')}</span>
                    </div>
                  </div>
                  <footer>
                    <button type="button" className="btn" onClick={() => dismiss(s)}>{t('ebNotThisListing')}</button>
                    <button type="button" className="btn accent" onClick={() => confirm(s)}>{t('ebConfirmSale')}</button>
                  </footer>
                </article>
              ))}
            </div>
          ) : tab === 'sold' ? (
            shownSales.length === 0 ? <div className="eb-empty">{t('ebSoldEmpty')}</div> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('ebColSold')}</th><th>{t('ebColItem')}</th><th>{t('ebColListing')}</th>
                    <th style={{ textAlign: 'right' }}>{t('ebColQty')}</th>
                    <th style={{ textAlign: 'right' }}>{t('ebColPrice')}</th><th>{t('ebColSellOrder')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownSales.map(s => (
                    <tr key={s.id} className={'eb-row' + selectedRow(s.listingId)} onClick={() => open(s.listingId)}>
                      <td style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{fmtDateShort(s.soldAt, locale)}</td>
                      <td style={{ fontWeight: 500 }}>{s.listing.title || s.listing.spec || s.listingId}</td>
                      <td className="mono" style={{ fontWeight: 600 }}>{s.listingId}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{s.qty}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{fmtUSD(s.unitPrice, locale)}</td>
                      <td onClick={e => e.stopPropagation()}>
                        {isManager && s.sellOrderId
                          ? <RouteLink to={'/sell-orders/' + s.sellOrderId} className="mono rec-link">{s.sellOrderId}</RouteLink>
                          : <span style={{ color: 'var(--fg-muted)' }}>{t('ebRecorded')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : rows.length === 0 ? (
            <div className="eb-empty">{t(q ? 'ebNoMatch' : tab === 'post' ? 'ebPostEmpty' : tab === 'live' ? 'ebLiveEmpty' : 'ebEndedEmpty')}</div>
          ) : (
            <>
              <table className="data-table">
                <thead>
                  {tab === 'post' ? (
                    <tr>
                      <th>{t('ebColItem')}</th><th>{t('ebColListing')}</th>
                      <th style={{ textAlign: 'right' }}>{t('ebColQty')}</th>
                      <th style={{ textAlign: 'right' }}>{t('ebColAsking')}</th>
                      <th>{t('ebColSentBy')}</th><th>{t('ebColWaiting')}</th>
                    </tr>
                  ) : tab === 'live' ? (
                    <tr>
                      <th>{t('ebColItem')}</th><th>{t('ebColListing')}</th>
                      <th style={{ textAlign: 'right' }}>{t('ebColLeft')}</th>
                      <th style={{ textAlign: 'right' }}>{t('ebColPrice')}</th>
                      <th>{t('ebColEbayItem')}</th><th style={{ minWidth: 150 }}>{t('ebColShelf')}</th>
                    </tr>
                  ) : (
                    <tr>
                      <th>{t('ebColEnded')}</th><th>{t('ebColItem')}</th><th>{t('ebColListing')}</th>
                      <th>{t('ebColReason')}</th><th style={{ textAlign: 'right' }}>{t('ebColBack')}</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {rows.map(r => {
                    const item = (
                      <div className="eb-item">
                        <Thumb l={r} />
                        <span className="eb-item-text">
                          <span className="eb-item-title" title={itemTitle(r)}>{itemTitle(r)}</span>
                          <span className="eb-item-sub mono">
                            {tab === 'live'
                              ? t('ebPartIn', { part: r.product?.partNumber ?? '—', wh: r.warehouse?.short ?? '—' })
                              : t('ebPartLot', { part: r.product?.partNumber ?? '—', lot: r.lot ? `${r.lot.orderId} #${r.lot.productNo}` : '—' })}
                          </span>
                        </span>
                      </div>
                    );
                    if (tab === 'post') {
                      return (
                        <tr key={r.id} className={'eb-row' + selectedRow(r.id)} onClick={() => open(r.id)}>
                          <td>{item}</td>
                          <td className="mono" style={{ fontWeight: 600 }}>{r.id}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{r.qty}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{fmtUSD(r.listPrice, locale)}</td>
                          <td>{r.createdBy?.name ?? '—'}</td>
                          <td style={{ color: 'var(--fg-muted)' }}>
                            {r.daysWaiting ? t('ebDays', { n: r.daysWaiting }) : t('ebToday')}
                          </td>
                        </tr>
                      );
                    }
                    if (tab === 'live') {
                      const bar = shelfBar(r.daysListed ?? 0);
                      return (
                        <tr key={r.id} className={'eb-row' + selectedRow(r.id)} onClick={() => open(r.id)}>
                          <td>{item}</td>
                          <td className="mono" style={{ fontWeight: 600 }}>{r.id}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{t('ebLeftOf', { n: r.remaining, total: r.qty })}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>{fmtUSD(r.listPrice, locale)}</td>
                          <td onClick={e => e.stopPropagation()}>
                            {r.ebay.itemId
                              ? <a className="mono" href={r.ebay.url ?? undefined} target="_blank" rel="noreferrer">{shortItemId(r.ebay.itemId)}</a>
                              : '—'}
                          </td>
                          <td>
                            <div className={'eb-shelf' + (bar.over ? ' over' : '')} title={t('ebShelfTip')}>
                              <div className="eb-shelf-track"><div className="eb-shelf-fill" style={{ width: bar.pct + '%' }} /></div>
                              <span className="eb-shelf-days mono">{t('ebDaysShort', { n: r.daysListed ?? 0 })}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={r.id} className={'eb-row' + selectedRow(r.id)} onClick={() => open(r.id)}>
                        <td style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{r.endedAt ? fmtDateShort(r.endedAt, locale) : '—'}</td>
                        <td>{item}</td>
                        <td className="mono" style={{ fontWeight: 600 }}>{r.id}</td>
                        <td>{r.endReason ? t('ebReason_' + r.endReason) : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{r.remaining}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {nextCursor && (
                <div className="eb-more"><button type="button" className="btn sm" onClick={loadMore}>{t('ebLoadMore')}</button></div>
              )}
            </>
          )}
        </section>

        {detail && selId === detail.id && (
          <ListingPanel
            key={detail.id + ':' + detail.updatedAt}
            l={detail}
            isManager={isManager}
            onClose={close}
            onOpen={open}
            onDone={(msg, closePanel) => {
              onToast(msg);
              if (closePanel) close();
              refresh();
            }}
          />
        )}
      </div>
    </>
  );
}

// ── The listing panel ──────────────────────────────────────────────────────

function ListingPanel({ l, isManager, onClose, onOpen, onDone }: {
  l: EbayListingDetail;
  isManager: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onDone: (msg: string, closePanel?: boolean) => void;
}) {
  const { t, locale } = useT();
  const [mode, setMode] = useState<'sold' | 'end' | null>(null);
  const [busy, setBusy] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [title, setTitle] = useState(l.title ?? '');
  const [condition, setCondition] = useState(l.condition ?? '');
  const [price, setPrice] = useState(l.listPrice.toFixed(2));
  const [linkText, setLinkText] = useState('');
  const [editingLink, setEditingLink] = useState(false);
  const [soldQty, setSoldQty] = useState('1');
  const [soldPrice, setSoldPrice] = useState(l.listPrice.toFixed(2));
  const [orderNo, setOrderNo] = useState('');
  const [reason, setReason] = useState<EbayEndReason>('no_buyer');

  const run = async (fn: () => Promise<string>, closePanel = false) => {
    if (busy) return;
    setBusy(true);
    try {
      onDone(await fn(), closePanel);
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };

  const priceOk = price.trim() !== '' && Number.isFinite(Number(price)) && Number(price) >= 0;
  const detailsDirty = (title.trim() || null) !== l.title || (condition || null) !== l.condition
    || (priceOk && Number(price) !== l.listPrice);
  const saveDetails = () => run(async () => {
    await patchEbayListing(l.id, {
      title: title.trim() || null, condition: condition || null, ...(priceOk ? { listPrice: Number(price) } : {}),
    });
    return t('ebToastSaved');
  });
  const savePrice = () => run(async () => {
    await patchEbayListing(l.id, { listPrice: Number(price) });
    return t('ebToastPrice');
  });
  // A pasted link or a bare item number; the server reads it the same way.
  const linkRef = parseEbayListingRef(linkText);
  const linkError = linkText.trim() && 'error' in linkRef ? t('ebLinkErr_' + linkRef.error) : null;
  const addLink = () => run(async () => {
    await patchEbayListing(l.id, { ebayUrl: linkText.trim() });
    return t('ebToastLinked');
  }, true);
  const saveLink = () => run(async () => {
    await patchEbayListing(l.id, { ebayUrl: linkText.trim() });
    return t('ebToastLinkSaved');
  });
  const linkField = (button: string, onSave: () => void) => (
    <>
      <span style={{ display: 'flex', gap: 8 }}>
        <input
          className="input mono" aria-label={t('ebLinkLabel')} placeholder="https://www.ebay.com/itm/256712340987"
          value={linkText} onChange={e => setLinkText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !('error' in linkRef)) onSave(); }}
        />
        <button type="button" className="btn" disabled={busy || 'error' in linkRef} onClick={onSave}>{button}</button>
      </span>
      <span style={{ fontSize: 11.5, color: linkError ? 'var(--neg)' : 'var(--fg-subtle)' }}>{linkError ?? t('ebLinkHint')}</span>
    </>
  );
  const cancelQueued = () => run(async () => {
    await endEbayListing(l.id, 'cancelled');
    return t('ebToastCancelled');
  }, true);
  const qtyOk = /^\d+$/.test(soldQty) && Number(soldQty) >= 1 && Number(soldQty) <= l.remaining;
  const soldPriceOk = soldPrice.trim() !== '' && Number.isFinite(Number(soldPrice)) && Number(soldPrice) >= 0;
  const recordSale = () => run(async () => {
    const r = await recordEbaySale(l.id, {
      qty: Number(soldQty), unitPrice: Number(soldPrice), ebayOrderId: orderNo.trim() || null,
    });
    return t('ebToastSale', { so: r.sellOrderId });
  });
  const end = () => run(async () => {
    const r = await endEbayListing(l.id, reason);
    return t('ebToastEnded', { n: r.returnedQty });
  }, true);

  const stock = l.lot?.stock ?? null;
  const short = stock ? stockShortfall(stock) : 0;
  const siblings = l.lot?.otherListings ?? [];
  const lotRef = l.lot ? `${l.lot.orderId} #${l.lot.productNo}` : '—';
  const history = l.events.map(e => ({ e, text: eventText(e, t, locale) })).filter(h => h.text !== null).reverse();

  return (
    <aside className="eb-panel" aria-label={t('ebPanel')}>
      <div className="eb-panel-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>{l.id}</span>
            <StatusChip status={l.status} />
          </div>
          <span className="eb-panel-title">{itemTitle(l)}</span>
          <span className="mono eb-item-sub">
            {t('ebPartIn', { part: l.product?.partNumber ?? '—', wh: l.warehouse?.short ?? '—' })}
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12.5, color: 'var(--fg-muted)' }}>
            <span>
              {t('ebFromLot')}{' '}
              {isManager && l.lot
                ? <RouteLink to={'/inventory/' + l.lot.inventoryId} className="mono rec-link">{lotRef}</RouteLink>
                : <span className="mono">{lotRef}</span>}
              {siblings.length > 0 && t('ebAlsoAs')}
            </span>
            {siblings.map(x => (
              <button key={x.id} type="button" className="eb-sib" title={x.spec ?? x.id} onClick={() => onOpen(x.id)}>
                <span className="mono" style={{ fontWeight: 600, fontSize: 11.5 }}>{x.id}</span> {t(STATUS_CHIP[x.status][0])}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="btn icon sm" aria-label={t('close')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>

      {l.status === 'Queued' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {l.photos.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="eb-label">{t('ebPhotos')}</span>
              <div className="eb-photos">{l.photos.slice(0, 12).map(p => <img key={p.id} src={p.url} alt="" />)}</div>
            </div>
          )}
          <label className="eb-field">{t('ebTitleOnEbay')}
            <input className="input" value={title} placeholder={itemTitle(l)} onChange={e => setTitle(e.target.value)} />
          </label>
          <div className="eb-grid3">
            <label className="eb-field">{t('ebCondition')}
              <select className="select" value={condition} onChange={e => setCondition(e.target.value)}>
                <option value="">—</option>
                {CONDITIONS.map(c => <option key={c} value={c}>{t('ebCond_' + c.replace(/ /g, '_'))}</option>)}
              </select>
            </label>
            <label className="eb-field">{t('ebPriceUsd')}
              <input className="input mono" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} />
            </label>
            <label className="eb-field">{t('ebColQty')}
              <input className="input mono" value={l.qty} readOnly title={t('ebQtyBySplit')} />
            </label>
          </div>
          {l.notes && (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-muted)' }}>
              {t('ebNoteFrom', { who: l.createdBy?.name ?? '—' })} {l.notes}
            </p>
          )}
          {detailsDirty && (
            <button type="button" className="btn" disabled={busy || !priceOk} onClick={saveDetails}>{t('ebSaveDetails')}</button>
          )}
          <button type="button" className="btn accent" disabled title={t('ebPublishLater')} style={{ height: 40, justifyContent: 'center' }}>
            {t('ebPublish')}
          </button>
          <button type="button" className="btn" style={{ justifyContent: 'center' }} onClick={() => setSplitting(true)}>
            {t('ebSplit')}
          </button>
          <label className="eb-field">{t('ebLinkSummary')}
            {linkField(t('ebAddLink'), addLink)}
          </label>
          {isManager && (
            <button type="button" className="btn eb-neg" style={{ justifyContent: 'center' }} disabled={busy} onClick={cancelQueued}>
              {t('ebCancelQueued')}
            </button>
          )}
        </div>
      )}

      {l.status === 'Listed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px', fontSize: 13 }}>
            <span>{t('ebLeftOfLong', { n: l.remaining, total: l.qty })}</span>
            <span>{t('ebEach', { price: fmtUSD(l.listPrice, locale) })}</span>
            <span>{t('ebDaysOnEbay', { n: l.daysListed ?? 0 })}</span>
          </div>
          <div className="eb-field">{t('ebLinkLabel')}
            {editingLink ? (
              <>
                {linkField(t('ebSaveLink'), saveLink)}
                <span><button type="button" className="btn ghost sm" onClick={() => setEditingLink(false)}>{t('cancel')}</button></span>
              </>
            ) : (
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                {l.ebay.url
                  ? <a className="mono" href={l.ebay.url} target="_blank" rel="noreferrer"
                      style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                      {l.ebay.url} <Icon name="arrow" size={11} />
                    </a>
                  : <span style={{ color: 'var(--fg-subtle)' }}>—</span>}
                <button type="button" className="btn sm" style={{ marginLeft: 'auto' }}
                  onClick={() => { setLinkText(l.ebay.url ?? ''); setEditingLink(true); }}>
                  <Icon name="edit" size={12} /> {t('ebEditLink')}
                </button>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className={'btn' + (mode === 'sold' ? ' primary' : ' accent')} style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => setMode(mode === 'sold' ? null : 'sold')}>{t('ebMarkSold')}</button>
            <button type="button" className="btn" style={{ flex: 1, justifyContent: 'center' }}
              onClick={() => setMode(mode === 'end' ? null : 'end')}>{t('ebEndNotSold')}</button>
          </div>
          {mode === 'sold' && (
            <div className="eb-form">
              <div className="eb-grid2">
                <label className="eb-field">{t('ebQtySold')}
                  <input className="input mono" inputMode="numeric" value={soldQty} onChange={e => setSoldQty(e.target.value)} />
                </label>
                <label className="eb-field">{t('ebPriceEach')}
                  <input className="input mono" inputMode="decimal" value={soldPrice} onChange={e => setSoldPrice(e.target.value)} />
                </label>
                <label className="eb-field" style={{ gridColumn: '1 / -1' }}>{t('ebOrderNo')}
                  <input className="input mono" placeholder="12-04129-88231" value={orderNo} onChange={e => setOrderNo(e.target.value)} />
                </label>
              </div>
              <button type="button" className="btn accent" style={{ justifyContent: 'center' }}
                disabled={busy || !qtyOk || !soldPriceOk} onClick={recordSale}>{t('ebRecordSale')}</button>
            </div>
          )}
          {mode === 'end' && (
            <fieldset className="eb-end">
              <legend>{t('ebWhyEnd')}</legend>
              {END_REASONS.map(r => (
                <label key={r}>
                  <input type="radio" name="eb-end" checked={reason === r} onChange={() => setReason(r)} /> {t('ebReason_' + r)}
                </label>
              ))}
              <p style={{ margin: '4px 0 0' }}>{t('ebEndGoesBack', { n: l.remaining })}</p>
              <button type="button" className="btn eb-neg" style={{ justifyContent: 'center' }} disabled={busy} onClick={end}>
                {t('ebEndListing')}
              </button>
            </fieldset>
          )}
          <label className="eb-field">{t('ebPrice')}
            <span style={{ display: 'flex', gap: 8 }}>
              <input className="input mono" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} />
              <button type="button" className="btn" disabled={busy || !priceOk || Number(price) === l.listPrice} onClick={savePrice}>
                {t('ebSavePrice')}
              </button>
            </span>
          </label>
        </div>
      )}

      {(l.status === 'Sold' || l.status === 'Ended') && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px', fontSize: 13 }}>
          <span>{t('ebSoldOf', { n: l.soldQty, total: l.qty })}</span>
          {l.status === 'Ended' && l.endReason && <span>{t('ebReason_' + l.endReason)}</span>}
          {l.ebay.url && <a href={l.ebay.url} target="_blank" rel="noreferrer">{t('ebViewOnEbay')}</a>}
        </div>
      )}

      {l.sales.some(s => s.status === 'Confirmed') && (
        <div className="eb-panel-section">
          <span className="eb-label">{t('ebSales')}</span>
          {l.sales.filter(s => s.status === 'Confirmed').map(s => (
            <div key={s.id} className="eb-hist">
              <span>{fmtDateShort(s.soldAt, locale)}</span>
              <span>
                <span className="mono">{s.qty} × {fmtUSD(s.unitPrice, locale)}</span>
                {s.ebayOrderId && <span className="mono" style={{ color: 'var(--fg-muted)' }}> · #{s.ebayOrderId}</span>}
                {isManager && s.sellOrderId && (
                  <> · <RouteLink to={'/sell-orders/' + s.sellOrderId} className="mono rec-link">{s.sellOrderId}</RouteLink></>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {stock && (
        <div className="eb-panel-section">
          <span className="eb-label">{t('ebStockCheck', { lot: lotRef })}</span>
          <div className="eb-stock">
            <div><span className="eb-stock-n">{stock.onHand}</span><span className="eb-label">{t('ebOnHand')}</span></div>
            <div><span className="eb-stock-n">{stock.heldForEbay}</span><span className="eb-label">{t('ebHeldForEbay')}</span></div>
            <div><span className="eb-stock-n">{stock.sellable}</span><span className="eb-label">{t('ebStillSellable')}</span></div>
          </div>
          {stock.heldForSellOrders > 0 && (
            <span className="eb-label">{t('ebHeldForSo', { n: stock.heldForSellOrders })}</span>
          )}
          <div className={'eb-check' + (short ? ' off' : '')}>
            {short ? t('ebCheckOff', { n: short }) : t('ebCheckOk')}
          </div>
        </div>
      )}

      <div className="eb-panel-section" style={{ gap: 8 }}>
        <span className="eb-label">{t('ebHistory')}</span>
        {history.map(({ e, text }) => (
          <div key={e.id} className="eb-hist"><span>{fmtDateShort(e.at, locale)}</span><span>{text}</span></div>
        ))}
      </div>

      {splitting && (
        <SplitListingDialog
          listing={l}
          onClose={() => setSplitting(false)}
          onSplit={ids => { setSplitting(false); onDone(t('ebToastSplit', { ids: [l.id, ...ids].join(', ') })); }}
        />
      )}
    </aside>
  );
}

type T = (key: string, vars?: Record<string, string | number>) => string;

// One history line per event; an edit that only carried an item link says
// nothing the 'listed' event beside it doesn't.
function eventText(e: EbayEvent, t: T, locale: string): string | null {
  const who = e.actor?.name ?? '—';
  const d = e.detail as Record<string, unknown>;
  const money = (v: unknown) => fmtUSD(Number(v), locale);
  switch (e.kind) {
    case 'created':
      return d.splitFrom
        ? t('ebEvCreatedSplit', { from: String(d.splitFrom), who, n: Number(d.qty), price: money(d.listPrice) })
        : t('ebEvCreated', { who, n: Number(d.qty), price: money(d.listPrice) });
    case 'edited': {
      if (Array.isArray(d.split)) return t('ebEvSplit', { ids: (d.split as string[]).join(', '), who });
      const changes = (d.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const keys = Object.keys(changes);
      if (keys.every(k => k === 'ebay_item_id' || k === 'ebay_url')) {
        // The first link is the 'listed' event's to tell; a later one is a fix.
        const item = changes.ebay_item_id;
        return item && item.from ? t('ebEvLinkChanged', { item: String(item.to), who }) : null;
      }
      if (keys.length === 1 && keys[0] === 'list_price') {
        const c = (d.changes as Record<string, { to: unknown }>).list_price;
        return t('ebEvPrice', { price: money(c.to), who });
      }
      return t('ebEvEdited', { who });
    }
    case 'listed':
      return e.from === 'Sold' ? t('ebEvRelisted') : t('ebEvListed', { item: String(d.itemId ?? '—'), who });
    case 'sale_detected': return t('ebEvSaleDetected', { n: Number(d.qty ?? 0) });
    case 'sale_confirmed': return t('ebEvSaleConfirmed', { n: Number(d.qty), so: String(d.sellOrderId), who });
    case 'sale_dismissed': return t('ebEvSaleDismissed', { n: Number(d.qty ?? 0), who });
    case 'sold': return t('ebEvSold');
    case 'ended': return t('ebEvEnded', { who, reason: t('ebReason_' + String(d.reason)), n: Number(d.returnedQty ?? 0) });
  }
}
