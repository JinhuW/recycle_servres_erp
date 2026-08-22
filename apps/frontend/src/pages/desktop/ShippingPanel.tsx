import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { deleteShipment, issueSellerLink, listShipments, voidShipment } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtMoney } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/route';
import { STATUS_CHIP, fmtEta } from '../../lib/shippingList';
import type { Shipment, ShipmentStatus } from '../../lib/types';

// Prepaid labels for the seller, one shipment per box. Creation and continue
// live on the full-page wizard (/shipping/:orderId/label); purchased shipments
// render a status timeline with tracking, ETA, label download, and void.

type Props = {
  orderId: string;
  canEdit: boolean;
  onMutated: () => void; // parent bumps the activity log
  // Gates the delivered → "complete the PO" nudge; omitted where the PO is
  // already on screen.
  orderLifecycle?: string;
};

const TIMELINE: ShipmentStatus[] = ['draft', 'purchased', 'in_transit', 'delivered'];
// voided / exception render as badge states, not timeline steps.
const TIMELINE_POS: Partial<Record<ShipmentStatus, number>> = {
  draft: 0, quoted: 0, purchased: 1, in_transit: 2, delivered: 3,
};

export function ShippingPanel({ orderId, canEdit, onMutated, orderLifecycle }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [items, setItems] = useState<Shipment[]>([]);
  const [loaded, setLoaded] = useState(false);
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
      <div className={'ship-panel-head' + (items.length || !loaded ? '' : ' bare')}>
        <Icon name="label" size={15} />
        <span className="ship-panel-title">{t('shipPanelTitle')}</span>
        {items.length > 0 && <span className="ship-panel-count">{items.length}</span>}
        <span style={{ flex: 1 }} />
        {canEdit && (
          <button className="btn accent sm" onClick={() => navigate(`/shipping/${orderId}/label`)}>
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
          <div key={s.id} className={'ship-block' + (s.status === 'voided' ? ' voided' : '')}>
            <div className="ship-block-head">
              {s.carrier ? (
                <>
                  <span className="ship-block-carrier">{s.carrier}</span>
                  <span className="ship-block-service">{s.service}</span>
                </>
              ) : (
                <span className="ship-block-carrier">
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
              {s.labelCost != null && (
                <span className={'mono ship-block-cost' + (s.status === 'voided' ? ' voided' : '')}>
                  {fmtMoney(s.labelCost, s.rateCurrency)}
                </span>
              )}
            </div>

            {pos !== undefined && pos >= 1 && (
              <div>
                <div className="ship-timeline">
                  {TIMELINE.map((step, i) => {
                    const done = i < pos || (i === pos && step === 'delivered');
                    const now = i === pos && step !== 'delivered';
                    return (
                      <div key={step} className={'ship-tl-seg' + (i === TIMELINE.length - 1 ? ' last' : '')}>
                        <div className={'ship-tl-node' + (done ? ' done' : now ? ' now' : '')}>
                          {done ? '✓' : now ? '●' : ''}
                        </div>
                        {i < TIMELINE.length - 1 && (
                          <div className={'ship-tl-bar' + (i < pos ? ' done' : '')} />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="ship-tl-labels">
                  <span>{t('shipStepCreated')}</span>
                  <span className={pos === 1 ? 'now' : ''}>{t('shipStatusPurchased')}</span>
                  <span className={pos === 2 ? 'now' : ''}>{t('shipStatusInTransit')}</span>
                  <span className={pos === 3 ? 'done' : ''}>{t('shipStatusDelivered')}</span>
                </div>
              </div>
            )}

            {s.status === 'exception' && s.trackingStatus && (
              <div className="ship-exception-note">
                {t('shipExceptionNote', { status: s.trackingStatus })}
              </div>
            )}

            {s.status === 'delivered' && orderLifecycle != null && orderLifecycle !== 'done' && (
              <div className="ship-delivered-cta">
                <Icon name="check2" size={15} />
                <span>{t('shipDeliveredCtaHint')}</span>
                <button className="btn accent sm" onClick={() => navigate(`/purchase-orders/${orderId}`)}>
                  {t('shipCompletePo')}
                </button>
              </div>
            )}

            <div className="ship-meta">
              {eta && s.status !== 'delivered' && s.status !== 'voided' && (
                <span>
                  <span className="ship-eta-label">{t('shipEta')}</span>
                  <span className="ship-eta-value">{eta}</span>
                </span>
              )}
              {s.trackingNumber && (
                <button
                  type="button"
                  className="ship-copy-btn mono"
                  onClick={() => copyTracking(s.trackingNumber!)}
                  title={t('shipCopyTracking')}
                >
                  {s.trackingNumber}
                  <span className={'ship-copy-hint' + (copied === s.trackingNumber ? ' done' : '')}>
                    {copied === s.trackingNumber ? t('shipCopied') : t('shipCopy')}
                  </span>
                </button>
              )}
              {s.trackingUrl && (
                <a href={s.trackingUrl} target="_blank" rel="noreferrer">
                  {t('shipTrackOnCarrier', { carrier: s.carrier ?? '' })} ↗
                </a>
              )}
            </div>

            <div className="ship-actions">
              {s.labelUrl && (
                <a className="btn sm" href={s.labelUrl} target="_blank" rel="noreferrer" download>
                  <Icon name="download" size={13} /> {t('shipDownloadLabel')}
                </a>
              )}
              {isPending && canEdit && (
                <>
                  <button className="btn accent sm" onClick={() => navigate(`/shipping/${orderId}/label/${s.id}`)}>
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
                <span className="ship-from-note">
                  {t('shipFromTo', { name: s.from.name, city: s.from.city, state: s.from.state ?? '' })}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
