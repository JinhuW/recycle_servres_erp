import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { api, createDraftOrder } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { fmtUSD } from '../../lib/format';
import { useEscapeKey } from '../../lib/useEscapeKey';
import type { Category, ScanResponse, Warehouse } from '../../lib/types';
import { LineDrawer } from './submit/LineDrawer';

// ─── Public component ────────────────────────────────────────────────────────
// Two-step submit flow lifted from design/submit.jsx + design/app.jsx#SubmitView:
//   1. Category picker (RAM / SSD / Other) — chunky cards, AI-capture tag on RAM
//   2. OrderForm — line-item table + right-side drawer for editing one line,
//      plus a sticky bottom card with order meta + totals + submit action.
//
// RAM lines get an AI label drop zone at the top of the right-side drawer
// (LineDrawer): drop or click a photo, the scan patches the current line.

type Props = {
  onDone: (toast?: { msg: string; kind?: 'success' | 'error' }) => void;
};

export function DesktopSubmit({ onDone }: Props) {
  const { t } = useT();
  const [cat, setCat] = useState<Category | null>(null);

  if (!cat) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">{t('submitNewOrder')}</h1>
            <div className="page-sub">{t('submitNewOrderSub')}</div>
          </div>
        </div>

        <div style={{ maxWidth: 720, margin: '24px auto 0' }}>
          <div style={{
            fontSize: 11, color: 'var(--fg-subtle)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12,
          }}>
            {t('chooseItemType')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            {([
              { id: 'RAM',   icon: 'chip',  sub: t('ramSub'),   tag: t('aiLabelCapture') },
              { id: 'SSD',   icon: 'drive', sub: t('ssdSub'),   tag: t('manualEntry') },
              { id: 'HDD',   icon: 'drive', sub: t('hddSub'),   tag: t('manualEntry') },
              { id: 'Other', icon: 'box',   sub: t('otherSub'), tag: t('manualEntry') },
            ] as const).map(c => (
              <button
                key={c.id}
                onClick={() => setCat(c.id as Category)}
                className="card"
                style={{
                  padding: 22, display: 'flex', flexDirection: 'column',
                  alignItems: 'flex-start', gap: 14,
                  background: 'var(--bg-elev)', cursor: 'pointer',
                  textAlign: 'left', fontFamily: 'inherit',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  transition: 'transform 0.12s, border-color 0.12s, box-shadow 0.12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(15,23,42,0.06)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
              >
                <div style={{
                  width: 44, height: 44, borderRadius: 10,
                  background: 'var(--accent-soft)', color: 'var(--accent-strong)',
                  display: 'grid', placeItems: 'center',
                }}>
                  <Icon name={c.icon} size={22} />
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 4 }}>{c.id}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{c.sub}</div>
                </div>
                <span className={'chip ' + (c.id === 'RAM' ? 'pos' : '')} style={{ fontSize: 10 }}>
                  {c.id === 'RAM' && <Icon name="sparkles" size={9} />} {c.tag}
                </span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 18, fontSize: 12, color: 'var(--fg-subtle)', textAlign: 'center' }}>
            {t('multipleLineItems')}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('submitNewCatOrder', { cat })}</h1>
          <div className="page-sub">
            {t('submitNewCatOrderSub', { cat })}{' '}
            <button
              onClick={() => setCat(null)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--accent-strong)', padding: 0,
                fontSize: 'inherit', textDecoration: 'underline',
                fontFamily: 'inherit',
              }}
            >
              {t('changeItemType')}
            </button>
          </div>
        </div>
      </div>

      <OrderForm
        key={cat}
        category={cat}
        onCancel={() => setCat(null)}
        onDone={onDone}
      />
    </>
  );
}

// ─── OrderForm ───────────────────────────────────────────────────────────────
// Exported so DesktopEditOrder can reuse the same line-drawer pattern (table
// row → right-side drawer with full per-category fields) without duplicating
// the components.
export type Line = {
  category: Category;
  brand?: string;
  capacity?: string;
  generation?: string;
  type?: string;
  classification?: string;
  rank?: string;
  speed?: string;
  interface?: string;
  formFactor?: string;
  description?: string;
  partNumber?: string;
  condition: string;
  qty: number | string;
  unitCost: number | string;
  sellPrice?: number | string;
  health?: number | null;
  rpm?: number | null;
  totalCost?: string;            // user-typed override (string-typed to allow blank)
  scanImageId?: string | null;
  scanConfidence?: number | null;
  scanImageUrl?: string | null;
  _confirmed?: boolean;
  _cid: string;                  // stable client id for React keys (never sent to the API)
};

type OrderMeta = {
  warehouseId: string;
  payment: 'Company' | 'Self';
  notes: string;
  totalCostOverride: string | null;
};


export function blankLine(cat: Category): Line {
  return {
    _cid: crypto.randomUUID(),
    category: cat, qty: '', unitCost: '',
    condition: '',
    scanImageUrl: null,
  };
}

export type DuplicatePartGroup = { partNumber: string; lineNums: number[] };

// Two lines sharing a part number on the same PO is almost always a paste-error
// or a forgotten-already-added — surface it so the user can merge or confirm.
// Comparison is case-insensitive and trims whitespace; blanks are ignored. The
// returned `partNumber` carries the first-seen casing for display.
export function findDuplicatePartNumbers(
  lines: ReadonlyArray<{ partNumber?: string | null }>,
): DuplicatePartGroup[] {
  const groups = new Map<string, DuplicatePartGroup>();
  lines.forEach((l, i) => {
    const raw = (l.partNumber ?? '').trim();
    if (!raw) return;
    const key = raw.toLowerCase();
    const g = groups.get(key);
    if (g) g.lineNums.push(i + 1);
    else groups.set(key, { partNumber: raw, lineNums: [i + 1] });
  });
  return [...groups.values()].filter(g => g.lineNums.length >= 2);
}

// Build a Line patch from an AI scan response — mirrors the mobile aiDefaults
// in SubmitForm.tsx so all flows share the same field-mapping. Returned as a
// Partial so callers can either spread it onto blankLine() (new line) or pass
// it through onChange() (live edit in the drawer).
// Low-confidence extractions are still prefilled (a rough draft beats an empty
// form); scanConfidence rides along so the drawer can flag it for review.
export function scanToLinePatch(scan: ScanResponse): Partial<Line> {
  const f = scan.extracted ?? {};
  return {
    scanImageId: scan.imageId ?? null,
    scanConfidence: scan.confidence ?? null,
    scanImageUrl: scan.deliveryUrl ?? null,
    ...(f.brand        ? { brand: f.brand }               : {}),
    ...(f.capacity     ? { capacity: f.capacity }         : {}),
    ...(f.generation   ? { generation: f.generation }     : {}),
    ...(f.type         ? { type: f.type }                 : {}),
    ...(f.classification ? { classification: f.classification } : {}),
    ...(f.rank         ? { rank: f.rank }                 : {}),
    ...(f.speed        ? { speed: f.speed }               : {}),
    ...(f.interface    ? { interface: f.interface }       : {}),
    ...(f.formFactor   ? { formFactor: f.formFactor }     : {}),
    ...(f.description  ? { description: f.description }   : {}),
    ...(f.partNumber   ? { partNumber: f.partNumber }     : {}),
  };
}

function OrderForm({
  category,
  onCancel,
  onDone,
}: {
  category: Category;
  onCancel: () => void;
  onDone: (toast?: { msg: string; kind?: 'success' | 'error' }) => void;
}) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => setWarehouses(r.items))
      .catch(handleFetchError);
  }, []);

  const [lines, setLines] = useState<Line[]>([blankLine(category)]);
  const [activeIdx, setActiveIdx] = useState<number | null>(0);
  const [meta, setMeta] = useState<OrderMeta>({
    warehouseId: '',
    payment: 'Company',
    notes: '',
    totalCostOverride: null,
  });

  // Order-level error banner — populated by submit/confirm failures and the
  // draft-creation guard below. AI scan failures live inside the LineDrawer,
  // alongside the dropzone that produces them.
  const [aiError, setAiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Create a server-side draft order as soon as the form mounts so that
  // per-line confirms have an order to attach to.
  const [draftId, setDraftId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    createDraftOrder(category)
      .then(r => { if (alive) setDraftId(r.id); })
      .catch(() => {
        if (alive) setAiError('Could not start a draft order — retry.');
      });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  // Default the warehouse to the first one once they load.
  useEffect(() => {
    if (warehouses.length && !meta.warehouseId) {
      setMeta(m => ({ ...m, warehouseId: warehouses[0].id }));
    }
  }, [warehouses, meta.warehouseId]);

  const totals = useMemo(() => {
    let units = 0, cost = 0;
    lines.forEach(l => {
      const qty = Number(l.qty) || 0;
      const c = Number(l.unitCost) || 0;
      units += qty;
      cost += qty * c;
    });
    return { units, cost };
  }, [lines]);

  const dupGroups = useMemo(() => findDuplicatePartNumbers(lines), [lines]);
  const dupByIdx = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const g of dupGroups) {
      for (const ln of g.lineNums) {
        m.set(ln - 1, g.lineNums.filter(n => n !== ln));
      }
    }
    return m;
  }, [dupGroups]);
  const [dupConfirm, setDupConfirm] = useState<DuplicatePartGroup[] | null>(null);

  const updateLine = (i: number, patch: Partial<Line>) =>
    setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const addLine = () => {
    setLines(ls => [...ls, blankLine(category)]);
    setActiveIdx(lines.length);
  };

  const removeLine = (i: number) => {
    setLines(ls => (ls.length <= 1 ? ls : ls.filter((_, j) => j !== i)));
    setActiveIdx(idx => {
      if (lines.length <= 1) return null;
      if (i === idx) return null;
      if (idx != null && i < idx) return idx - 1;
      return idx;
    });
  };

  const lineReady = (l: Line) => {
    const qty = Number(l.qty) || 0;
    const cost = Number(l.unitCost) || 0;
    const hasIdentity = l.category === 'Other' ? !!l.description : !!l.brand;
    return qty > 0 && cost >= 0 && hasIdentity;
  };

  const canSubmit = lines.every(lineReady);

  // Maps a local Line to the wire shape expected by PATCH /api/orders/:id addLines.
  const toWireLine = (l: Line) => ({
    category: l.category,
    brand: l.brand ?? null,
    capacity: l.capacity ?? null,
    type: l.type ?? null,
    generation: l.generation ?? null,
    classification: l.classification ?? null,
    rank: l.rank ?? null,
    speed: l.speed ?? null,
    interface: l.interface ?? null,
    formFactor: l.formFactor ?? null,
    description: l.description ?? null,
    partNumber: l.partNumber ?? null,
    condition: l.condition,
    qty: Number(l.qty) || 1,
    unitCost: Number(l.unitCost) || 0,
    health: l.health ?? null,
    rpm: l.rpm ?? null,
    status: 'In Transit' as const,
    scanImageId: l.scanImageId ?? null,
    scanConfidence: l.scanConfidence ?? null,
  });

  // Confirms a single line AND auto-saves the current order metadata in the
  // same PATCH. The user doesn't need to click "Submit Order" to keep their
  // work safe — closing the tab after confirming a line leaves nothing
  // unsaved. (Submit Order remains as the navigate-away trigger.)
  const handleConfirmLine = async (idx: number): Promise<void> => {
    if (!draftId) {
      setAiError('Could not start a draft order — retry.');
      return;
    }
    const l = lines[idx];
    if (l._confirmed) return;
    if (!lineReady(l)) {
      setAiError('Fill in brand/description, quantity and unit cost before confirming this line.');
      return;
    }
    const totalCost = meta.totalCostOverride != null
      ? (Number(meta.totalCostOverride) || 0)
      : totals.cost;
    await api.patch('/api/orders/' + draftId, {
      addLines: [toWireLine(l)],
      ...(meta.warehouseId ? { warehouseId: meta.warehouseId } : {}),
      payment: meta.payment === 'Company' ? 'company' : 'self',
      notes: meta.notes || null,
      totalCost,
    });
    updateLine(idx, { _confirmed: true });
  };

  // Escape closes the drawer.
  useEscapeKey(useCallback(() => setActiveIdx(null), []), activeIdx !== null);

  const doSubmit = async () => {
    if (!draftId) { setAiError(t('subNoDraftErr')); return; }
    const totalCost = meta.totalCostOverride != null
      ? (Number(meta.totalCostOverride) || 0)
      : totals.cost;
    const unconfirmedLines = lines.filter(l => !l._confirmed);
    setSubmitting(true);
    try {
      await api.patch('/api/orders/' + draftId, {
        warehouseId: meta.warehouseId,
        payment: meta.payment === 'Company' ? 'company' : 'self',
        notes: meta.notes || null,
        totalCost,
        ...(unconfirmedLines.length > 0 ? { addLines: unconfirmedLines.map(toWireLine) } : {}),
      });
      onDone({ msg: t('orderSubmitted'), kind: 'success' });
    } catch (e) {
      setAiError(e instanceof Error ? e.message : t('subSubmitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Reason the Submit button is disabled, surfaced inline so the user isn't
  // staring at a dead button wondering what's wrong. Checked in priority
  // order: still submitting → draft creation → warehouse pick → per-line completeness.
  const submitDisabledReason: string | null =
    submitting              ? null
  : !draftId                ? t('subStartingDraft')
  : warehouses.length === 0 ? t('subWarehousesNotLoaded')
  : !meta.warehouseId       ? t('reviewPickWarehouseHint')
  : !canSubmit              ? (() => {
      const bad = lines.findIndex(l => !lineReady(l));
      if (bad < 0) return null;
      return lines.length === 1
        ? t('subFillThisLine')
        : t('subFillLineN', { n: bad + 1 });
    })()
  : null;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('orderDetails')}</div>
            <div className="card-sub">{t('subOrderContainsMultiple', { cat: category })}</div>
          </div>
          <span className="chip mono">
            {(draftId ?? t('subDrafting'))} · {t('lifecycleDraft')}
          </span>
        </div>

        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '14px 18px 6px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {t('subItemsInOrder')} <span style={{ fontWeight: 500, color: 'var(--fg-subtle)', marginLeft: 4 }}>({lines.length})</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 2 }}>
              {t('subItemsClickRow', { cat: category })}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="chip mono">{t('subUnitsCost', { n: totals.units, cost: fmtUSD(totals.cost, locale) })}</span>
            <button className="btn" onClick={addLine}>
              <Icon name="plus" size={13} /> {t('subAddLine', { cat: category })}
            </button>
          </div>
        </div>
        {aiError && (
          <div style={{
            margin: '12px 18px 12px', padding: '10px 12px',
            background: 'rgba(220,40,40,0.08)', border: '1px solid rgba(220,40,40,0.25)',
            borderRadius: 8, fontSize: 12, color: 'var(--neg, #b22)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          }}>
            <span>{aiError}</span>
            <button
              className="btn icon sm"
              onClick={() => setAiError(null)}
              title={t('dismiss')}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )}

        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>{t('item')}</th>
              <th>{t('partNumber')}</th>
              <th className="num">{t('qty')}</th>
              <th className="num">{t('unitCost')}</th>
              <th className="num">{t('totalCost')}</th>
              <th>{t('status')}</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const lQty = Number(l.qty) || 0;
              const lCost = Number(l.unitCost) || 0;
              const filled = !!l.brand || !!l.description;
              const isActive = i === activeIdx;
              return (
                <tr
                  key={l._cid}
                  className="row-hover"
                  style={{ cursor: 'pointer', background: isActive ? 'var(--accent-soft)' : undefined }}
                  onClick={() => setActiveIdx(i)}
                >
                  <td className="mono" style={{ color: isActive ? 'var(--accent-strong)' : 'var(--fg-subtle)', fontWeight: isActive ? 600 : 400 }}>{i + 1}</td>
                  <td>
                    {filled ? (
                      <div>
                        <div style={{ fontWeight: 500 }}>
                          {l.category === 'RAM' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.generation ?? ''}`.trim()}
                          {l.category === 'SSD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.interface ?? ''}`.trim()}
                          {l.category === 'HDD' && `${l.brand ?? ''} ${l.capacity ?? ''} ${l.rpm ? l.rpm + 'rpm' : ''}`.trim()}
                          {l.category === 'Other' && (l.description ?? '—')}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                          {l.category === 'RAM' && [l.classification, l.rank, l.speed && (l.speed + 'MHz')].filter(Boolean).join(' · ')}
                          {l.category === 'SSD' && [l.formFactor, l.condition, l.health != null && (l.health + '%')].filter(Boolean).join(' · ')}
                          {l.category === 'HDD' && [l.interface, l.formFactor, l.condition, l.health != null && (l.health + '%')].filter(Boolean).join(' · ')}
                          {l.category === 'Other' && l.condition}
                        </div>
                      </div>
                    ) : <span className="muted" style={{ fontStyle: 'italic' }}>{isActive ? t('subEditingFill') : t('subNotFilled')}</span>}
                  </td>
                  <td className="mono muted" style={{ fontSize: 11 }}>{l.partNumber || '—'}</td>
                  <td className="num mono">{lQty}</td>
                  <td className="num mono">{lCost ? fmtUSD(lCost, locale) : '—'}</td>
                  <td className="num mono">{lQty && lCost ? fmtUSD(lQty * lCost, locale) : '—'}</td>
                  <td>
                    {isActive && <span className="chip info"><Icon name="edit" size={10} /> {t('subStatusEditing')}</span>}
                    {!isActive && filled && <span className="chip pos">{t('subStatusReady')}</span>}
                    {!isActive && !filled && <span className="chip warn">{t('subStatusNeedsInfo')}</span>}
                  </td>
                  <td>
                    <button
                      className="btn icon sm"
                      onClick={e => { e.stopPropagation(); removeLine(i); }}
                      title={t('soRemoveLineTooltip')}
                      disabled={lines.length <= 1}
                      style={lines.length <= 1 ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Sticky bottom: meta + totals + submit */}
      <div className="card" style={{ position: 'sticky', bottom: 16, zIndex: 5, boxShadow: '0 12px 24px rgba(15,23,42,0.06)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('warehouse')} <span className="req">*</span></label>
              <select
                className="select"
                value={meta.warehouseId}
                onChange={e => setMeta(m => ({ ...m, warehouseId: e.target.value }))}
              >
                {warehouses.length === 0 && <option value="">{t('loadingApp')}</option>}
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name ?? w.short}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('payment')} <span className="req">*</span></label>
              <div className="seg" style={{ width: '100%' }}>
                <button
                  className={meta.payment === 'Company' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => setMeta(m => ({ ...m, payment: 'Company' }))}
                >{t('payCompanyShort')}</button>
                <button
                  className={meta.payment === 'Self' ? 'active' : ''}
                  style={{ flex: 1, whiteSpace: 'nowrap' }}
                  onClick={() => setMeta(m => ({ ...m, payment: 'Self' }))}
                >{t('paySelfShort')}</button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span>{t('totalCost')}</span>
                {meta.totalCostOverride !== null && (
                  <button
                    onClick={() => setMeta(m => ({ ...m, totalCostOverride: null }))}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-strong)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
                    title={t('subAutoSumIs', { cost: fmtUSD(totals.cost, locale) })}
                  >{t('reset')}</button>
                )}
              </label>
              <div style={{ position: 'relative' }}>
                <span className="mono" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-subtle)', pointerEvents: 'none' }}>$</span>
                <input
                  className="input mono"
                  type="number"
                  step="0.01"
                  value={meta.totalCostOverride !== null ? meta.totalCostOverride : totals.cost.toFixed(2)}
                  onChange={e => setMeta(m => ({ ...m, totalCostOverride: e.target.value }))}
                  onFocus={e => e.target.select()}
                  style={{ paddingLeft: 24, fontWeight: 500 }}
                />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label">{t('orderNotes')}</label>
              <input
                className="input"
                value={meta.notes}
                onChange={e => setMeta(m => ({ ...m, notes: e.target.value }))}
                placeholder={t('subOptional')}
              />
            </div>
          </div>
        </div>

        <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr) auto', gap: 18, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('lines')}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{lines.length}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('subTotalUnits')}</div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>{totals.units}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
              {t('totalCost')}
              {meta.totalCostOverride !== null && Math.abs((Number(meta.totalCostOverride) || 0) - totals.cost) > 0.01 && (
                <span style={{ color: 'var(--accent-strong)', fontWeight: 500 }}> · {t('subOverride')}</span>
              )}
            </div>
            <div className="mono" style={{ fontWeight: 600, fontSize: 17 }}>
              {fmtUSD(meta.totalCostOverride !== null ? (Number(meta.totalCostOverride) || 0) : totals.cost, locale)}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={onCancel}>{t('cancel')}</button>
              <button
                className="btn accent"
                disabled={!canSubmit || !meta.warehouseId || !draftId || submitting}
                title={submitDisabledReason ?? undefined}
                onClick={() => {
                  if (dupGroups.length > 0) {
                    setDupConfirm(dupGroups);
                    return;
                  }
                  void doSubmit();
                }}
              >
                {t('submitOrder')} <Icon name="check" size={14} />
              </button>
            </div>
            {submitDisabledReason && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', maxWidth: 320, textAlign: 'right' }}>
                {submitDisabledReason}
              </div>
            )}
          </div>
        </div>
      </div>

      {activeIdx !== null && lines[activeIdx] && (
        <LineDrawer
          line={lines[activeIdx]}
          idx={activeIdx}
          onChange={patch => updateLine(activeIdx, patch)}
          onClose={() => setActiveIdx(null)}
          onRemove={() => removeLine(activeIdx)}
          canRemove={lines.length > 1}
          onConfirmLine={() => handleConfirmLine(activeIdx)}
          onConfirmError={setAiError}
          duplicateOnLines={dupByIdx.get(activeIdx)}
        />
      )}

      {dupConfirm && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !submitting) setDupConfirm(null); }}>
          <div className="modal-shell" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--warn-soft, #fef3c7)', color: 'var(--warn-strong, #92400e)',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                }}>
                  <Icon name="alert" size={18} />
                </div>
                <div>
                  <div className="modal-title">{t('dupPartModalTitle')}</div>
                  <div className="modal-sub">{t('dupPartModalSub')}</div>
                </div>
              </div>
            </div>
            <div className="modal-body">
              <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 6, fontSize: 13 }}>
                {dupConfirm.map(g => (
                  <li key={g.partNumber.toLowerCase()}>
                    {(g.lineNums.length === 1 ? t('dupPartModalRowOne') : t('dupPartModalRowMany'))
                      .replace('{pn}', g.partNumber)
                      .replace('{nums}', g.lineNums.join(', '))}
                  </li>
                ))}
              </ul>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDupConfirm(null)} disabled={submitting}>
                {t('dupPartReview')}
              </button>
              <button
                className="btn accent"
                disabled={submitting}
                onClick={async () => { setDupConfirm(null); await doSubmit(); }}
              >
                {submitting ? '…' : t('dupPartSubmitAnyway')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// LineDrawer + the per-category field groups (RamFields/SsdFields/HddFields/
// OtherFields/CatSelect) were extracted verbatim into ./submit/* — re-exported
// here so external importers (DesktopEditOrder) keep their existing import path.
export { LineDrawer };
