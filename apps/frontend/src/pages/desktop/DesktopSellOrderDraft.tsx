import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtUSD, fmtMoney, fmtDate } from '../../lib/format';
import { fetchRateToUsd, type FxInfo } from '../../lib/fxRate';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { useT } from '../../lib/i18n';

type Currency = 'USD' | 'CNY';

// Draft-sell-order modal: manager picks items off Inventory, the modal lets
// them pick a customer, tweak qty / unit price per line, and save a Draft sell
// order via POST /api/sell-orders. Lifted from design/sell-orders.jsx with
// the inline-customer-create and tracking-attachment flow trimmed.

export type DraftItem = {
  id: string;                            // backend inventory_id (order_lines.id)
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
  label: string;                         // pre-formatted, e.g. "Samsung 32GB DDR4"
  subLabel?: string | null;              // "RDIMM · 3200MHz" etc
  partNumber: string | null;
  qty: number;                           // max sellable qty
  unitCost: number;
  sellPrice: number | null;              // suggested list price
  warehouseId: string | null;
  warehouseShort: string | null;
  condition: string;
};

export type Customer = {
  id: string;
  name: string;
  short_name: string | null;
  region: string | null;
};

// Minimal slice of GET /api/members — the picker only needs id + name.
export type MemberOption = {
  id: string;
  name: string;
};

type Line = {
  inventoryId: string;
  category: 'RAM' | 'SSD' | 'HDD' | 'Other';
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  qty: number;
  maxQty: number;
  unitCost: number;
  unitPrice: number;
  listPrice: number;
  warehouseId: string | null;
  warehouseShort: string | null;
  condition: string;
};

type Props = {
  items: DraftItem[];
  onClose: () => void;
  onSaved: (id: string) => void;
};

export function DesktopSellOrderDraft({ items, onClose, onSaved }: Props) {
  const { lang, t } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<string>('');
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [paymentReceivedBy, setPaymentReceivedBy] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-order currency. Line prices are entered in it; the FX snapshot (only
  // needed for non-USD) drives the USD-equivalent preview and profit math.
  const [currency, setCurrency] = useState<Currency>('USD');
  const [fx, setFx] = useState<FxInfo | null>(null);

  useEffect(() => {
    if (currency === 'USD') { setFx(null); return; }
    let alive = true;
    fetchRateToUsd(currency)
      .then(info => { if (alive) setFx(info); })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, [currency]);

  const [lines, setLines] = useState<Line[]>(() =>
    items.map(it => ({
      inventoryId: it.id,
      category:    it.category,
      label:       it.label,
      subLabel:    it.subLabel ?? null,
      partNumber:  it.partNumber,
      qty:         it.qty,
      maxQty:      it.qty,
      unitCost:    it.unitCost,
      unitPrice:   it.sellPrice ?? +(it.unitCost * 1.35).toFixed(2),
      listPrice:   it.sellPrice ?? +(it.unitCost * 1.35).toFixed(2),
      warehouseId: it.warehouseId,
      warehouseShort: it.warehouseShort,
      condition:   it.condition,
    })),
  );

  // Load customers; default the picker to the first one if available.
  useEffect(() => {
    api.get<{ items: Customer[] }>('/api/customers')
      .then(r => {
        setCustomers(r.items);
        if (r.items.length && !customerId) {
          setCustomerId(r.items[0].id);
        }
      })
      .catch(handleFetchError);
    api.get<{ items: MemberOption[] }>('/api/members')
      .then(r => setMembers(r.items))
      .catch(handleFetchError);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes.
  useEscapeKey(onClose);

  // rateToUsd multiplies a native amount to USD. For CNY it's null until the
  // FX snapshot loads, which is why the USD-derived figures are nullable.
  const rateToUsd = currency === 'USD' ? 1 : (fx?.rateToUsd ?? null);

  const totals = useMemo(() => {
    let subtotalNative = 0, cost = 0, units = 0;
    lines.forEach(l => {
      subtotalNative += l.qty * l.unitPrice;   // native (order currency)
      cost           += l.qty * l.unitCost;    // USD cost basis
      units          += l.qty;
    });
    const subtotalUsd = rateToUsd == null ? null : +(subtotalNative * rateToUsd).toFixed(2);
    const profit = subtotalUsd == null ? null : +(subtotalUsd - cost).toFixed(2);
    const margin = subtotalUsd && subtotalUsd > 0 && profit != null
      ? (profit / subtotalUsd) * 100 : null;
    return {
      subtotalNative: +subtotalNative.toFixed(2),
      subtotalUsd,
      cost:   +cost.toFixed(2),
      profit,
      margin,
      units,
    };
  }, [lines, rateToUsd]);

  // Group lines by warehouse for visual rhythm
  const grouped = useMemo(() => {
    const map = new Map<string, { warehouseShort: string | null; items: Array<Line & { _idx: number }> }>();
    lines.forEach((l, idx) => {
      const key = l.warehouseId ?? '__none';
      if (!map.has(key)) map.set(key, { warehouseShort: l.warehouseShort, items: [] });
      map.get(key)!.items.push({ ...l, _idx: idx });
    });
    return [...map.values()];
  }, [lines]);

  const setLine = (idx: number, patch: Partial<Line>) =>
    setLines(arr => arr.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  const removeLine = (idx: number) =>
    setLines(arr => arr.filter((_, i) => i !== idx));

  const rateMissing = currency !== 'USD' && rateToUsd == null;
  const canSubmit = lines.length > 0 && lines.every(l => l.qty > 0) && !!customerId && !rateMissing;

  const saveDisabledReason: string | null =
    saving                                ? null
  : lines.length === 0                    ? 'Add at least one item before saving.'
  : !customerId                           ? 'Pick a customer before saving.'
  : lines.some(l => l.qty <= 0)           ? 'Every line needs a quantity greater than zero.'
  : rateMissing                           ? 'Waiting for the exchange rate…'
  : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.post<{ ok: true; id: string }>('/api/sell-orders', {
        customerId,
        notes,
        currency,
        paymentReceivedBy: paymentReceivedBy || null,
        lines: lines.map(l => ({
          inventoryId: l.inventoryId,
          category:    l.category,
          label:       l.label,
          subLabel:    l.subLabel,
          partNumber:  l.partNumber,
          qty:         l.qty,
          unitPrice:   l.unitPrice,
          warehouseId: l.warehouseId,
          condition:   l.condition,
        })),
      });
      onSaved(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal-shell"
        style={{ maxWidth: 1100, width: 'calc(100vw - 80px)', maxHeight: 'calc(100vh - 60px)' }}
      >
        {/* Header */}
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0,
        }}>
          <div>
            <div style={{
              fontSize: 11, color: 'var(--fg-subtle)',
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4,
            }}>
              {t('sodNewDraftOverline')}
            </div>
            <h2 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.01em', margin: 0 }}>
              {t('sodItemsFromInventory', { n: lines.length })}
            </h2>
          </div>
          <button className="btn icon" onClick={onClose} title={t('closeBtn')}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Body — two columns */}
        <div className="so-body">
          <div className="so-main">
            {/* Customer */}
            <div className="so-section">
              <div className="so-section-head">
                <Icon name="user" size={14} /> {t('fieldCustomer')}
              </div>
              <div>
                <label className="so-label">{t('fieldCustomer')}</label>
                <CustomerPicker
                  customers={customers}
                  value={customerId}
                  onChange={(id) => {
                    setCustomerId(id);
                  }}
                  onCreated={(c) => {
                    setCustomers((prev) => [...prev, c]);
                  }}
                />
              </div>
              <div style={{ marginTop: 12 }}>
                <label className="so-label">{t('currency.label')}</label>
                <CurrencyPicker value={currency} onChange={setCurrency} t={t} />
              </div>
              <div style={{ marginTop: 12 }}>
                <label className="so-label">{t('paymentReceiverLabel')}</label>
                <select
                  className="select"
                  value={paymentReceivedBy}
                  onChange={e => setPaymentReceivedBy(e.target.value)}
                >
                  <option value="">{t('paymentReceiverNone')}</option>
                  {members.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Line items */}
            <div className="so-section">
              <div className="so-section-head">
                <Icon name="inventory" size={14} /> {t('sodLineItems')}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 400 }}>
                  {t('sodLineSummary', { units: totals.units, lines: lines.length, whs: grouped.length })}
                </span>
              </div>

              {grouped.map((g, gi) => (
                <div key={(g.warehouseShort ?? '__none') + gi} style={{ marginBottom: 14 }}>
                  <div className="so-wh-head">
                    <Icon name="warehouse" size={12} />
                    <span>{g.warehouseShort ?? t('sodNoWarehouse')}</span>
                    <span className="so-wh-count">{g.items.length}</span>
                  </div>
                  <table className="so-line-table">
                    <thead>
                      <tr>
                        <th style={{ width: '44%' }}>{t('item')}</th>
                        <th className="num" style={{ width: 110 }}>{t('qty')}</th>
                        <th className="num" style={{ width: 130 }}>{t('fieldUnitPrice')}</th>
                        <th className="num" style={{ width: 110 }}>{t('sodLineTotal')}</th>
                        <th style={{ width: 36 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map(l => {
                        const idx = l._idx;
                        const lineTotal = l.qty * l.unitPrice;
                        // listPrice is a USD suggestion, so the "adjusted"
                        // warning only makes sense for USD orders.
                        const adjusted = currency === 'USD'
                          && l.unitPrice.toFixed(2) !== l.listPrice.toFixed(2);
                        return (
                          <tr key={l.inventoryId}>
                            <td>
                              <div style={{ fontWeight: 500, fontSize: 13 }}>{l.label}</div>
                              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                                <span className="mono">{l.partNumber ?? '—'}</span>
                                <span>·</span>
                                <span>{l.condition}</span>
                              </div>
                            </td>
                            <td className="num">
                              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                                <input
                                  className="so-mini-input"
                                  type="number"
                                  min={1}
                                  max={l.maxQty}
                                  value={l.qty}
                                  onChange={e => setLine(idx, {
                                    qty: Math.max(1, Math.min(l.maxQty, Number(e.target.value) || 0)),
                                  })}
                                  style={{ width: 64 }}
                                />
                                <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>
                                  / {l.maxQty}
                                </span>
                              </div>
                            </td>
                            <td className="num">
                              <input
                                className="so-mini-input"
                                type="number"
                                step="0.01"
                                value={l.unitPrice}
                                onChange={e => setLine(idx, { unitPrice: Number(e.target.value) || 0 })}
                                style={adjusted ? { borderColor: 'var(--warn)', background: 'var(--warn-soft)' } : undefined}
                                title={adjusted ? t('sodListPriceTooltip', { price: fmtUSD(l.listPrice, locale) }) : undefined}
                              />
                            </td>
                            <td className="num mono" style={{ fontWeight: 500 }}>
                              {fmtMoney(lineTotal, currency, locale)}
                            </td>
                            <td>
                              <button
                                className="btn icon sm"
                                title={t('remove')}
                                onClick={() => removeLine(idx)}
                              >
                                <Icon name="x" size={12} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}

              {lines.length === 0 && (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
                  {t('sodAllItemsRemoved')}
                </div>
              )}
            </div>

            {/* Notes */}
            <div className="so-section">
              <div className="so-section-head"><Icon name="edit" size={14} /> {t('ieInternalNotes')}</div>
              <textarea
                className="input"
                placeholder={t('sodInternalNotesPh')}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
              />
            </div>

            {error && (
              <div style={{
                padding: '10px 12px', background: 'var(--neg-soft)',
                color: 'var(--neg)', borderRadius: 10, fontSize: 12.5,
              }}>{error}</div>
            )}
          </div>

          {/* Right column — totals */}
          <aside className="so-aside">
            <div className="so-summary">
              <div className="so-summary-head">{t('sodOrderSummary')}</div>

              <div className="so-row muted"><span>{t('sodUnits')}</span><span className="mono">{totals.units}</span></div>

              <div className="so-row total">
                <span>{t('sodCustomerTotal')}</span>
                <span className="mono">{fmtMoney(totals.subtotalNative, currency, locale)}</span>
              </div>
              {currency !== 'USD' && (
                <div className="so-row muted" style={{ fontSize: 11.5 }}>
                  <span />
                  <span className="mono">{t('soUsdEquiv', { usd: fmtUSD(totals.subtotalUsd, locale) })}</span>
                </div>
              )}

              <div className="so-divider" />

              <div className="so-row muted"><span>{t('sodCostBasis')}</span><span className="mono">{fmtUSD(totals.cost, locale)}</span></div>
              <div className="so-row" style={{ color: 'var(--pos)' }}>
                <span>{t('profit')}</span>
                <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD(totals.profit, locale)}</span>
              </div>
              <div className="so-row muted"><span>{t('margin')}</span><span className="mono">{totals.margin == null ? '—' : totals.margin.toFixed(1) + '%'}</span></div>
              {currency !== 'USD' && fx && (
                <div className="so-row muted" style={{ fontSize: 11, marginTop: 4 }}>
                  <span />
                  <span className="mono">{t('soFxRateNote', { rate: fx.oneUsdInQuote.toFixed(4), currency, source: fx.source })}</span>
                </div>
              )}
            </div>

            <div className="so-tip">
              <Icon name="info" size={13} />
              <div>
                {t('sodDraftTipPre')}<strong>{t('lifecycleDraft')}</strong>{t('sodDraftTipPost')}
              </div>
            </div>
          </aside>
        </div>

        {/* Footer */}
        <div className="so-footer">
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            {t('lifecycleDraft')} · {fmtDate(new Date(), locale)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onClose}>{t('cancel')}</button>
              <button
                className="btn accent"
                disabled={!canSubmit || saving}
                title={saveDisabledReason ?? undefined}
                onClick={save}
              >
                <Icon name="check2" size={14} /> {saving ? t('vbSaving') : t('sodSaveDraft')}
              </button>
            </div>
            {saveDisabledReason && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', maxWidth: 320, textAlign: 'right' }}>
                {saveDisabledReason}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Currency picker ─────────────────────────────────────────────────────────
// Segmented USD/CNY control. Mirrors the vendor portal's bid-currency radio;
// shared by the new-order builder and the edit modal.
export function CurrencyPicker({
  value, onChange, t, disabled,
}: {
  value: Currency;
  onChange: (c: Currency) => void;
  t: (k: string) => string;
  disabled?: boolean;
}) {
  const opts: { id: Currency; labelKey: string }[] = [
    { id: 'USD', labelKey: 'currency.usd' },
    { id: 'CNY', labelKey: 'currency.cny' },
  ];
  return (
    <div className="seg" style={{ display: 'inline-flex', gap: 4 }}>
      {opts.map(o => (
        <button
          key={o.id}
          type="button"
          className={'btn sm' + (value === o.id ? ' accent' : '')}
          disabled={disabled}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
        >
          {t(o.labelKey)}
        </button>
      ))}
    </div>
  );
}

// ─── Customer picker ─────────────────────────────────────────────────────────
export function CustomerPicker({
  customers, value, onChange, onCreated,
}: {
  customers: Customer[];
  value: string;
  onChange: (id: string) => void;
  onCreated?: (c: Customer) => void;
}) {
  const { t } = useT();
  const selected = customers.find(c => c.id === value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const createCustomer = async () => {
    const name = newName.trim();
    if (!name || savingNew) return;
    setSavingNew(true);
    try {
      const r = await api.post<{ customer: Customer }>('/api/customers', { name });
      onCreated?.(r.customer);
      onChange(r.customer.id);
      setCreating(false);
      setNewName('');
      setOpen(false);
    } catch (e) {
      // Surface the error so the user knows why nothing happened; leave the
      // form open so they can retry.
      handleFetchError(e);
    } finally {
      setSavingNew(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(c =>
      c.name.toLowerCase().includes(q) || (c.short_name ?? '').toLowerCase().includes(q),
    );
  }, [customers, query]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="select"
        onClick={() => setOpen(o => !o)}
        style={{
          textAlign: 'left',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {selected ? (
            <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selected.name}
            </span>
          ) : (
            <span style={{ color: 'var(--fg-subtle)' }}>{t('sodSelectCustomer')}</span>
          )}
        </span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 12px 28px rgba(15,23,42,0.14)', zIndex: 20, overflow: 'hidden',
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)', position: 'relative' }}>
            <Icon name="search" size={13} style={{
              position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--fg-subtle)',
            }} />
            <input
              autoFocus
              className="input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('sodSearchCustomers')}
              style={{ paddingLeft: 30, height: 32, fontSize: 13 }}
            />
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onChange(c.id); setOpen(false); setQuery(''); }}
                style={{
                  width: '100%', textAlign: 'left', padding: '9px 12px',
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontFamily: 'inherit', display: 'flex', alignItems: 'center',
                  justifyContent: 'space-between', borderBottom: '1px solid var(--border)',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-soft)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                    {c.region ?? '—'}
                  </div>
                </div>
                {c.id === value && <Icon name="check" size={13} style={{ color: 'var(--accent)' }} />}
              </button>
            ))}
            {filtered.length === 0 && !creating && (
              <div style={{ padding: 16, fontSize: 12.5, color: 'var(--fg-subtle)', textAlign: 'center' }}>
                {t('sodNoMatches')}
              </div>
            )}
          </div>
          {creating ? (
            <div style={{ padding: 10, borderTop: '1px solid var(--border)', background: 'var(--bg-soft)', display: 'flex', gap: 6 }}>
              <input
                autoFocus
                className="input"
                value={newName}
                placeholder={t('sodNewCustomerName')}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createCustomer()}
                style={{ height: 32, fontSize: 13 }}
              />
              <button type="button" className="btn sm" onClick={() => { setCreating(false); setNewName(''); }}>{t('cancel')}</button>
              <button type="button" className="btn accent sm" disabled={!newName.trim() || savingNew} onClick={createCustomer}>
                {savingNew ? '…' : t('sodAdd')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              style={{
                width: '100%', textAlign: 'left', padding: '10px 12px',
                border: 'none', background: 'var(--bg-soft)', cursor: 'pointer',
                borderTop: '1px solid var(--border)', fontFamily: 'inherit',
                color: 'var(--accent-strong)', display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12.5, fontWeight: 500,
              }}
            >
              <Icon name="plus" size={13} /> {t('sodAddNewCustomer')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
