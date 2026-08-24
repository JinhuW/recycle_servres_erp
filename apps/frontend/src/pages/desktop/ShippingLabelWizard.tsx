import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { FormSkeleton } from '../../components/Skeleton';
import {
  api, buyShipmentLabel, createShipment, deleteOrder, fetchShipmentRates,
  issueSellerLink, listShipments, updateShipment,
  type ShipmentAddressInput, type ShipmentPackageInput,
} from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtDateShort, fmtMoney } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { navigateBack, navigate } from '../../lib/route';
import { matchSellers, type PrevSeller } from '../../lib/shippingList';
import type { Order, Shipment, ShipmentRate, Warehouse } from '../../lib/types';

// Full-page two-step label wizard.
//   Step 1 — ship-to warehouse, seller address (link or manual), box size.
//   Step 2 — pick a rate, confirm the charge, buy.
//
// Label-first (`orderId === null`): the draft PO is created only when the
// wizard first needs it (Get Rates or the seller link) so backing out early
// leaves nothing behind. Once created, abandoning without a purchase or a
// seller link deletes the empty draft again.

type ToastKind = 'success' | 'error';
type Props = {
  orderId: string | null; // null → label-first
  sid: string | null;     // continue a pending shipment on the PO
  showToast: (msg: string, kind?: ToastKind) => void;
};

const EMPTY_FROM: ShipmentAddressInput = {
  name: '', phone: '', street1: '', street2: '', city: '', state: '', zip: '', country: 'US',
};

type PkgDraft = { weightOz: string; lengthIn: string; widthIn: string; heightIn: string };

export function ShippingLabelWizard({ orderId, sid, showToast }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [step, setStep] = useState<1 | 2>(1);
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [rates, setRates] = useState<ShipmentRate[]>([]);
  const [picked, setPicked] = useState<ShipmentRate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [sellerLink, setSellerLink] = useState<string | null>(null);

  const [from, setFrom] = useState<ShipmentAddressInput>(EMPTY_FROM);
  const [pkg, setPkg] = useState<PkgDraft>({ weightOz: '', lengthIn: '', widthIn: '', heightIn: '' });
  // Address book from past shipments; a manual edit clears the selection so a
  // highlighted card never claims an address the form no longer matches.
  const [prevSellers, setPrevSellers] = useState<PrevSeller[]>([]);
  const [prevPick, setPrevPick] = useState<string | null>(null);
  const [contactQ, setContactQ] = useState('');
  // Seller-name typeahead: opens while the user types, never right after a pick.
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const setF = (k: keyof ShipmentAddressInput, v: string) => { setPrevPick(null); setFrom((p) => ({ ...p, [k]: v })); };
  const setP = (k: keyof PkgDraft, v: string) => setPkg((p) => ({ ...p, [k]: v }));

  const pickSeller = (p: PrevSeller) => {
    setSuggestOpen(false);
    setPrevPick(p.key);
    setFrom({
      name: p.from.name ?? '', phone: p.from.phone ?? '',
      street1: p.from.street1 ?? '', street2: p.from.street2 ?? '',
      city: p.from.city ?? '', state: p.from.state ?? '',
      zip: p.from.zip ?? '', country: p.from.country ?? 'US',
    });
  };

  // Label-first destination pick.
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  // Per-PO mode: the destination is the PO's own warehouse.
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(!!orderId || sid != null);

  // The draft PO this wizard created (label-first only) and whether it earned
  // its keep (a purchase or a seller link).
  const createdPo = useRef<string | null>(null);
  const produced = useRef(false);

  useEffect(() => {
    if (orderId) {
      let alive = true;
      Promise.all([
        api.get<{ order: Order }>(`/api/orders/${orderId}`),
        // GET /api/orders/:id returns only the {id, short, region} warehouse
        // slice — no ship* fields — so the destination's shipping address must
        // come from the warehouses list, exactly as in label-first mode.
        // Without this, noShipAddr below reads undefined ship fields as "no
        // address" and Get Rates is disabled on every existing PO.
        api.get<{ items: Warehouse[] }>('/api/warehouses'),
        sid ? listShipments(orderId) : Promise.resolve(null),
      ])
        .then(([o, whs, list]) => {
          if (!alive) return;
          setOrder(o.order);
          setWarehouses(whs.items);
          const existing = list?.items.find(x => x.id === sid) ?? null;
          if (existing) {
            setShipment(existing);
            setFrom({
              name: existing.from.name ?? '', phone: existing.from.phone ?? '',
              street1: existing.from.street1 ?? '', street2: existing.from.street2 ?? '',
              city: existing.from.city ?? '', state: existing.from.state ?? '',
              zip: existing.from.zip ?? '', country: existing.from.country ?? 'US',
            });
            setPkg({
              weightOz: existing.package.weightOz != null ? String(existing.package.weightOz) : '',
              lengthIn: existing.package.lengthIn != null ? String(existing.package.lengthIn) : '',
              widthIn: existing.package.widthIn != null ? String(existing.package.widthIn) : '',
              heightIn: existing.package.heightIn != null ? String(existing.package.heightIn) : '',
            });
          }
        })
        .catch(handleFetchError)
        .finally(() => { if (alive) setLoading(false); });
      return () => { alive = false; };
    }
    let alive = true;
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => {
        if (!alive) return;
        setWarehouses(r.items);
        if (r.items.length === 1) setWarehouseId(r.items[0].id);
      })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [orderId, sid]);

  // Address book: complete seller addresses from past shipments, deduped
  // server-side (GET /api/shipping/contacts).
  useEffect(() => {
    let alive = true;
    api.get<{ items: PrevSeller[] }>('/api/shipping/contacts')
      .then(r => { if (alive) setPrevSellers(r.items); })
      .catch(() => { /* the picker is a convenience — the blank form still works */ });
    return () => { alive = false; };
  }, []);

  const chosenWh: Warehouse | null = orderId
    ? (warehouses.find(w => w.id === order?.warehouse?.id) ?? null)
    : (warehouses.find(w => w.id === warehouseId) ?? null);
  // Mirror the server's rule (street1+city+state+zip) — a partial address
  // passes a street1-only check and then fails at the rates call.
  const noShipAddr = !!chosenWh
    && !(chosenWh.shipStreet1 && chosenWh.shipCity && chosenWh.shipState && chosenWh.shipZip);

  const pkgParsed = (): ShipmentPackageInput | null => {
    const n = (s: string) => { const v = Number(s); return Number.isFinite(v) && v > 0 ? v : null; };
    const weightOz = n(pkg.weightOz), lengthIn = n(pkg.lengthIn), widthIn = n(pkg.widthIn), heightIn = n(pkg.heightIn);
    if (weightOz == null || lengthIn == null || widthIn == null || heightIn == null) return null;
    return { weightOz, lengthIn, widthIn, heightIn };
  };
  const step1Ready = !!(from.name.trim() && from.street1.trim() && from.city.trim()
    && from.state.trim() && from.zip.trim() && pkgParsed())
    && (orderId != null ? !!chosenWh : !!warehouseId) && !noShipAddr;

  // Label-first: the draft PO exists from the moment the wizard needs one.
  // Cached as the in-flight promise: "Copy seller link" and "Get Rates" run
  // behind independent busy flags, so both can call this concurrently.
  const poPromise = useRef<Promise<string> | null>(null);
  // Which warehouse the draft currently holds. The cards stay clickable after
  // the draft exists, and the server resolves rates/buy from the PO row — a
  // re-pick must be written through or the label quietly ships to the
  // previously chosen warehouse.
  const poWarehouse = useRef<string | null>(null);
  const ensurePo = async (): Promise<string> => {
    if (orderId) return orderId;
    if (!poPromise.current) {
      const chosen = warehouseId;
      // The note marks the draft's origin so it reads sensibly in the PO list
      // until its lines arrive with the goods.
      poPromise.current = api.post<{ id: string }>('/api/orders/draft', {
        warehouseId: chosen,
        notes: 'Created from shipping label',
      }).then(
        (r) => { createdPo.current = r.id; poWarehouse.current = chosen; return r.id; },
        (e) => { poPromise.current = null; throw e; },
      );
    }
    const id = await poPromise.current;
    if (poWarehouse.current !== warehouseId) {
      await api.patch(`/api/orders/${id}`, { warehouseId });
      poWarehouse.current = warehouseId;
    }
    return id;
  };

  // The no-typing path: hand the seller a link instead of transcribing chat.
  // The wizard stays open so the purchaser can still fill it in manually.
  const copySellerLink = async () => {
    setLinkBusy(true);
    setError(null);
    try {
      const poId = await ensurePo();
      let tok: string;
      if (shipment) {
        tok = shipment.sellerToken ?? (await issueSellerLink(poId, shipment.id)).sellerToken;
      } else {
        const r = await createShipment(poId, { sellerFill: true });
        setShipment(r.shipment);
        tok = r.shipment.sellerToken!;
      }
      // The token now exists server-side — the draft PO must survive even if
      // the clipboard write below fails.
      produced.current = true;
      const url = `${window.location.origin}/s/${tok}`;
      setSellerLink(url);
      // clipboard is undefined off HTTPS (LAN testing) and writeText can be
      // denied — never claim "copied" then; the rendered link is the fallback.
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(url);
          setLinkCopied(true);
        } catch { /* link is rendered below */ }
      }
    } catch (e) {
      setError((e as { message?: string })?.message ?? t('shipRatesFailed'));
    } finally {
      setLinkBusy(false);
    }
  };

  const toRates = async () => {
    const p = pkgParsed();
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      const poId = await ensurePo();
      const saved = shipment
        ? (await updateShipment(poId, shipment.id, { from, package: p })).shipment
        : (await createShipment(poId, { from, package: p })).shipment;
      setShipment(saved);
      const r = await fetchShipmentRates(poId, saved.id);
      setRates(r.rates);
      setPicked(null);
      setStep(2);
    } catch (e) {
      setError((e as { message?: string })?.message ?? t('shipRatesFailed'));
    } finally {
      setBusy(false);
    }
  };

  const buy = async () => {
    if (!shipment || !picked) return;
    const poId = orderId ?? createdPo.current;
    if (!poId) return;
    setBusy(true);
    setError(null);
    try {
      await buyShipmentLabel(poId, shipment.id, { rateId: picked.rateId, expectedAmount: picked.amount });
      produced.current = true;
      if (!orderId) showToast(t('shipLabelFirstCreated', { id: poId }));
      navigate(`/shipping/${poId}`);
    } catch (e) {
      setError((e as { message?: string })?.message ?? t('shipBuyFailed'));
      setBusy(false);
    }
  };

  const abandon = () => {
    // Label-first with nothing produced → an empty draft nobody asked for.
    const poId = createdPo.current;
    if (!orderId && poId && !produced.current) {
      void deleteOrder(poId).catch(() => { /* keep it, harmless */ });
    }
    navigateBack('/shipping');
  };

  if (loading) return <FormSkeleton fields={6} />;

  const q = contactQ.trim().toLowerCase();
  const shownContacts = q
    ? prevSellers.filter(p => (p.label + ' ' + (p.from.street1 ?? '')).toLowerCase().includes(q))
    : prevSellers;
  const suggestions = matchSellers(prevSellers, from.name);

  return (
    <div className="ship-wizard-layout">
    <div className="ship-wizard">
      <div className="ship-wizard-head">
        <button className="btn ghost sm" onClick={abandon}>
          ← {orderId ?? t('shipBackToShipping')}
        </button>
        <span className="ship-wizard-step">{t('shipWizStep', { n: step })}</span>
      </div>
      <h1 className="ship-wizard-title">{t('shipWizTitle')}</h1>

      {step === 1 && (
        <>
          <section className="ship-wizard-section">
            <div className="ship-sec-title">{t('shipSecShipTo')}</div>
            {orderId ? (
              chosenWh ? <WarehouseCard w={chosenWh} selected fixed noShipAddr={noShipAddr} />
                : order
                  ? <div className="ship-addr-warn">{t('shipPoNoWarehouse')}</div>
                  : <div className="ship-addr-warn">{t('shipPageOrderMissing')}</div>
            ) : (
              <div className="ship-addr-grid">
                {warehouses.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>{t('loadingApp')}</span>}
                {warehouses.map(w => (
                  <WarehouseCard
                    key={w.id}
                    w={w}
                    selected={warehouseId === w.id}
                    noShipAddr={warehouseId === w.id && noShipAddr}
                    onSelect={() => setWarehouseId(w.id)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="ship-wizard-section">
            <div className="ship-sec-title">{t('shipSecShipFrom')}</div>
            <div className="ship-seller-card">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ship-seller-title">{t('shipAskSeller')}</div>
                <div className="ship-seller-hint">
                  {linkCopied ? t('shipLinkCopiedHint') : sellerLink ? t('shipLinkManualHint') : t('shipAskSellerHint')}
                </div>
                {sellerLink && (
                  <div
                    className="mono"
                    style={{ fontSize: 11.5, marginTop: 4, wordBreak: 'break-all', userSelect: 'all' }}
                  >
                    {sellerLink}
                  </div>
                )}
              </div>
              <button
                className={'btn sm' + (linkCopied ? '' : ' accent')}
                // Label-first: the link's draft PO needs a destination, and the
                // backend rejects a draft naming no real warehouse.
                disabled={linkBusy || (orderId == null && !warehouseId)}
                onClick={copySellerLink}
                style={{ flexShrink: 0 }}
              >
                {linkBusy ? '…' : linkCopied ? t('shipLinkCopied') : t('shipCopySellerLink')}
              </button>
            </div>
            <div className="ship-or-divider">{t('shipOrManual')}</div>
            <div className="field-row">
              <div className="field ship-name-field">
                <label className="label">{t('shipSellerName')} <span className="req">*</span></label>
                <input
                  className="input"
                  value={from.name}
                  role="combobox"
                  aria-expanded={suggestOpen && suggestions.length > 0}
                  autoComplete="off"
                  onChange={(e) => { setF('name', e.target.value); setSuggestOpen(e.target.value.trim().length > 0); setSuggestIdx(0); }}
                  onBlur={() => setSuggestOpen(false)}
                  onKeyDown={(e) => {
                    if (!suggestOpen || suggestions.length === 0) return;
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestIdx(i => (i + 1) % suggestions.length); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestIdx(i => (i - 1 + suggestions.length) % suggestions.length); }
                    else if (e.key === 'Enter') { e.preventDefault(); pickSeller(suggestions[suggestIdx]); }
                    else if (e.key === 'Escape') { setSuggestOpen(false); }
                  }}
                />
                {suggestOpen && suggestions.length > 0 && (
                  <div className="ship-suggest" role="listbox">
                    {suggestions.map((p, i) => (
                      <button
                        key={p.key}
                        type="button"
                        role="option"
                        aria-selected={i === suggestIdx}
                        className={'ship-suggest-row' + (i === suggestIdx ? ' active' : '')}
                        onMouseDown={(e) => { e.preventDefault(); pickSeller(p); }}
                        onMouseEnter={() => setSuggestIdx(i)}
                      >
                        <span style={{ fontWeight: 600 }}>{p.from.name}</span>
                        <span className="ship-suggest-sub">
                          {[p.from.city, p.from.state].filter(Boolean).join(', ')}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="field">
                <label className="label">{t('shipSellerPhone')}</label>
                <input className="input" value={from.phone ?? ''} onChange={(e) => setF('phone', e.target.value)} autoComplete="off" />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label className="label">{t('shipStreet')} <span className="req">*</span></label>
                <input className="input" value={from.street1} onChange={(e) => setF('street1', e.target.value)} autoComplete="off" />
              </div>
              <div className="field">
                <label className="label">{t('shipStreet2')}</label>
                <input className="input" value={from.street2 ?? ''} onChange={(e) => setF('street2', e.target.value)} autoComplete="off" />
              </div>
            </div>
            <div className="field-row" style={{ gridTemplateColumns: '1.4fr 0.6fr 0.9fr' }}>
              <div className="field">
                <label className="label">{t('shipCity')} <span className="req">*</span></label>
                <input className="input" value={from.city} onChange={(e) => setF('city', e.target.value)} autoComplete="off" />
              </div>
              <div className="field">
                <label className="label">{t('shipState')} <span className="req">*</span></label>
                <input className="input" value={from.state} onChange={(e) => setF('state', e.target.value.toUpperCase())} autoComplete="off" />
              </div>
              <div className="field">
                <label className="label">{t('shipZip')} <span className="req">*</span></label>
                <input className="input mono" value={from.zip} onChange={(e) => setF('zip', e.target.value)} autoComplete="off" />
              </div>
            </div>
          </section>

          <section className="ship-wizard-section">
            <div className="ship-sec-title">{t('shipSecPackage')}</div>
            <div className="ship-dims-row">
              <div className="field">
                <label className="label">{t('shipLengthIn')} <span className="req">*</span></label>
                <input className="input mono" type="number" min={0} value={pkg.lengthIn} onChange={(e) => setP('lengthIn', e.target.value)} />
              </div>
              <div className="field">
                <label className="label">{t('shipWidthIn')} <span className="req">*</span></label>
                <input className="input mono" type="number" min={0} value={pkg.widthIn} onChange={(e) => setP('widthIn', e.target.value)} />
              </div>
              <div className="field">
                <label className="label">{t('shipHeightIn')} <span className="req">*</span></label>
                <input className="input mono" type="number" min={0} value={pkg.heightIn} onChange={(e) => setP('heightIn', e.target.value)} />
              </div>
              <div className="field">
                <label className="label">{t('shipWeightOz')} <span className="req">*</span></label>
                <input className="input mono" type="number" min={0} value={pkg.weightOz} onChange={(e) => setP('weightOz', e.target.value)} />
              </div>
            </div>
          </section>
        </>
      )}

      {step === 2 && (
        <section className="ship-wizard-section">
          <div className="ship-sec-title">{t('shipStep2Title')}</div>
          {rates.map((r) => {
            const sel = picked?.rateId === r.rateId;
            return (
              <button
                key={r.rateId}
                type="button"
                className={'ship-rate-card' + (sel ? ' selected' : '')}
                onClick={() => setPicked(r)}
              >
                <span className="ship-rate-radio" />
                <span>
                  <span className="ship-carrier-chip">{r.carrier}</span>{' '}
                  <span style={{ color: 'var(--fg-muted)', fontSize: 12.5 }}>{r.service}</span>
                </span>
                <span className="ship-rate-days">
                  {r.deliveryDays != null ? t('shipDays', { n: r.deliveryDays }) : ''}
                </span>
                <span className="mono ship-rate-price">{fmtMoney(r.amount, r.currency)}</span>
              </button>
            );
          })}
          {picked && (
            <div className="ship-confirm-rows" style={{ marginTop: 8 }}>
              <div className="ship-confirm-row">
                <span>{t('shipConfirmCarrier')}</span>
                <span>{picked.carrier} {picked.service}</span>
              </div>
              <div className="ship-confirm-row">
                <span>{t('shipConfirmFrom')}</span>
                <span>{from.city}, {from.state} {from.zip}</span>
              </div>
              <div className="ship-confirm-row strong">
                <span>{t('shipConfirmCharge')}</span>
                <span className="mono">{fmtMoney(picked.amount, picked.currency)}</span>
              </div>
              <div className="ship-callout-warn">
                {t('shipBuyWarning', { amount: fmtMoney(picked.amount, picked.currency) })}
              </div>
            </div>
          )}
        </section>
      )}

      {error && <div className="ship-wizard-err">{error}</div>}

      <div className="ship-wizard-foot">
        <div>
          {step === 2 && (
            <button className="btn" onClick={() => { setError(null); setStep(1); }} disabled={busy}>
              {t('back')}
            </button>
          )}
        </div>
        <div className="ship-foot-right">
          <button className="btn" onClick={abandon} disabled={busy}>{t('cancel')}</button>
          {step === 1 && (
            <button className="btn accent lg" onClick={toRates} disabled={busy || !step1Ready}>
              {busy ? '…' : t('shipGetRates')}
            </button>
          )}
          {step === 2 && (
            <button className="btn accent" onClick={buy} disabled={busy || !picked}>
              {busy ? '…' : picked ? t('shipBuyBtn', { amount: fmtMoney(picked.amount, picked.currency) }) : t('shipGetRates')}
            </button>
          )}
        </div>
      </div>
    </div>

    {step === 1 && (
      <aside className="card ship-contacts">
        <div className="card-head">
          <div className="card-title">{t('shipContactsTitle')}</div>
          {prevSellers.length > 0 && <span className="ship-panel-count">{prevSellers.length}</span>}
        </div>
        <div className="ship-contacts-body">
          {prevSellers.length === 0 ? (
            <div className="ship-contacts-empty">{t('shipContactsEmpty')}</div>
          ) : (
            <>
              <div className="toolbar-search ship-contacts-search">
                <Icon name="search" size={13} />
                <input
                  className="input"
                  placeholder={t('shipContactsSearchPh')}
                  value={contactQ}
                  onChange={e => setContactQ(e.target.value)}
                />
              </div>
              <div className="ship-contacts-list">
                {shownContacts.map(p => (
                  <button
                    key={p.key}
                    type="button"
                    className={'ship-contact-row' + (prevPick === p.key ? ' selected' : '')}
                    aria-pressed={prevPick === p.key}
                    onClick={() => pickSeller(p)}
                  >
                    <Icon name="user" size={14} />
                    <span className="ship-contact-main">
                      <span className="ship-contact-name">
                        {p.from.name}
                        {p.count > 1 && <span className="ship-contact-count mono">×{p.count}</span>}
                      </span>
                      <span className="ship-contact-addr">
                        {p.from.street1}{p.from.street2 ? `, ${p.from.street2}` : ''}
                      </span>
                      <span className="ship-contact-addr">
                        {[p.from.city, p.from.state].filter(Boolean).join(', ')} {p.from.zip ?? ''}
                      </span>
                      <span className="ship-contact-meta">
                        {[p.from.phone, fmtDateShort(p.lastUsed, locale)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </button>
                ))}
                {shownContacts.length === 0 && (
                  <div className="ship-contacts-empty">{t('shipNoMatch')}</div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    )}
    </div>
  );
}

function WarehouseCard({ w, selected, fixed, noShipAddr, onSelect }: {
  w: Warehouse;
  selected: boolean;
  fixed?: boolean;
  noShipAddr: boolean;
  onSelect?: () => void;
}) {
  const { t } = useT();
  const addr = w.shipStreet1
    ? [w.shipStreet1, w.shipCity, w.shipState, w.shipZip].filter(Boolean).join(', ')
    : w.address ?? '';
  const body = (
    <>
      <Icon name="warehouse" size={16} style={{ marginTop: 2, flexShrink: 0 }} />
      <span style={{ minWidth: 0 }}>
        <span className="ship-addr-name">
          {w.name ?? w.short}
          <span className="chip muted" style={{ fontSize: 10.5 }}>{w.region}</span>
        </span>
        {addr && <span className="ship-addr-line">{addr}</span>}
        {noShipAddr && <span className="ship-addr-warn">{t('shipPickWhNoAddr')}</span>}
      </span>
    </>
  );
  if (fixed) {
    return <div className={'ship-addr-card' + (selected ? ' selected' : '')} style={{ cursor: 'default' }}>{body}</div>;
  }
  return (
    <button
      type="button"
      className={'ship-addr-card' + (selected ? ' selected' : '')}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {body}
    </button>
  );
}
