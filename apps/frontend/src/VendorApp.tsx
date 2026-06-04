import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from './lib/i18n';
import { Icon, type IconName } from './components/Icon';
import { ImageLightbox } from './components/ImageLightbox';
import { PhHeader } from './components/PhHeader';
import { PhoneListSkeleton, TableSkeleton } from './components/Skeleton';
import { usePhScrolled } from './lib/usePhScrolled';
import {
  type CatalogItem, type BasketLine, itemLabel, basketTotal, previewUrl,
} from './lib/vendor';
import {
  type AttrSpec, type AttrFilters, attrSpecsFor, sortAttrValues,
  filterCatalogItems, computeFacets,
} from './lib/vendorCatalogFilter';
import { fmtMoney } from './lib/format';

type Tab = 'browse' | 'mine';
type T = (k: string, p?: Record<string, string | number>) => string;
type Currency = 'USD' | 'CNY';

// Stable references so the browse useMemo deps don't churn every render.
const EMPTY_ATTRS: AttrFilters = {};
const EMPTY_FACETS: Record<string, Record<string, number>> = {};

type BidLine = {
  bid_line_id?: string;
  label: string; offeredQty: number; offeredUnitPrice: number;
  status: string; acceptedUnitPrice: number | null;
};
type Bid = { id: string; status: string; createdAt: string; lines: BidLine[] };

function catThumb(category: string): IconName {
  return category === 'RAM' ? 'chip'
    : category === 'SSD' || category === 'HDD' ? 'drive'
    : 'box';
}

// Square preview tile.  Shows the line's own scan when present; otherwise
// borrows from any sibling line that shares the same part_number (backend
// resolves the fallback). Falls back to a category icon when neither exists.
function ItemThumb({ it, size, onZoom }: {
  it: CatalogItem; size: number; onZoom?: (url: string) => void;
}) {
  const url = previewUrl(it);
  const radius = Math.round(size * 0.27);
  if (url) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onZoom?.(url); }}
        title={itemLabel(it)}
        style={{
          width: size, height: size, borderRadius: radius, flexShrink: 0,
          border: '1px solid var(--border)', overflow: 'hidden',
          padding: 0, background: 'var(--bg-soft)',
          cursor: onZoom ? 'zoom-in' : 'default',
        }}
      >
        <img
          src={url}
          alt={itemLabel(it)}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </button>
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: radius, flexShrink: 0,
      background: 'var(--bg-soft)', border: '1px solid var(--border)',
      display: 'grid', placeItems: 'center', color: 'var(--fg-muted)',
    }}>
      <Icon name={catThumb(it.category)} size={Math.round(size * 0.5)} />
    </div>
  );
}

function offerTone(status: string): string {
  return status === 'accepted' ? 'pos'
    : status === 'declined' ? 'neg'
    : 'accent';
}

async function postBid(
  base: string, basket: BasketLine[], name: string, note: string,
  currency: Currency, t: T,
): Promise<{ ok: true } | { ok: false; msg: string }> {
  const r = await fetch(`${base}/bids`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contactName: name, note, currency,
      lines: basket.map(l => ({ inventoryId: l.inventoryId, qty: l.qty, unitPrice: l.unitPrice })),
    }),
  });
  if (r.ok) return { ok: true };
  const body: { error?: string; unavailable?: string[] } =
    await r.json().catch(() => ({}));
  if (r.status === 409 && Array.isArray(body.unavailable) && body.unavailable.length) {
    const labels = body.unavailable.map(id =>
      basket.find(l => l.inventoryId === id)?.label ?? id);
    return { ok: false, msg: `${t('vendorUnavailableSome')}: ${labels.join(', ')}` };
  }
  return { ok: false, msg: body.error ?? 'Submit failed' };
}

function useMyOffers(base: string) {
  const [bids, setBids] = useState<Bid[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);
  const [key, setKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${base}/bids`);
        if (cancelled) return;
        if (!r.ok) { setErr(true); return; }
        setErr(false);
        setBids((await r.json()).bids);
      } catch {
        if (!cancelled) setErr(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [base, key]);
  return {
    bids, loaded, err,
    reload: () => { setLoaded(false); setKey(k => k + 1); },
  };
}

type VM = {
  t: T;
  base: string;
  me: { customer: { name: string }; label: string | null } | null;
  groups: { category: string; items: CatalogItem[] }[];
  filteredGroups: { category: string; items: CatalogItem[] }[];
  categories: string[];
  catFilter: string;
  setCatFilter: (c: string) => void;
  search: string;
  setSearch: (s: string) => void;
  attrSpecs: AttrSpec[];
  facets: Record<string, Record<string, number>>;
  attrFilters: AttrFilters;
  toggleAttr: (key: string, value: string) => void;
  clearAttrs: () => void;
  activeAttrCount: number;
  attrPanelOpen: boolean;
  setAttrPanelOpen: (v: boolean) => void;
  itemCount: number;
  shownCount: number;
  loadedOnce: boolean;
  basket: BasketLine[];
  byId: Map<string, BasketLine>;
  addToBasket: (it: CatalogItem, qty: number, price: number) => void;
  removeFromBasket: (id: string) => void;
  tab: Tab;
  setTab: (x: Tab) => void;
  review: boolean;
  setReview: (v: boolean) => void;
  clearBasket: () => void;
  currency: Currency;
  setCurrency: (c: Currency) => void;
  fxUsdCny: number | null;
  fxFetchedAt: string | null;
};

export function VendorApp({ token, isPhone }: { token: string; isPhone: boolean }) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('browse');
  const [me, setMe] = useState<VM['me']>(null);
  const [groups, setGroups] = useState<VM['groups']>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [errored, setErrored] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [review, setReview] = useState(false);
  const [catFilter, setCatFilter] = useState('all');
  const [search, setSearch] = useState('');
  // Attribute filters are kept per category so switching tabs doesn't drag a
  // RAM speed filter onto SSDs; mirrors the desktop inventory page.
  const [attrFiltersByCat, setAttrFiltersByCat] = useState<Record<string, AttrFilters>>({});
  const [attrPanelOpen, setAttrPanelOpen] = useState(false);
  const [currency, setCurrency] = useState<Currency>('USD');
  const [fxUsdCny, setFxUsdCny] = useState<number | null>(null);
  const [fxFetchedAt, setFxFetchedAt] = useState<string | null>(null);

  const base = `/api/public/vendor/${encodeURIComponent(token)}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await fetch(`${base}/me`);
        if (cancelled) return;
        if (m.status === 404) { setNotFound(true); return; }
        if (!m.ok) { setErrored(true); return; }
        setMe(await m.json());
        const cat = await fetch(`${base}/catalog`);
        if (cancelled) return;
        if (cat.ok) setGroups((await cat.json()).groups);
      } catch {
        if (!cancelled) setErrored(true);
      } finally {
        if (!cancelled) setLoadedOnce(true);
      }
    })();
    return () => { cancelled = true; };
  }, [base, reloadKey]);

  // Cache the USD→CNY rate per session: only fetch when the picker first
  // flips to CNY, and never re-fetch after that within this mount.
  useEffect(() => {
    if (currency === 'USD') return;
    if (fxUsdCny != null) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${base}/fx`);
        if (cancelled || !r.ok) return;
        const j: { USD_CNY: number; fetchedAt: string } = await r.json();
        setFxUsdCny(j.USD_CNY);
        setFxFetchedAt(j.fetchedAt);
      } catch {
        // Backend has its own boot-time fetch; leaving null hides the line.
      }
    })();
    return () => { cancelled = true; };
  }, [currency, fxUsdCny, base]);

  const categories = useMemo(
    () => Array.from(new Set(groups.map(g => g.category))), [groups]);
  const itemCount = useMemo(
    () => groups.reduce((a, g) => a + g.items.length, 0), [groups]);
  const byId = useMemo(
    () => new Map(basket.map(l => [l.inventoryId, l])), [basket]);

  const attrSpecs = useMemo(() => attrSpecsFor(catFilter), [catFilter]);
  const attrFilters = attrFiltersByCat[catFilter] ?? EMPTY_ATTRS;
  const activeAttrCount = useMemo(
    () => Object.values(attrFilters).reduce((a, v) => a + v.length, 0), [attrFilters]);

  // Groups in the selected category scope, before search / attribute filtering.
  const scopedGroups = useMemo(
    () => catFilter === 'all' ? groups : groups.filter(g => g.category === catFilter),
    [groups, catFilter]);
  const facets = useMemo(
    () => attrSpecs.length
      ? computeFacets(scopedGroups.flatMap(g => g.items), attrSpecs, search, attrFilters)
      : EMPTY_FACETS,
    [scopedGroups, attrSpecs, search, attrFilters]);
  const filteredGroups = useMemo(
    () => scopedGroups
      .map(g => ({ category: g.category, items: filterCatalogItems(g.items, search, attrFilters) }))
      .filter(g => g.items.length > 0),
    [scopedGroups, search, attrFilters]);
  const shownCount = useMemo(
    () => filteredGroups.reduce((a, g) => a + g.items.length, 0), [filteredGroups]);

  function setAttrFilters(next: AttrFilters) {
    setAttrFiltersByCat(prev => ({ ...prev, [catFilter]: next }));
  }
  function toggleAttr(key: string, value: string) {
    const cur = attrFilters[key] ?? [];
    const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
    const merged = { ...attrFilters };
    if (next.length === 0) delete merged[key]; else merged[key] = next;
    setAttrFilters(merged);
  }
  function clearAttrs() { setAttrFilters({}); }

  function reload() {
    setErrored(false);
    setLoadedOnce(false);
    setReloadKey(k => k + 1);
  }

  const vm: VM = {
    t, base, me, groups, filteredGroups, categories, catFilter, setCatFilter,
    search, setSearch, attrSpecs, facets, attrFilters, toggleAttr, clearAttrs,
    activeAttrCount, attrPanelOpen, setAttrPanelOpen,
    itemCount, shownCount, loadedOnce, basket, byId, tab, setTab, review, setReview,
    currency, setCurrency, fxUsdCny, fxFetchedAt,
    addToBasket(it, qty, unitPrice) {
      setBasket(b => {
        const rest = b.filter(x => x.inventoryId !== it.id);
        return [...rest, {
          inventoryId: it.id, label: itemLabel(it), category: it.category,
          qty: Math.max(1, Math.min(qty, it.qty)), unitPrice, available: it.qty,
        }];
      });
    },
    removeFromBasket(id) { setBasket(b => b.filter(x => x.inventoryId !== id)); },
    clearBasket() { setBasket([]); },
  };

  if (notFound) {
    return <StateScreen isPhone={isPhone} icon="lock"
      title={t('vendorLinkUnavailableTitle')} body={t('vendorLinkUnavailableBody')} />;
  }
  if (errored) {
    return <StateScreen isPhone={isPhone} icon="alert"
      title={t('vendorLoadError')} body={t('vendorServerErrorBody')}
      action={<button className="btn accent" onClick={reload}>{t('vendorRetry')}</button>} />;
  }

  return isPhone ? <VendorMobile vm={vm} /> : <VendorDesktop vm={vm} />;
}

function StateScreen({ isPhone, icon, title, body, action }: {
  isPhone: boolean; icon: IconName; title: string; body: string; action?: React.ReactNode;
}) {
  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--bg)', color: 'var(--fg)', padding: 24,
    }}>
      <div style={{
        textAlign: 'center', maxWidth: 360,
        ...(isPhone ? {} : {
          background: 'var(--bg-elev)', border: '1px solid var(--border)',
          borderRadius: 16, padding: '40px 36px',
        }),
      }}>
        <div style={{ color: 'var(--fg-subtle)' }}><Icon name={icon} size={28} /></div>
        <h2 style={{ margin: '14px 0 6px', fontSize: 18 }}>{title}</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>{body}</p>
        {action && <div style={{ marginTop: 18 }}>{action}</div>}
      </div>
    </div>
  );
}

// Shared by both shells: search box + the collapsible attribute facet panel,
// mirroring the desktop inventory page (lib/vendorCatalogFilter).

function CatalogSearch({ vm, style }: { vm: VM; style?: React.CSSProperties }) {
  const { t, search, setSearch } = vm;
  return (
    <div style={{ position: 'relative', ...style }}>
      <Icon name="search" size={13} style={{
        position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
        color: 'var(--fg-subtle)', pointerEvents: 'none',
      }} />
      <input
        className="input"
        placeholder={t('invSearchPlaceholder')}
        style={{ paddingLeft: 30, width: '100%' }}
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
    </div>
  );
}

function AttrFilterPanel({ vm }: { vm: VM }) {
  const {
    t, catFilter, attrSpecs, facets, attrFilters, toggleAttr, clearAttrs,
    activeAttrCount, attrPanelOpen, setAttrPanelOpen,
  } = vm;
  if (attrSpecs.length === 0) return null;
  return (
    <div className="inv-subfilter" data-open={attrPanelOpen ? 'true' : 'false'}>
      <button
        type="button"
        className="inv-subfilter__head"
        onClick={() => setAttrPanelOpen(!attrPanelOpen)}
        aria-expanded={attrPanelOpen}
        aria-controls="vendor-subfilter-body"
      >
        <span className="inv-subfilter__chevron">
          <Icon name="chevronDown" size={13} />
        </span>
        <span className="inv-subfilter__title">
          {t('invRefinePre')} <strong>{catFilter}</strong>
        </span>
        {activeAttrCount > 0 && (
          <span className="inv-subfilter__badge">
            {t('invFiltersActive', { n: activeAttrCount })}
          </span>
        )}
        <span className="inv-subfilter__spacer" />
        {activeAttrCount > 0 && (
          <span
            className="inv-subfilter__clear"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); clearAttrs(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                clearAttrs();
              }
            }}
          >
            {t('invClearAll')}
          </span>
        )}
        <span className="inv-subfilter__hint">
          {attrPanelOpen ? t('memSecHide') : t('memSecShow')}
        </span>
      </button>
      <div id="vendor-subfilter-body" className="inv-subfilter__body">
        {attrSpecs.map((spec) => {
          const counts = facets[spec.key] ?? {};
          const selected = attrFilters[spec.key] ?? [];
          const values = sortAttrValues(spec.key, Object.keys(counts));
          // Keep selected-but-now-empty values visible so they stay removable.
          for (const s of selected) if (!values.includes(s)) values.push(s);
          if (values.length === 0) return null;
          return (
            <div className="inv-subfilter__row" key={spec.key}>
              <div className="inv-subfilter__label">{spec.label}</div>
              <div className="inv-subfilter__chips">
                {values.map((v) => {
                  const isOn = selected.includes(v);
                  const count = counts[v] ?? 0;
                  return (
                    <button
                      key={v}
                      type="button"
                      className={'inv-chip' + (isOn ? ' on' : '') + (count === 0 && !isOn ? ' empty' : '')}
                      onClick={() => toggleAttr(spec.key, v)}
                      disabled={count === 0 && !isOn}
                    >
                      <span className="inv-chip__label">
                        {spec.format ? spec.format(v) : v}
                      </span>
                      <span className="inv-chip__count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────────── MOBILE ────────────────────────── */

function VendorMobile({ vm }: { vm: VM }) {
  const { t, me, review, setReview, tab, setTab } = vm;
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);

  return (
    <div style={{
      maxWidth: 560, margin: '0 auto', height: '100vh',
      display: 'flex', flexDirection: 'column', position: 'relative',
      background: 'var(--bg)', color: 'var(--fg)', overflow: 'hidden',
    }}>
      <PhHeader
        title={t('appBrand')}
        sub={me ? `${t('vendorSharedWith')} · ${me.customer.name}` : '…'}
        scrolled={scrolled}
        leading={review
          ? <button className="ph-icon-btn" onClick={() => setReview(false)} aria-label={t('vendorBack')}>
              <Icon name="chevronLeft" size={16} />
            </button>
          : undefined}
      />
      <div className="ph-scroll" ref={scrollRef}>
        {!review && (
          <div className="ph-chip-scroller">
            {(['browse', 'mine'] as Tab[]).map(x => (
              <button key={x}
                className={'ph-chip-btn ' + (tab === x ? 'active' : '')}
                onClick={() => { setTab(x); setReview(false); }}>
                {x === 'browse' ? t('vendorBrowse') : t('vendorMyOffers')}
              </button>
            ))}
          </div>
        )}
        {tab === 'browse' && !review && <MobileBrowse vm={vm} />}
        {tab === 'browse' && review && <MobileReview vm={vm} />}
        {tab === 'mine' && <MobileMyOffers vm={vm} />}
      </div>
    </div>
  );
}

function MobileBrowse({ vm }: { vm: VM }) {
  const {
    t, filteredGroups, categories, catFilter, setCatFilter,
    itemCount, loadedOnce, basket, byId, addToBasket, removeFromBasket, setReview,
    currency,
  } = vm;
  const [openId, setOpenId] = useState<string | null>(null);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
        <div className="ph-kpi">
          <div className="ph-kpi-label">{t('vendorItemsAvailable')}</div>
          <div className="ph-kpi-value">{itemCount}</div>
        </div>
        <div className="ph-kpi">
          <div className="ph-kpi-label">{t('vendorInOffer')}</div>
          <div className="ph-kpi-value">{basket.length}</div>
        </div>
      </div>

      <div className="ph-chip-scroller">
        {['all', ...categories].map(c => (
          <button key={c}
            className={'ph-chip-btn ' + (catFilter === c ? 'active' : '')}
            onClick={() => setCatFilter(c)}>
            {c === 'all' ? t('filterAllCats') : c}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 8 }}>
        <CatalogSearch vm={vm} />
      </div>

      {vm.attrSpecs.length > 0 && (
        <div style={{
          marginTop: 8, border: '1px solid var(--border)',
          borderRadius: 12, overflow: 'hidden',
        }}>
          <AttrFilterPanel vm={vm} />
        </div>
      )}

      <div className="ph-info-banner">
        <Icon name="info" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
        <div>{t('vendorNonBinding')}</div>
      </div>

      {!loadedOnce && <div style={{ marginTop: 14 }}><PhoneListSkeleton rows={6} /></div>}

      {loadedOnce && filteredGroups.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
          {t('vendorNothingAvailable')}
        </div>
      )}

      {loadedOnce && filteredGroups.map(g => (
        <div key={g.category}>
          <div className="ph-section-h">{g.category} · {g.items.length}</div>
          {g.items.map(it => {
            const inBasket = byId.get(it.id);
            const open = openId === it.id;
            return (
              <div key={it.id} style={{ marginTop: 8 }}>
                <button className="ph-inv-card"
                  style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
                  onClick={() => setOpenId(open ? null : it.id)}>
                  <ItemThumb it={it} size={44} onZoom={setZoomUrl} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {itemLabel(it)}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                      {[it.part_number, it.condition].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    {inBasket ? (
                      <span className="chip pos dot" style={{ fontSize: 10 }}>
                        {inBasket.qty} × {fmtMoney(inBasket.unitPrice, currency)}
                      </span>
                    ) : (
                      <span className="chip accent" style={{ fontSize: 10 }}>
                        {t('vendorAvailable', { n: it.qty })}
                      </span>
                    )}
                    <div style={{ marginTop: 5, color: 'var(--fg-subtle)' }}>
                      <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} />
                    </div>
                  </div>
                </button>
                {open && (
                  <OfferEditor it={it} t={t} existing={inBasket} currency={currency}
                    onSave={(q, p) => { addToBasket(it, q, p); setOpenId(null); }}
                    onRemove={() => { removeFromBasket(it.id); setOpenId(null); }} />
                )}
              </div>
            );
          })}
        </div>
      ))}

      {basket.length > 0 && (
        <div className="ph-action-bar">
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', lineHeight: 1.25 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {basket.length} {basket.length === 1 ? t('vendorItemOne') : t('vendorItemMany')}
            </span>
            <span className="mono" style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {fmtMoney(basketTotal(basket), currency)}
            </span>
          </div>
          <button className="ph-btn accent" style={{ flex: '0 0 auto', padding: '0 22px' }}
            onClick={() => setReview(true)}>
            {t('vendorReview')} <Icon name="chevronRight" size={15} />
          </button>
        </div>
      )}

      {zoomUrl && (
        <ImageLightbox url={zoomUrl} alt={t('aiPhotoLabel')} onClose={() => setZoomUrl(null)} />
      )}
    </>
  );
}

function OfferEditor({ it, t, existing, currency, onSave, onRemove }: {
  it: CatalogItem; existing: BasketLine | undefined; t: T;
  currency: Currency;
  onSave: (qty: number, price: number) => void; onRemove: () => void;
}) {
  const [qty, setQty] = useState(existing?.qty ?? 1);
  const [price, setPrice] = useState(existing ? String(existing.unitPrice) : '');
  return (
    <div style={{
      background: 'var(--bg-soft)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 12, margin: '6px 0 8px',
    }}>
      <div className="ph-field-row">
        <div className="ph-field" style={{ marginTop: 0 }}>
          <label>{t('vendorQty')} (≤{it.qty})</label>
          <input type="number" min={1} max={it.qty} value={qty} className="input"
            onChange={e => setQty(Math.max(1, Math.min(+e.target.value || 1, it.qty)))} />
        </div>
        <div className="ph-field" style={{ marginTop: 0 }}>
          <label>{t('vendorYourOffer')}</label>
          <input type="number" min={0} step="0.01" value={price} className="input"
            placeholder={currency === 'USD' ? '$' : '¥'}
            style={{ borderColor: 'var(--accent)' }}
            onChange={e => setPrice(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {existing && (
          <button className="ph-btn ghost" style={{ flex: '0 0 auto', height: 44 }} onClick={onRemove}>
            <Icon name="trash" size={15} />
          </button>
        )}
        <button className="ph-btn accent" style={{ height: 44 }}
          disabled={!price || +price <= 0} onClick={() => onSave(qty, +price)}>
          {existing ? t('vendorReview') : t('vendorAddOffer')}
        </button>
      </div>
    </div>
  );
}

function MobileReview({ vm }: { vm: VM }) {
  const {
    t, base, basket, setReview, setTab, clearBasket,
    currency, setCurrency, fxUsdCny, fxFetchedAt,
  } = vm;
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true); setErr('');
    const res = await postBid(base, basket, name, note, currency, t);
    setBusy(false);
    if (res.ok) { clearBasket(); setReview(false); setTab('mine'); return; }
    setErr(res.msg);
  }

  const subtotal = basketTotal(basket);

  return (
    <>
      <div className="ph-section-h">{t('vendorReview')}</div>

      <div className="ph-field" style={{ marginTop: 8 }}>
        <label>{t('currency.label')}</label>
        <div role="radiogroup" style={{ display: 'flex', gap: 18, marginTop: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="radio" name="bid-currency" value="USD"
              checked={currency === 'USD'} onChange={() => setCurrency('USD')} />
            {t('currency.usd')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="radio" name="bid-currency" value="CNY"
              checked={currency === 'CNY'} onChange={() => setCurrency('CNY')} />
            {t('currency.cny')}
          </label>
        </div>
      </div>

      {basket.map(l => (
        <div key={l.inventoryId} className="ph-inv-card">
          <div className="ph-inv-thumb"><Icon name={catThumb(l.category)} size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {l.label}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {l.qty} × {fmtMoney(l.unitPrice, currency)}
            </div>
          </div>
          <b className="mono" style={{ fontSize: 13, flexShrink: 0 }}>
            {fmtMoney(l.qty * l.unitPrice, currency)}
          </b>
        </div>
      ))}

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: 14, marginTop: 8, borderRadius: 12,
        background: 'var(--accent-soft)', color: 'var(--accent-strong)', fontWeight: 700,
      }}>
        <span>{t('bid.in_currency', { currency })}</span>
        <span className="mono" style={{ fontSize: 15 }}>{fmtMoney(subtotal, currency)}</span>
      </div>

      {currency === 'CNY' && fxUsdCny != null && (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6, padding: '0 4px' }}>
          {t('bid.usd_equivalent', {
            usd: fmtMoney(subtotal / fxUsdCny, 'USD'),
            rate: fxUsdCny.toFixed(4),
            date: (fxFetchedAt ?? new Date().toISOString()).slice(0, 10),
          })}
        </div>
      )}

      <div className="ph-field">
        <label>{t('vendorContactName')}</label>
        <input className="input" value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div className="ph-field">
        <label>{t('vendorNote')}</label>
        <textarea className="input" rows={3} value={note}
          onChange={e => setNote(e.target.value)} style={{ resize: 'vertical' }} />
      </div>

      {err && (
        <div className="ph-info-banner" style={{ marginTop: 12, background: 'var(--neg-soft)', color: 'var(--neg)', borderColor: 'transparent' }}>
          <Icon name="alert" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
          <div>{err}</div>
        </div>
      )}

      <div className="ph-action-bar">
        <button className="ph-btn ghost" style={{ flex: '0 0 auto', padding: '0 20px' }}
          onClick={() => setReview(false)} disabled={busy}>
          ← {t('vendorBack')}
        </button>
        <button className="ph-btn accent" disabled={!name || busy} onClick={submit}>
          {t('vendorSubmit')}
        </button>
      </div>
    </>
  );
}

function MobileMyOffers({ vm }: { vm: VM }) {
  const { t, base } = vm;
  const { bids, loaded, err, reload } = useMyOffers(base);
  const badge: Record<string, string> = {
    pending: t('vendorPending'), accepted: t('vendorAccepted'), declined: t('vendorDeclined'),
  };

  if (!loaded && !err) return <div style={{ marginTop: 14 }}><PhoneListSkeleton rows={5} /></div>;

  return (
    <>
      {err && (
        <div className="ph-info-banner" style={{ marginTop: 14, background: 'var(--neg-soft)', color: 'var(--neg)', borderColor: 'transparent' }}>
          <Icon name="alert" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>{t('vendorOffersLoadError')}</div>
          <button className="chip" style={{ cursor: 'pointer' }} onClick={reload}>{t('vendorRetry')}</button>
        </div>
      )}
      {!err && bids.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
          {t('vendorNoOffers')}
        </div>
      )}
      {bids.map(b => (
        <div key={b.id}>
          <div className="ph-section-h">
            <span>{b.id} · {new Date(b.createdAt).toLocaleDateString()}</span>
            <span className={'chip ' + offerTone(b.status)} style={{ fontSize: 10 }}>
              {badge[b.status] ?? b.status}
            </span>
          </div>
          {b.lines.map((l, i) => (
            <div key={`${b.id}-${l.bid_line_id ?? i}`} className="ph-inv-card">
              <div className="ph-inv-thumb"><Icon name="tag" size={16} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.label}
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                  {l.offeredQty} × ${l.offeredUnitPrice}
                  {l.acceptedUnitPrice != null && ` → @ $${l.acceptedUnitPrice}`}
                </div>
              </div>
              <span className={'chip ' + offerTone(l.status) + ' dot'} style={{ fontSize: 10, flexShrink: 0 }}>
                {badge[l.status] ?? l.status}
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/* ────────────────────────── DESKTOP ────────────────────────── */

function VendorDesktop({ vm }: { vm: VM }) {
  const { t, me, tab, setTab } = vm;
  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)', color: 'var(--fg)',
      display: 'flex', flexDirection: 'column',
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 32px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elev)', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 9, background: 'var(--accent-soft)',
            color: 'var(--accent-strong)', display: 'grid', placeItems: 'center',
          }}>
            <Icon name="inventory" size={18} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>{t('appBrand')}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
              {me ? `${t('vendorSharedWith')} · ${me.customer.name}` : '…'}
            </div>
          </div>
        </div>
        <div className="seg">
          {(['browse', 'mine'] as Tab[]).map(x => (
            <button key={x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>
              {x === 'browse' ? t('vendorBrowse') : t('vendorMyOffers')}
            </button>
          ))}
        </div>
      </header>

      <div style={{
        flex: 1, width: '100%', maxWidth: 1180, margin: '0 auto',
        padding: '24px 32px 120px', display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {tab === 'browse' ? <DesktopBrowse vm={vm} /> : <DesktopMyOffers vm={vm} />}
      </div>
    </div>
  );
}

function DesktopBrowse({ vm }: { vm: VM }) {
  const {
    t, filteredGroups, categories, catFilter, setCatFilter,
    loadedOnce, basket, byId, addToBasket, removeFromBasket, clearBasket,
    currency,
  } = vm;
  const [reviewOpen, setReviewOpen] = useState(false);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);
  const rows = filteredGroups.flatMap(g => g.items);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('vendorBrowse')}</h1>
          <div className="page-sub">{t('vendorNonBinding')}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="seg">
            {['all', ...categories].map(c => (
              <button key={c} className={catFilter === c ? 'active' : ''}
                onClick={() => setCatFilter(c)}>
                {c === 'all' ? t('filterAllCats') : c}
              </button>
            ))}
          </div>
          <CatalogSearch vm={vm} style={{ flex: '1 1 200px', minWidth: 160, maxWidth: 320 }} />
          <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>
            {rows.length} {rows.length === 1 ? t('vendorItemOne') : t('vendorItemMany')}
          </span>
        </div>

        <AttrFilterPanel vm={vm} />

        <div className="table-scroll">
          {!loadedOnce ? (
            <TableSkeleton rows={8} cols={6} />
          ) : rows.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
              {t('vendorNothingAvailable')}
            </div>
          ) : (
            <table className="table" style={{ minWidth: 880 }}>
              <thead>
                <tr>
                  <th>{t('vendorTableItem')}</th>
                  <th>{t('vendorTableCategory')}</th>
                  <th className="num">{t('vendorTableAvailable')}</th>
                  <th className="num">{t('vendorQty')}</th>
                  <th className="num">{t('vendorYourOffer')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(it => (
                  <DesktopBrowseRow key={it.id} it={it} t={t}
                    existing={byId.get(it.id)}
                    currency={currency}
                    onZoom={setZoomUrl}
                    onAdd={(q, p) => addToBasket(it, q, p)}
                    onRemove={() => removeFromBasket(it.id)} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {basket.length > 0 && (
        <div className="sel-bar">
          <div className="sel-bar-info">
            <div className="sel-bar-pill">
              {basket.length} {basket.length === 1 ? t('vendorItemOne') : t('vendorItemMany')}
            </div>
            <span className="sel-bar-divider" />
            <div>
              <span className="sel-bar-num">
                {basket.reduce((a, l) => a + l.qty, 0)}
              </span>{' '}
              <span className="sel-bar-label">{t('vendorUnits')}</span>
            </div>
            <span className="sel-bar-divider" />
            <div>
              <span className="sel-bar-num">{fmtMoney(basketTotal(basket), currency)}</span>{' '}
              <span className="sel-bar-label">{t('vendorTotalOffered')}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={clearBasket}>{t('vendorClear')}</button>
            <button className="btn accent" onClick={() => setReviewOpen(true)}>
              {t('vendorReview')} <Icon name="chevronRight" size={14} />
            </button>
          </div>
        </div>
      )}

      {reviewOpen && (
        <DesktopReviewModal vm={vm} onClose={() => setReviewOpen(false)} />
      )}

      {zoomUrl && (
        <ImageLightbox url={zoomUrl} alt={t('aiPhotoLabel')} onClose={() => setZoomUrl(null)} />
      )}
    </>
  );
}

function DesktopBrowseRow({ it, t, existing, currency, onAdd, onRemove, onZoom }: {
  it: CatalogItem; existing: BasketLine | undefined; t: T;
  currency: Currency;
  onAdd: (qty: number, price: number) => void;
  onRemove: () => void;
  onZoom: (url: string) => void;
}) {
  const [qty, setQty] = useState(existing?.qty ?? 1);
  const [price, setPrice] = useState(existing ? String(existing.unitPrice) : '');
  const added = !!existing;
  return (
    <tr style={added ? { background: 'var(--accent-soft)' } : undefined}>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ItemThumb it={it} size={36} onZoom={onZoom} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>{itemLabel(it)}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
              {[it.part_number, it.condition].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
        </div>
      </td>
      <td><span className="chip muted">{it.category}</span></td>
      <td className="num mono">{it.qty}</td>
      <td className="num">
        <input type="number" min={1} max={it.qty} value={qty} className="so-mini-input"
          onChange={e => setQty(Math.max(1, Math.min(+e.target.value || 1, it.qty)))} />
      </td>
      <td className="num">
        <input type="number" min={0} step="0.01" value={price} className="so-mini-input"
          placeholder={currency === 'USD' ? '$' : '¥'}
          onChange={e => setPrice(e.target.value)} />
      </td>
      <td className="num">
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          {added && (
            <button className="btn ghost sm" onClick={onRemove} aria-label={t('remove')}>
              <Icon name="trash" size={13} />
            </button>
          )}
          <button className="btn accent sm" disabled={!price || +price <= 0}
            onClick={() => onAdd(qty, +price)}>
            {added ? <><Icon name="check" size={13} /> {t('update')}</> : t('vendorAddOffer')}
          </button>
        </div>
      </td>
    </tr>
  );
}

function DesktopReviewModal({ vm, onClose }: { vm: VM; onClose: () => void }) {
  const {
    t, base, basket, setTab, clearBasket,
    currency, setCurrency, fxUsdCny, fxFetchedAt,
  } = vm;
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true); setErr('');
    const res = await postBid(base, basket, name, note, currency, t);
    setBusy(false);
    if (res.ok) { clearBasket(); onClose(); setTab('mine'); return; }
    setErr(res.msg);
  }

  const subtotal = basketTotal(basket);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-shell" style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{t('vendorReview')}</div>
            <div className="modal-sub">{t('vendorNonBinding')}</div>
          </div>
          <button className="btn ghost icon-only sm" onClick={onClose} aria-label={t('closeBtn')}>
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="modal-body" style={{ padding: 20, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-muted)' }}>
              {t('currency.label')}
            </span>
            <div role="radiogroup" style={{ display: 'flex', gap: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="radio" name="bid-currency-desktop" value="USD"
                  checked={currency === 'USD'} onChange={() => setCurrency('USD')} />
                {t('currency.usd')}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="radio" name="bid-currency-desktop" value="CNY"
                  checked={currency === 'CNY'} onChange={() => setCurrency('CNY')} />
                {t('currency.cny')}
              </label>
            </div>
          </div>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('vendorTableItem')}</th>
                  <th className="num">{t('vendorQty')}</th>
                  <th className="num">{t('vendorTableUnit')}</th>
                  <th className="num">{t('vendorTableTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {basket.map(l => (
                  <tr key={l.inventoryId}>
                    <td>{l.label}</td>
                    <td className="num mono">{l.qty}</td>
                    <td className="num mono">{fmtMoney(l.unitPrice, currency)}</td>
                    <td className="num mono">{fmtMoney(l.qty * l.unitPrice, currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ fontWeight: 700 }}>
                    {t('bid.in_currency', { currency })}
                  </td>
                  <td className="num mono" style={{ fontWeight: 700 }}>
                    {fmtMoney(subtotal, currency)}
                  </td>
                </tr>
                {currency === 'CNY' && fxUsdCny != null && (
                  <tr>
                    <td colSpan={4} className="num mono"
                      style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 400 }}>
                      {t('bid.usd_equivalent', {
                        usd: fmtMoney(subtotal / fxUsdCny, 'USD'),
                        rate: fxUsdCny.toFixed(4),
                        date: (fxFetchedAt ?? new Date().toISOString()).slice(0, 10),
                      })}
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>

          <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-muted)' }}>
                {t('vendorContactName')}
              </span>
              <input className="input" value={name} onChange={e => setName(e.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-muted)' }}>
                {t('vendorNote')}
              </span>
              <textarea className="textarea" rows={3} value={note}
                onChange={e => setNote(e.target.value)} />
            </label>
          </div>

          {err && (
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 8,
              background: 'var(--neg-soft)', color: 'var(--neg)', fontSize: 12.5,
            }}>
              {err}
            </div>
          )}
        </div>

        <div className="so-footer">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            {t('vendorBack')}
          </button>
          <button className="btn accent" disabled={!name || busy} onClick={submit}>
            {t('vendorSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}

function DesktopMyOffers({ vm }: { vm: VM }) {
  const { t, base } = vm;
  const { bids, loaded, err, reload } = useMyOffers(base);
  const badge: Record<string, string> = {
    pending: t('vendorPending'), accepted: t('vendorAccepted'), declined: t('vendorDeclined'),
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('vendorMyOffers')}</h1>
          <div className="page-sub">{t('vendorNonBinding')}</div>
        </div>
      </div>

      {!loaded && !err && <div className="card"><div className="table-scroll"><TableSkeleton rows={6} cols={5} /></div></div>}

      {err && (
        <div className="card" style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Icon name="alert" size={16} style={{ color: 'var(--neg)' }} />
          <span style={{ flex: 1, fontSize: 13 }}>{t('vendorOffersLoadError')}</span>
          <button className="btn sm" onClick={reload}>{t('vendorRetry')}</button>
        </div>
      )}

      {loaded && !err && bids.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '56px 20px', color: 'var(--fg-subtle)', fontSize: 13 }}>
          {t('vendorNoOffers')}
        </div>
      )}

      {bids.map(b => (
        <div key={b.id} className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{b.id}</div>
              <div className="page-sub">{new Date(b.createdAt).toLocaleString()}</div>
            </div>
            <span className={'chip ' + offerTone(b.status)}>{badge[b.status] ?? b.status}</span>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('vendorTableItem')}</th>
                  <th className="num">{t('vendorQty')}</th>
                  <th className="num">{t('vendorTableOffered')}</th>
                  <th className="num">{t('vendorTableAccepted')}</th>
                  <th>{t('vendorTableStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {b.lines.map((l, i) => (
                  <tr key={`${b.id}-${l.bid_line_id ?? i}`}>
                    <td>{l.label}</td>
                    <td className="num mono">{l.offeredQty}</td>
                    <td className="num mono">${l.offeredUnitPrice}</td>
                    <td className="num mono">
                      {l.acceptedUnitPrice != null ? `$${l.acceptedUnitPrice}` : '—'}
                    </td>
                    <td>
                      <span className={'chip ' + offerTone(l.status) + ' dot'}>
                        {badge[l.status] ?? l.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}
