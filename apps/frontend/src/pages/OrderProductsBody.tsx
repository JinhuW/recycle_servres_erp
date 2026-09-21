import { Icon } from '../components/Icon';
import { LineSpecChips, lineHasSpecChips } from '../components/LineSpecChips';
import { SerialNumbers } from '../components/SerialNumbers';
import { useT } from '../lib/i18n';
import { linePhotos, type LinePhoto } from '../lib/linePhotos';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import type { Order, OrderLine } from '../lib/types';

// How many of a line's photos the strip shows before it offers the rest. Four
// 44px tiles is what fits next to the line's controls on a small phone.
const PHOTOS_COLLAPSED = 4;

// A tap stops here: the card around it opens the editor.
function PhotoTile({ photo, label, onOpen }: { photo: LinePhoto; label: string; onOpen: (url: string) => void }) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onOpen(photo.url); }}
      title={photo.filename ?? label}
      style={{
        width: 44, height: 44, borderRadius: 8, flexShrink: 0,
        border: '1px solid var(--border)', overflow: 'hidden',
        padding: 0, background: 'var(--bg-soft)', cursor: 'pointer',
      }}
    >
      <img
        src={photo.url}
        alt={label}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </button>
  );
}

export const itemLabel = (l: OrderLine) =>
    l.category === 'RAM' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()
  : l.category === 'SSD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()
  : l.category === 'HDD' ? `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()
  : (l.description ?? '—');

type Props = {
  order: Order;
  canEditOrder: boolean;
  showFinalSell: boolean;
  locale: string;
  expandedPhotos: ReadonlySet<string>;
  onExpandPhotos: (lineId: string) => void;
  onOpenPhoto: (url: string) => void;
  onEditLine: (idx: number) => void;
  onRemoveLine: (lineId: string) => void;
};

/**
 * The PO's line cards — the products screen's body. State-free on purpose:
 * the order copy, the revert warning and the remove/lightbox dialogs stay
 * with OrderDetail, which renders both PO screens from one instance so a
 * line removed here is already gone when the info screen shows again.
 */
export function OrderProductsBody({
  order, canEditOrder, showFinalSell, locale, expandedPhotos,
  onExpandPhotos, onOpenPhoto, onEditLine, onRemoveLine,
}: Props) {
  const { t } = useT();

  if (order.lines.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--fg-subtle)', fontSize: 13, lineHeight: 1.5 }}>
        <Icon name="box" size={22} style={{ opacity: 0.5, marginBottom: 8 }} />
        <div>{canEditOrder ? t('poProductsEmpty') : t('poProductsNone')}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {order.lines.map((l, i) => {
        const [lead, ...rest] = linePhotos(l);
        const shown = expandedPhotos.has(l.id) ? rest : rest.slice(0, PHOTOS_COLLAPSED);
        const hidden = rest.length - shown.length;
        return (
        <div
          key={l.id}
          className="ph-line"
          onClick={canEditOrder ? () => { onEditLine(i); } : undefined}
          style={canEditOrder ? { cursor: 'pointer' } : undefined}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="lb-rank" style={{ width: 22, height: 22, fontSize: 11 }}>{i + 1}</span>
            {/* The photo is what the line is recognised by, so it leads. */}
            {lead && <PhotoTile photo={lead} label={t('linePhotos')} onOpen={onOpenPhoto} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                {l.category === 'Other' && !!(l.itemType ?? '').trim() && (
                  <span className="chip">{l.itemType}</span>
                )}
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{itemLabel(l) || '—'}</span>
              </div>
              {lineHasSpecChips(l)
                ? <LineSpecChips line={l} />
                : l.partNumber && (
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.partNumber}
                  </div>
                )}
              {l.serialNumber && (
                <div style={{ marginTop: 5 }}>
                  <SerialNumbers raw={l.serialNumber} max={4} size={10.5} />
                </div>
              )}
            </div>
            {canEditOrder && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); onEditLine(i); }}
                  className="ph-icon-btn"
                  style={{ width: 28, height: 28, color: 'var(--fg-subtle)' }}
                  aria-label={t('edit')}
                >
                  <Icon name="edit" size={13} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemoveLine(l.id); }}
                  className="ph-icon-btn"
                  style={{ width: 28, height: 28, color: 'var(--fg-subtle)' }}
                  aria-label={t('delete')}
                >
                  <Icon name="trash" size={13} />
                </button>
              </>
            )}
          </div>
          {/* The rest of the line's pictures, not just the first — the
              phone is where they are taken, so it is where they are
              checked. */}
          {rest.length > 0 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {shown.map(p => (
                <PhotoTile key={p.id} photo={p} label={t('linePhotos')} onOpen={onOpenPhoto} />
              ))}
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    onExpandPhotos(l.id);
                  }}
                  aria-label={t('linePhotosShowAll', { n: hidden })}
                  style={{
                    width: 44, height: 44, borderRadius: 8, flexShrink: 0,
                    border: '1px dashed var(--border-strong)', background: 'var(--bg-soft)',
                    color: 'var(--fg-muted)', fontFamily: 'inherit',
                    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0,
                  }}
                >
                  +{hidden}
                </button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
            <span>{t('qty')} <span style={{ color: 'var(--accent-strong)', fontWeight: 700, background: 'var(--accent-soft)', padding: '0 6px', borderRadius: 6, fontVariantNumeric: 'tabular-nums' }}>{l.qty}</span> · {fmtUSD(l.unitCost, locale)}</span>
            <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(l.qty * l.unitCost, locale)}</span>
          </div>
          {showFinalSell && l.finalSellPrice != null && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
              <span>{t('finalSellPrice')}</span>
              <span className="mono" style={{ fontWeight: 600 }}>
                {fmtUSD(l.finalSellPrice, locale)}
                {l.finalSoldQty != null && l.finalSoldQty !== l.qty && (
                  <span style={{ marginLeft: 4, fontWeight: 400 }}>×{l.finalSoldQty}</span>
                )}
              </span>
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}
