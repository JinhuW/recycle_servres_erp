import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import { ImageLightbox } from '../../../components/ImageLightbox';
import { fmtUSD } from '../../../lib/format';
import type { Line } from '../DesktopSubmit';
import { useT } from '../../../lib/i18n';
import { RamFields, SsdFields, HddFields, OtherFields } from './LineFields';

// ─── LineDrawer ──────────────────────────────────────────────────────────────
// When `editing` is true (e.g. used by DesktopEditOrder), the pricing grid
// grows a 4th column for sell-price and a Revenue/Profit/Margin summary
// appears underneath — matching design/dashboard.jsx#EditOrderPage which
// passes `editing={true}` to the shared OrderForm.
export function LineDrawer({
  line, idx, onChange, onClose, onRemove, canRemove, editing = false,
  onConfirmLine, onConfirmError,
}: {
  line: Line;
  idx: number;
  onChange: (patch: Partial<Line>) => void;
  onClose: () => void;
  onRemove: () => void;
  canRemove: boolean;
  editing?: boolean;
  onConfirmLine?: () => Promise<void>;
  onConfirmError?: (msg: string) => void;
}) {
  const { lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [confirming, setConfirming] = useState(false);
  const cat = line.category;
  const set = (patch: Partial<Line>) => onChange(patch);
  const [lightbox, setLightbox] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const scanUrl = line.scanImageUrl ?? null;
  const showThumb =
    editing &&
    !!scanUrl &&
    !scanUrl.startsWith('data:image/placeholder') &&
    !thumbBroken;

  const qty = Number(line.qty) || 0;
  const cost = Number(line.unitCost) || 0;
  const sellPrice = line.sellPrice == null || line.sellPrice === '' ? 0 : Number(line.sellPrice);
  const revenue = qty * sellPrice;
  const profit = qty * (sellPrice - cost);
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const lossy = sellPrice > 0 && sellPrice < cost;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 80 }}
      onClick={onClose}
    >
      <div
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0,
          width: '100%', maxWidth: 620,
          background: 'var(--bg)',
          boxShadow: '-12px 0 40px rgba(15,23,42,0.18)',
          overflowY: 'auto',
          animation: 'drawer-in 0.2s ease-out',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="card" style={{ overflow: 'hidden', borderRadius: 0, border: 'none', boxShadow: 'none' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '14px 18px', background: 'var(--bg-soft)',
            borderBottom: '1px solid var(--border)',
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'var(--bg-elev)', border: '1px solid var(--border)',
              display: 'grid', placeItems: 'center',
              fontSize: 13, fontWeight: 600, color: 'var(--fg-muted)',
              flexShrink: 0,
            }}>{idx + 1}</div>
            <div style={{
              width: 56, height: 56, borderRadius: 8,
              background: 'var(--bg-elev)', border: '1px solid var(--border)',
              display: 'grid', placeItems: 'center', color: 'var(--fg-subtle)',
              flexShrink: 0,
            }}>
              <Icon name={cat === 'RAM' ? 'chip' : (cat === 'SSD' || cat === 'HDD') ? 'drive' : 'box'} size={20} />
            </div>
            {showThumb && (
              <button
                type="button"
                onClick={() => setLightbox(true)}
                title="View AI photo"
                style={{
                  width: 56, height: 56, borderRadius: 8,
                  border: '1px solid var(--border)', overflow: 'hidden',
                  padding: 0, background: 'var(--bg-elev)',
                  cursor: 'pointer', flexShrink: 0,
                }}
              >
                <img
                  src={scanUrl!}
                  alt="AI photo"
                  onError={() => setThumbBroken(true)}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              </button>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className={'chip ' + (cat === 'RAM' ? 'info' : cat === 'SSD' ? 'pos' : cat === 'HDD' ? 'cool' : 'warn')}>{cat}</span>
                <span>
                  {cat === 'RAM' && `${line.brand ?? '—'} ${line.capacity ?? ''} ${line.generation ?? ''}`.trim()}
                  {cat === 'SSD' && `${line.brand ?? '—'} ${line.capacity ?? ''} ${line.interface ?? ''}`.trim()}
                  {cat === 'HDD' && `${line.brand ?? '—'} ${line.capacity ?? ''} ${line.rpm ? line.rpm + 'rpm' : ''}`.trim()}
                  {cat === 'Other' && (line.description ?? 'Untitled item')}
                </span>
              </div>
              {(line.brand || line.description) && (
                <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2, fontFamily: 'JetBrains Mono, monospace' }}>
                  {line.partNumber || '—'} · qty {line.qty} · cost {fmtUSD(qty * cost, locale)}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn icon sm" onClick={onClose} title="Close edit">
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>

          <div style={{ padding: 16, display: 'grid', gap: 14 }}>
            {!editing && line.scanImageUrl && (
              <img
                src={line.scanImageUrl}
                alt="Captured label"
                style={{ maxWidth: 220, borderRadius: 8, border: '1px solid var(--border)', marginBottom: 12 }}
              />
            )}
            {cat === 'RAM' && <RamFields line={line} set={set} />}
            {cat === 'SSD' && <SsdFields line={line} set={set} />}
            {cat === 'HDD' && <HddFields line={line} set={set} />}
            {cat === 'Other' && <OtherFields line={line} set={set} />}

            <div style={{
              display: 'grid',
              gridTemplateColumns: editing ? '90px 1fr 1fr 1fr' : '120px 1fr 1fr',
              gap: 14, alignItems: 'end',
              padding: 14, background: 'var(--bg-soft)', borderRadius: 10,
            }}>
              <div className="field">
                <label className="label">Qty <span className="req">*</span></label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={line.qty}
                  onChange={e => set({ qty: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">Unit cost <span className="req">*</span></label>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={line.unitCost}
                  onChange={e => set({ unitCost: e.target.value, totalCost: undefined })}
                  placeholder="0.00"
                />
              </div>
              <div className="field">
                <label className="label">Total cost</label>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={line.totalCost !== undefined ? line.totalCost : (qty * cost ? (qty * cost).toFixed(2) : '')}
                  onChange={e => {
                    const v = e.target.value;
                    const newTotal = Number(v);
                    const newUnit = qty > 0 && newTotal > 0 ? +(newTotal / qty).toFixed(2) : line.unitCost;
                    set({ totalCost: v, unitCost: String(newUnit) });
                  }}
                  placeholder="0.00"
                />
              </div>
              {editing && (
                <div className="field">
                  <label className="label">Sell / unit</label>
                  <input
                    className="input mono"
                    type="number"
                    step="0.01"
                    min={0}
                    value={line.sellPrice ?? ''}
                    onChange={e => set({ sellPrice: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              )}
            </div>
            {editing && (
              <div style={{
                display: 'flex', gap: 18, fontSize: 12, color: 'var(--fg-subtle)',
                padding: '0 4px', flexWrap: 'wrap',
              }}>
                <span>Revenue <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtUSD(revenue, locale)}</span></span>
                <span>Profit <span className="mono" style={{ color: profit >= 0 ? 'var(--pos)' : 'var(--warn)', fontWeight: 600 }}>{fmtUSD(profit, locale)}</span></span>
                <span>Margin <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{margin.toFixed(1)}%</span></span>
                {lossy && <span style={{ color: 'var(--warn)', fontWeight: 600 }}>⚠ Sell price below unit cost</span>}
              </div>
            )}
          </div>

          <div style={{
            display: 'flex', justifyContent: 'space-between', gap: 8,
            padding: '12px 18px',
            borderTop: '1px solid var(--border)', background: 'var(--bg-soft)',
          }}>
            <button
              className="btn"
              onClick={() => { onRemove(); onClose(); }}
              disabled={!canRemove}
              style={canRemove ? { color: 'var(--neg)' } : undefined}
            >
              <Icon name="trash" size={13} /> Remove line
            </button>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {line._confirmed && (
                <span className="chip pos" style={{ fontSize: 11 }}>
                  <Icon name="check" size={10} /> Confirmed
                </span>
              )}
              <button className="btn" onClick={onClose}>Cancel</button>
              <button
                className="btn accent"
                disabled={confirming || line._confirmed}
                onClick={async () => {
                  if (line._confirmed) { onClose(); return; }
                  if (!onConfirmLine) { onClose(); return; }
                  setConfirming(true);
                  try {
                    await onConfirmLine();
                    onClose();
                  } catch (e) {
                    onConfirmError?.(e instanceof Error ? e.message : 'Failed to confirm line');
                  } finally {
                    setConfirming(false);
                  }
                }}
              >
                <Icon name="check" size={13} /> {confirming ? 'Confirming…' : 'Confirm line'}
              </button>
            </div>
          </div>
        </div>
      </div>
      {lightbox && scanUrl && (
        <ImageLightbox url={scanUrl} alt="AI photo" onClose={() => setLightbox(false)} />
      )}
    </div>
  );
}
