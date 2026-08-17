import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import {
  buyShipmentLabel, createShipment, deleteShipment, fetchShipmentRates,
  issueSellerLink, listShipments, updateShipment, voidShipment,
  type ShipmentAddressInput, type ShipmentPackageInput,
} from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtMoney } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { Shipment, ShipmentRate, ShipmentStatus } from '../../lib/types';

// Prepaid labels for the seller, one shipment per box. Create flow is a
// modal stepper (address+package → rates → confirm); purchased shipments
// render a status timeline with tracking, ETA, label download, and void.

type Props = {
  orderId: string;
  canEdit: boolean;
  onMutated: () => void; // parent bumps the activity log
};

const TIMELINE: ShipmentStatus[] = ['draft', 'purchased', 'in_transit', 'delivered'];
// voided / exception render as badge states, not timeline steps.
const TIMELINE_POS: Partial<Record<ShipmentStatus, number>> = {
  draft: 0, quoted: 0, purchased: 1, in_transit: 2, delivered: 3,
};

const STATUS_CHIP: Record<ShipmentStatus, { cls: string; key: string }> = {
  draft: { cls: 'muted', key: 'shipStatusDraft' },
  quoted: { cls: 'muted', key: 'shipStatusQuoted' },
  purchased: { cls: 'accent', key: 'shipStatusPurchased' },
  in_transit: { cls: 'info', key: 'shipStatusInTransit' },
  delivered: { cls: 'pos', key: 'shipStatusDelivered' },
  voided: { cls: 'neg', key: 'shipStatusVoided' },
  exception: { cls: 'warn', key: 'shipStatusException' },
};

function fmtEta(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function ShippingPanel({ orderId, canEdit, onMutated }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [items, setItems] = useState<Shipment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [flowFor, setFlowFor] = useState<Shipment | 'new' | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [confirmVoid, setConfirmVoid] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(() => {
    listShipments(orderId)
      .then((r) => setItems(r.items))
      .catch(handleFetchError)
      .finally(() => setLoaded(true));
  }, [orderId]);
  useEffect(() => { reload(); }, [reload]);

  const copyTracking = (tn: string) => {
    navigator.clipboard?.writeText(tn)
      .then(() => { setCopied(tn); setTimeout(() => setCopied(null), 1600); })
      .catch(() => { /* the visible number is selectable */ });
  };

  const doVoid = async (sid: string) => {
    setVoiding(sid);
    setConfirmVoid(null);
    try {
      await voidShipment(orderId, sid);
      reload();
      onMutated();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setVoiding(null);
    }
  };

  const doDelete = async (sid: string) => {
    try {
      await deleteShipment(orderId, sid);
      reload();
    } catch (e) {
      handleFetchError(e);
    }
  };

  const sellerUrl = (tok: string) => `${window.location.origin}/s/${tok}`;
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  const copyLink = (tok: string) => {
    navigator.clipboard?.writeText(sellerUrl(tok))
      .then(() => { setCopiedLink(tok); setTimeout(() => setCopiedLink(null), 1800); })
      .catch(() => { /* the link is also shown in the row title attr */ });
  };

  const regenLink = async (sid: string) => {
    try {
      const r = await issueSellerLink(orderId, sid);
      reload();
      copyLink(r.sellerToken);
    } catch (e) {
      handleFetchError(e);
    }
  };

  if (loaded && items.length === 0 && !canEdit) return null;

  return (
    <div className="card" style={{ padding: 0, marginTop: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 18px', borderBottom: items.length || !loaded ? '1px solid var(--border)' : 'none',
      }}>
        <Icon name="truck" size={15} />
        <span style={{ fontSize: 14, fontWeight: 650 }}>{t('shipPanelTitle')}</span>
        {items.length > 0 && (
          <span style={{
            fontSize: 10.5, fontWeight: 600, color: 'var(--fg-subtle)',
            background: 'var(--bg-soft)', border: '1px solid var(--border)',
            borderRadius: 999, padding: '1px 7px',
          }}>{items.length}</span>
        )}
        <span style={{ flex: 1 }} />
        {canEdit && (
          <button className="btn accent sm" onClick={() => setFlowFor('new')}>
            <Icon name="plus" size={13} /> {t('shipNewLabel')}
          </button>
        )}
      </div>

      {!loaded && (
        <div style={{ padding: '14px 18px' }}>
          <span className="skeleton" style={{ width: '55%', height: 13, borderRadius: 4, display: 'inline-block' }} aria-hidden />
        </div>
      )}

      {loaded && items.length === 0 && canEdit && (
        <div style={{ padding: '14px 18px', fontSize: 12.5, color: 'var(--fg-subtle)' }}>
          {t('shipEmptyHint')}
        </div>
      )}

      {items.map((s) => {
        const pos = TIMELINE_POS[s.status];
        const chip = STATUS_CHIP[s.status];
        const eta = fmtEta(s.trackingEta, locale);
        const canVoid = canEdit && ['purchased', 'in_transit', 'exception'].includes(s.status);
        const isPending = s.status === 'draft' || s.status === 'quoted';
        return (
          <div key={s.id} style={{
            padding: '14px 18px', borderBottom: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', gap: 10,
            opacity: s.status === 'voided' ? 0.72 : 1,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {s.carrier ? (
                <>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{s.carrier}</span>
                  <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>{s.service}</span>
                </>
              ) : (
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                  {s.from.name
                    ? t('shipBoxFrom', { name: s.from.name })
                    : t('shipAwaitingSellerTitle')}
                </span>
              )}
              {isPending && !s.complete && s.sellerToken ? (
                <span className="chip warn dot" style={{ fontSize: 11 }}>{t('shipWaitingSeller')}</span>
              ) : (
                <span className={'chip dot ' + chip.cls} style={{ fontSize: 11 }}>{t(chip.key)}</span>
              )}
              {s.provider === 'stub' && s.status !== 'draft' && s.status !== 'quoted' && (
                <span className="chip muted" style={{ fontSize: 10.5 }}>{t('shipDemoTag')}</span>
              )}
              <span style={{ marginLeft: 'auto' }} className="mono">
                {s.labelCost != null && (
                  <span style={{
                    fontWeight: 600, fontSize: 13,
                    textDecoration: s.status === 'voided' ? 'line-through' : 'none',
                    color: s.status === 'voided' ? 'var(--fg-subtle)' : 'inherit',
                  }}>{fmtMoney(s.labelCost, s.rateCurrency)}</span>
                )}
              </span>
            </div>

            {pos !== undefined && pos >= 1 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  {TIMELINE.map((step, i) => {
                    const done = i < pos || (i === pos && step === 'delivered');
                    const now = i === pos && step !== 'delivered';
                    return (
                      <div key={step} style={{ display: 'flex', alignItems: 'center', flex: i < TIMELINE.length - 1 ? 1 : '0 0 auto', minWidth: 0 }}>
                        <div style={{
                          width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                          display: 'grid', placeItems: 'center', fontSize: 10,
                          border: '2px solid ' + (done ? 'var(--accent)' : now ? 'var(--info)' : 'var(--border-strong)'),
                          background: done ? 'var(--accent)' : now ? 'var(--info-soft)' : 'var(--bg-elev)',
                          color: done ? '#fff' : now ? 'var(--info)' : 'var(--fg-subtle)',
                          boxShadow: now ? '0 0 0 4px color-mix(in oklch, var(--info) 15%, transparent)' : 'none',
                        }}>{done ? '✓' : now ? '●' : ''}</div>
                        {i < TIMELINE.length - 1 && (
                          <div style={{
                            flex: 1, height: 2, margin: '0 6px', minWidth: 14,
                            background: i < pos ? 'var(--accent)' : 'var(--border-strong)',
                          }} />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--fg-subtle)', marginTop: 5 }}>
                  <span>{t('shipStepCreated')}</span>
                  <span style={pos === 1 ? { color: 'var(--info)', fontWeight: 600 } : undefined}>{t('shipStatusPurchased')}</span>
                  <span style={pos === 2 ? { color: 'var(--info)', fontWeight: 600 } : undefined}>{t('shipStatusInTransit')}</span>
                  <span style={pos === 3 ? { color: 'var(--accent-strong)', fontWeight: 600 } : undefined}>{t('shipStatusDelivered')}</span>
                </div>
              </div>
            )}

            {s.status === 'exception' && s.trackingStatus && (
              <div style={{ fontSize: 12.5, color: 'var(--warn-strong)' }}>
                {t('shipExceptionNote', { status: s.trackingStatus })}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--fg-muted)' }}>
              {eta && s.status !== 'delivered' && s.status !== 'voided' && (
                <span>
                  <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, color: 'var(--fg-subtle)', marginRight: 6 }}>
                    {t('shipEta')}
                  </span>
                  <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{eta}</span>
                </span>
              )}
              {s.trackingNumber && (
                <button
                  type="button"
                  className="mono"
                  onClick={() => copyTracking(s.trackingNumber!)}
                  title={t('shipCopyTracking')}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    fontSize: 12, color: 'var(--fg)', background: 'var(--bg-soft)',
                    border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px',
                    cursor: 'pointer',
                  }}
                >
                  {s.trackingNumber}
                  <span style={{ color: copied === s.trackingNumber ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontSize: 11 }}>
                    {copied === s.trackingNumber ? t('shipCopied') : t('shipCopy')}
                  </span>
                </button>
              )}
              {s.trackingUrl && (
                <a href={s.trackingUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--info)' }}>
                  {t('shipTrackOnCarrier', { carrier: s.carrier ?? '' })} ↗
                </a>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {s.labelUrl && (
                <a className="btn sm" href={s.labelUrl} target="_blank" rel="noreferrer" download>
                  <Icon name="download" size={13} /> {t('shipDownloadLabel')}
                </a>
              )}
              {isPending && canEdit && (
                <>
                  <button className="btn accent sm" onClick={() => setFlowFor(s)}>
                    {s.complete ? t('shipContinue') : t('shipFillManually')}
                  </button>
                  {s.sellerToken && (
                    <button
                      className="btn sm"
                      title={sellerUrl(s.sellerToken)}
                      onClick={() => copyLink(s.sellerToken!)}
                    >
                      {copiedLink === s.sellerToken ? t('shipLinkCopied') : t('shipCopySellerLink')}
                    </button>
                  )}
                  {!s.sellerToken && (
                    <button className="btn ghost sm" onClick={() => regenLink(s.id)}>
                      {t('shipMakeSellerLink')}
                    </button>
                  )}
                  <button className="btn ghost sm" style={{ color: 'var(--neg)' }} onClick={() => doDelete(s.id)}>
                    {t('delete')}
                  </button>
                </>
              )}
              {canVoid && confirmVoid !== s.id && (
                <button
                  className="btn ghost sm"
                  style={{ color: 'var(--neg)' }}
                  disabled={voiding === s.id}
                  onClick={() => setConfirmVoid(s.id)}
                >
                  {voiding === s.id ? '…' : t('shipVoid')}
                </button>
              )}
              {canVoid && confirmVoid === s.id && (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--neg)' }}>{t('shipVoidConfirm', { amount: fmtMoney(s.labelCost ?? 0, s.rateCurrency) })}</span>
                  <button className="btn sm" style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }} onClick={() => doVoid(s.id)}>
                    {t('shipVoidYes')}
                  </button>
                  <button className="btn ghost sm" onClick={() => setConfirmVoid(null)}>{t('cancel')}</button>
                </span>
              )}
              {s.from.name && s.from.city && (
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                  {t('shipFromTo', { name: s.from.name, city: s.from.city, state: s.from.state ?? '' })}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {flowFor && (
        <LabelFlowModal
          orderId={orderId}
          existing={flowFor === 'new' ? null : flowFor}
          onClose={() => setFlowFor(null)}
          onDone={() => { setFlowFor(null); reload(); onMutated(); }}
          onSellerLinked={() => { reload(); onMutated(); }}
        />
      )}
    </div>
  );
}

// ── Create / continue flow: address+package → rates → confirm ────────────────

function LabelFlowModal({ orderId, existing, onClose, onDone, onSellerLinked }: {
  orderId: string;
  existing: Shipment | null;
  onClose: () => void;
  onDone: () => void;
  // Fired when a seller link was issued from inside the modal, so the panel
  // list refreshes behind it without closing the form.
  onSellerLinked: () => void;
}) {
  const { t } = useT();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [shipment, setShipment] = useState<Shipment | null>(existing);
  const [rates, setRates] = useState<ShipmentRate[]>([]);
  const [picked, setPicked] = useState<ShipmentRate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // The seller-link path from inside the form: reuse this modal's shipment if
  // it already exists (issuing/rotating its token), else create the empty
  // shell. The link lands on the clipboard; the modal stays open so the
  // purchaser can still switch to filling it in manually.
  const copySellerLink = async () => {
    setLinkBusy(true);
    setError(null);
    try {
      let tok: string;
      if (shipment) {
        tok = shipment.sellerToken ?? (await issueSellerLink(orderId, shipment.id)).sellerToken;
      } else {
        const r = await createShipment(orderId, { sellerFill: true });
        setShipment(r.shipment);
        tok = r.shipment.sellerToken!;
      }
      await navigator.clipboard?.writeText(`${window.location.origin}/s/${tok}`);
      setLinkCopied(true);
      onSellerLinked();
    } catch (e) {
      setError((e as { message?: string })?.message ?? t('shipRatesFailed'));
    } finally {
      setLinkBusy(false);
    }
  };

  const [from, setFrom] = useState<ShipmentAddressInput>({
    name: existing?.from.name ?? '',
    phone: existing?.from.phone ?? '',
    street1: existing?.from.street1 ?? '',
    street2: existing?.from.street2 ?? '',
    city: existing?.from.city ?? '',
    state: existing?.from.state ?? '',
    zip: existing?.from.zip ?? '',
    country: existing?.from.country ?? 'US',
  });
  const [pkg, setPkg] = useState<{ weightOz: string; lengthIn: string; widthIn: string; heightIn: string }>({
    weightOz: existing?.package.weightOz != null ? String(existing.package.weightOz) : '',
    lengthIn: existing?.package.lengthIn != null ? String(existing.package.lengthIn) : '',
    widthIn: existing?.package.widthIn != null ? String(existing.package.widthIn) : '',
    heightIn: existing?.package.heightIn != null ? String(existing.package.heightIn) : '',
  });

  const setF = (k: keyof ShipmentAddressInput, v: string) => setFrom((p) => ({ ...p, [k]: v }));
  const setP = (k: keyof typeof pkg, v: string) => setPkg((p) => ({ ...p, [k]: v }));

  const pkgParsed = (): ShipmentPackageInput | null => {
    const n = (s: string) => { const v = Number(s); return Number.isFinite(v) && v > 0 ? v : null; };
    const weightOz = n(pkg.weightOz), lengthIn = n(pkg.lengthIn), widthIn = n(pkg.widthIn), heightIn = n(pkg.heightIn);
    if (weightOz == null || lengthIn == null || widthIn == null || heightIn == null) return null;
    return { weightOz, lengthIn, widthIn, heightIn };
  };
  const step1Ready = !!(from.name.trim() && from.street1.trim() && from.city.trim()
    && from.state.trim() && from.zip.trim() && pkgParsed());

  const toRates = async () => {
    const p = pkgParsed();
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      const saved = shipment
        ? (await updateShipment(orderId, shipment.id, { from, package: p })).shipment
        : (await createShipment(orderId, { from, package: p })).shipment;
      setShipment(saved);
      const r = await fetchShipmentRates(orderId, saved.id);
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
    setBusy(true);
    setError(null);
    try {
      await buyShipmentLabel(orderId, shipment.id, { rateId: picked.rateId, expectedAmount: picked.amount });
      onDone();
    } catch (e) {
      setError((e as { message?: string })?.message ?? t('shipBuyFailed'));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-shell" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            {step === 1 ? t('shipFlowTitle1') : step === 2 ? t('shipFlowTitle2') : t('shipFlowTitle3')}
          </div>
          <button className="btn icon" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          {step === 1 && (
            <>
              {/* The no-typing path first: most sellers can fill this in
                  faster and more accurately than a chat transcription. */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px', borderRadius: 10, marginBottom: 4,
                background: 'var(--accent-soft)',
                border: '1px dashed color-mix(in oklch, var(--accent) 45%, transparent)',
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--accent-strong)' }}>
                    {t('shipAskSeller')}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 1 }}>
                    {linkCopied ? t('shipLinkCopiedHint') : t('shipAskSellerHint')}
                  </div>
                </div>
                <button
                  className={'btn sm' + (linkCopied ? '' : ' accent')}
                  disabled={linkBusy}
                  onClick={copySellerLink}
                  style={{ flexShrink: 0 }}
                >
                  {linkBusy ? '…' : linkCopied ? t('shipLinkCopied') : t('shipCopySellerLink')}
                </button>
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 4px',
                fontSize: 11, fontWeight: 600, letterSpacing: '0.07em',
                textTransform: 'uppercase', color: 'var(--fg-subtle)',
              }}>
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                {t('shipOrManual')}
                <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label">{t('shipSellerName')} <span className="req">*</span></label>
                  <input className="input" value={from.name} onChange={(e) => setF('name', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">{t('shipSellerPhone')}</label>
                  <input className="input" value={from.phone ?? ''} onChange={(e) => setF('phone', e.target.value)} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label">{t('shipStreet')} <span className="req">*</span></label>
                  <input className="input" value={from.street1} onChange={(e) => setF('street1', e.target.value)} />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label">{t('shipStreet2')}</label>
                  <input className="input" value={from.street2 ?? ''} onChange={(e) => setF('street2', e.target.value)} />
                </div>
              </div>
              <div className="field-row" style={{ gridTemplateColumns: '1.4fr 0.6fr 0.9fr' }}>
                <div className="field">
                  <label className="label">{t('shipCity')} <span className="req">*</span></label>
                  <input className="input" value={from.city} onChange={(e) => setF('city', e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">{t('shipState')} <span className="req">*</span></label>
                  <input className="input" value={from.state} onChange={(e) => setF('state', e.target.value.toUpperCase())} />
                </div>
                <div className="field">
                  <label className="label">{t('shipZip')} <span className="req">*</span></label>
                  <input className="input mono" value={from.zip} onChange={(e) => setF('zip', e.target.value)} />
                </div>
              </div>
              <div className="field-row" style={{ marginTop: 6 }}>
                <div className="field">
                  <label className="label">{t('shipWeightOz')} <span className="req">*</span></label>
                  <input className="input mono" type="number" min={0} value={pkg.weightOz} onChange={(e) => setP('weightOz', e.target.value)} />
                </div>
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
              </div>
            </>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rates.map((r) => {
                const sel = picked?.rateId === r.rateId;
                return (
                  <button
                    key={r.rateId}
                    type="button"
                    onClick={() => setPicked(r)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                      border: '1px solid ' + (sel ? 'var(--accent)' : 'var(--border-strong)'),
                      boxShadow: sel ? '0 0 0 3px var(--accent-soft)' : 'none',
                      borderRadius: 10, padding: '11px 14px', background: 'var(--bg-elev)',
                      cursor: 'pointer', font: 'inherit', color: 'inherit',
                    }}
                  >
                    <span style={{
                      width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                      border: '1.5px solid ' + (sel ? 'var(--accent)' : 'var(--border-strong)'),
                      display: 'grid', placeItems: 'center',
                    }}>
                      {sel && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />}
                    </span>
                    <span>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{r.carrier}</span>{' '}
                      <span style={{ color: 'var(--fg-muted)', fontSize: 12.5 }}>{r.service}</span>
                    </span>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--fg-subtle)' }}>
                      {r.deliveryDays != null ? t('shipDays', { n: r.deliveryDays }) : ''}
                    </span>
                    <span className="mono" style={{ fontWeight: 600, fontSize: 14, width: 72, textAlign: 'right', color: sel ? 'var(--accent-strong)' : 'inherit' }}>
                      {fmtMoney(r.amount, r.currency)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {step === 3 && picked && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <ConfirmRow k={t('shipConfirmCarrier')} v={`${picked.carrier} ${picked.service}`} />
              <ConfirmRow k={t('shipConfirmFrom')} v={`${from.city}, ${from.state} ${from.zip}`} />
              <ConfirmRow k={t('shipConfirmCharge')} v={fmtMoney(picked.amount, picked.currency)} strong />
              <div style={{
                display: 'flex', gap: 8, alignItems: 'flex-start',
                background: 'var(--warn-soft)', color: 'var(--warn-strong)',
                border: '1px solid color-mix(in oklch, var(--warn-strong) 25%, transparent)',
                borderRadius: 8, padding: '9px 12px', fontSize: 12.5, lineHeight: 1.45,
              }}>
                {t('shipBuyWarning', { amount: fmtMoney(picked.amount, picked.currency) })}
              </div>
            </div>
          )}

          {error && (
            <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--neg)' }}>{error}</div>
          )}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <div>
            {step > 1 && (
              <button className="btn" onClick={() => { setError(null); setStep(step === 3 ? 2 : 1); }} disabled={busy}>
                {t('back')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
            {step === 1 && (
              <button className="btn accent" onClick={toRates} disabled={busy || !step1Ready}>
                {busy ? '…' : t('shipGetRates')}
              </button>
            )}
            {step === 2 && (
              <button className="btn accent" onClick={() => setStep(3)} disabled={!picked}>
                {t('shipContinue')}
              </button>
            )}
            {step === 3 && picked && (
              <button className="btn accent" onClick={buy} disabled={busy}>
                {busy ? '…' : t('shipBuyBtn', { amount: fmtMoney(picked.amount, picked.currency) })}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfirmRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', fontSize: 13,
      borderTop: strong ? '1px solid var(--border)' : 'none',
      paddingTop: strong ? 10 : 0,
    }}>
      <span style={{ color: 'var(--fg-muted)' }}>{k}</span>
      <span className={strong ? 'mono' : undefined} style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );
}
