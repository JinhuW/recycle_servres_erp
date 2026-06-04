import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../lib/i18n';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';

// ── Types — mirror GET /api/inventory/analysis ──────────────────────────────
type Dim = { key: string; data: [string, number][] };
type Subtype = {
  units: number; cost: number; sell: number; lines: number;
  dims: Dim[]; condition: [string, number][]; sparse: boolean;
};
type Warehouse = {
  id: string; short: string; region: string; units: number; value: number;
};
type Analysis = {
  scope: { category: string | null; warehouse: string | null };
  totals: { lines: number; units: number };
  value: { cost: number; sell: number };
  byCategory: { category: string; lines: number; units: number; cost: number; sell: number }[];
  byStatus: { status: string; units: number }[];
  byWarehouse: Warehouse[];
  categories: string[];
  warehouses: { id: string; short: string; region: string }[];
  brands: [string, number][];
  subtypes: Record<string, Subtype>;
};

// Category colours — kept in lockstep with the dashboard's CAT_COLOR.
const CAT_COLOR: Record<string, string> = {
  RAM: 'var(--info)', SSD: 'var(--accent)', HDD: 'oklch(0.55 0.18 295)', Other: 'var(--warn)',
};
const catColor = (c: string) => CAT_COLOR[c] ?? 'var(--fg-muted)';
const STATUS_COLOR: Record<string, string> = {
  Done: 'var(--accent-strong)', Reviewing: 'var(--info)',
  'In Transit': 'var(--warn)', Draft: 'var(--fg-subtle)',
};
const statusColor = (s: string) => STATUS_COLOR[s] ?? 'var(--fg-muted)';
// Rank/speed read better as vertical columns; everything else as horizontal bars.
const VBAR_DIMS = new Set(['rank', 'speed']);

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const moneyK = (n: number) => '$' + (n / 1000).toFixed(1) + 'K';
const pct = (n: number, tot: number) => (tot ? Math.round((n / tot) * 100) : 0);

// ── Primitives ──────────────────────────────────────────────────────────────
type Row = { label: string; value: number; color: string; swatch?: boolean };

function Bars({ rows, lw = 70, fmt }: { rows: Row[]; lw?: number; fmt?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  const tot = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <div className="an-bt">
      {rows.map((r, i) => (
        <div className="an-brow" key={r.label + i} style={{ gridTemplateColumns: `${lw}px 1fr` }}>
          <div className="an-bname">
            {r.swatch && <span className="an-sw" style={{ background: r.color }} />}{r.label}
          </div>
          <div className="an-twrap">
            <div className="an-track"><div className="an-fill" style={{ width: (r.value / max) * 100 + '%', background: r.color }} /></div>
            <div className="an-figs"><span>{fmt ? fmt(r.value) : r.value}</span><span className="an-pct">{pct(r.value, tot)}%</span></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function VBars({ data, color }: { data: [string, number][]; color: string }) {
  const max = Math.max(1, ...data.map(d => d[1]));
  return (
    <div className="an-vbars">
      {data.map(([l, n], i) => (
        <div className="an-vb" key={l + i}>
          <div className="an-cw"><div className="an-col" style={{ height: (n / max) * 100 + '%', background: color }}><span className="an-nn">{n}</span></div></div>
          <span className="an-lb">{l}</span>
        </div>
      ))}
    </div>
  );
}

function Panel({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="an-card">
      <div className="an-ph"><h2>{title}</h2>{meta && <span className="an-meta">{meta}</span>}</div>
      <div className="an-pb">{children}</div>
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────--
export function DesktopAnalysis() {
  const { t } = useT();
  const [data, setData] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cat, setCat] = useState('All');     // category name, or 'All'
  const [wh, setWh] = useState('All');       // warehouse id, or 'All'

  // The page re-queries on every filter change so all sections — KPIs,
  // composition, status, brands and the per-type sub-analysis — reflect the
  // selected slice. Previous data is kept on screen during the refetch so the
  // controls don't flicker or lose their options.
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    if (cat !== 'All') params.set('category', cat);
    if (wh !== 'All') params.set('warehouse', wh);
    const qs = params.toString();
    setBusy(true);
    api.get<Analysis>('/api/inventory/analysis' + (qs ? '?' + qs : ''))
      .then(d => { if (alive) { setData(d); setLoading(false); setBusy(false); } })
      .catch(err => { if (alive) { setLoading(false); setBusy(false); handleFetchError(err); } });
    return () => { alive = false; };
  }, [cat, wh]);

  const dimTitle = (key: string) => t('dim_' + key);

  if (loading) return <div className="an-shell"><div className="an-loading">…</div></div>;
  if (!data) return <div className="an-shell"><div className="an-empty">{t('analysisEmpty')}</div></div>;

  const whShort = wh === 'All' ? null : (data.warehouses.find(w => w.id === wh)?.short ?? null);
  const scopeParts = [cat !== 'All' ? cat : null, whShort].filter(Boolean);

  // Which type(s) get a sub-analysis card: the focused one, or all of them.
  const subCats = data.categories.filter(c => data.subtypes[c]);

  return (
    <div className="an-shell" style={busy ? { opacity: 0.6, transition: 'opacity .12s' } : undefined}>
      <div className="an-title">
        <div><h1>{t('analysisTitle')}</h1><p className="an-desc">{t('analysisSubtitle')}</p></div>
        <div className="an-scope">
          {scopeParts.length > 0 && <span className="an-badge">{t('analysisScoped', { s: scopeParts.join(' · ') })}</span>}
          <label className="an-field"><span>{t('analysisScopeCategory')}</span>
            <select className="select sm" value={cat} onChange={e => setCat(e.target.value)}>
              <option value="All">{t('analysisAll')}</option>
              {data.categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="an-field"><span>{t('analysisScopeWarehouse')}</span>
            <select className="select sm" value={wh} onChange={e => setWh(e.target.value)}>
              <option value="All">{t('analysisAll')}</option>
              {data.warehouses.map(w => <option key={w.id} value={w.id}>{w.short}</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* KPI strip — every figure is scoped to the current selection. */}
      <div className="an-kpis">
        <Kpi label={t('analysisUnits')} value={String(data.totals.units)} sub={cat !== 'All' ? cat : t('analysisOnHand')} />
        <Kpi label={t('analysisCostValue')} value={moneyK(data.value.cost)} sub={t('analysisAtCost')} />
        <Kpi label={t('analysisExpectedSell')} value={moneyK(data.value.sell)} sub={t('analysisAtListings')} />
        <Kpi label={t('analysisMargin')} value={'+' + pct(data.value.sell - data.value.cost, data.value.cost) + '%'}
             sub={<span className="an-pos">▲ {money(data.value.sell - data.value.cost)}</span>} />
        <Kpi label={t('analysisLineItems')} value={String(data.totals.lines)} sub={t('analysisActiveSkus')} />
      </div>

      {/* Composition + status */}
      <div className="an-grid an-g2">
        <Panel title={t('analysisCategoryComposition')} meta={cat !== 'All' ? cat : t('analysisByUnits')}>
          {cat !== 'All' && data.subtypes[cat]
            ? <FocusedComposition sub={data.subtypes[cat]!} color={catColor(cat)} dimTitle={dimTitle} />
            : <Bars rows={data.byCategory.map(c => ({ label: c.category, value: c.units, color: catColor(c.category), swatch: true }))} lw={62} />}
        </Panel>
        <Panel title={t('analysisStatusPipeline')} meta={t('analysisInFlow', { n: data.totals.units })}>
          <StatusPipeline data={data.byStatus} />
        </Panel>
      </div>

      {/* Warehouse + brands */}
      <div className="an-grid an-gWh">
        <Panel title={t('analysisByWarehouse')} meta={t('analysisLocations', { n: data.warehouses.length })}>
          <WarehouseTable rows={data.byWarehouse} t={t} selectedWh={wh === 'All' ? null : wh} />
        </Panel>
        <Panel title={t('analysisTopBrands')} meta={t('analysisByUnits')}>
          <Bars rows={data.brands.map(([l, n]) => ({ label: l, value: n, color: 'var(--accent)' }))} lw={80} />
        </Panel>
      </div>

      {/* Per-type sub-analysis */}
      {subCats.map(c => (
        <SubAnalysis key={c} cat={c} sub={data.subtypes[c]!} dimTitle={dimTitle} t={t} />
      ))}

      <div className="an-crumb an-foot">ⓘ {t('analysisSeedNote')}</div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className="an-card an-kpi">
      <div className="an-l">{label}</div>
      <div className="an-v">{value}</div>
      <div className="an-s">{sub}</div>
    </div>
  );
}

// Category=focused → show that type's first horizontal dimension as composition.
function FocusedComposition({ sub, color, dimTitle }: { sub: Subtype; color: string; dimTitle: (k: string) => string }) {
  const dim = sub.dims.find(d => !VBAR_DIMS.has(d.key));
  if (!dim) return <Bars rows={sub.condition.map(([l, n]) => ({ label: l, value: n, color }))} lw={130} />;
  return (
    <>
      <div className="an-note-sm">{dimTitle(dim.key)}</div>
      <Bars rows={dim.data.map(([l, n]) => ({ label: l, value: n, color }))} lw={110} />
    </>
  );
}

function StatusPipeline({ data }: { data: { status: string; units: number }[] }) {
  const tot = data.reduce((s, r) => s + r.units, 0) || 1;
  return (
    <>
      <div className="an-pipe">
        {data.map(s => (
          <div className="an-pseg" key={s.status} style={{ width: (s.units / tot) * 100 + '%', background: statusColor(s.status) }}>{s.units}</div>
        ))}
      </div>
      <div className="an-pleg">
        {data.map(s => (
          <div className="an-pi" key={s.status}>
            <span className="an-sw" style={{ background: statusColor(s.status) }} />
            <span className="an-nm">{s.status}</span>
            <span className="an-ct">{s.units}</span>
            <span className="an-pc">{pct(s.units, tot)}%</span>
          </div>
        ))}
      </div>
    </>
  );
}

function WarehouseTable({ rows, t, selectedWh }: {
  rows: Warehouse[];
  t: (k: string, v?: Record<string, string | number>) => string; selectedWh: string | null;
}) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <table className="an-wt">
      <thead><tr>
        <th>{t('analysisColWarehouse')}</th><th className="n">{t('analysisColUnits')}</th>
        <th className="n">{t('analysisColValue')}</th><th>{t('analysisColShare')}</th>
      </tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id} className={selectedWh === r.id ? 'an-wt-sel' : undefined}>
            <td><div className="an-whn">{r.short}</div><div className="an-whr">{r.region}</div></td>
            <td className="n">{r.units}</td>
            <td className="n">{money(r.value)}</td>
            <td><div className="an-sbar"><i style={{ width: (r.value / max) * 100 + '%' }} /></div></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SubAnalysis({ cat, sub, dimTitle, t }: {
  cat: string; sub: Subtype; dimTitle: (k: string) => string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const color = catColor(cat);
  const margin = sub.cost ? pct(sub.sell - sub.cost, sub.cost) : 0;
  return (
    <section className="an-card an-sub">
      <div className="an-typehead" style={{ background: color }}>
        <div className="an-tic">{cat}</div>
        <div className="an-tt">
          <div className="an-tname">{cat} — {t('analysisSubAnalysis')}</div>
          <div className="an-tsub">{sub.units}u · {money(sub.cost)} → {money(sub.sell)}{sub.cost ? ` · +${margin}%` : ''}</div>
        </div>
      </div>
      <div className="an-pb">
        {sub.dims.length > 0 && (
          <div className="an-dimgrid">
            {sub.dims.map(d => (
              <div key={d.key} className="an-dim">
                <p className="an-rsub">{dimTitle(d.key)}</p>
                {VBAR_DIMS.has(d.key)
                  ? <VBars data={d.data} color={color} />
                  : <Bars rows={d.data.map(([l, n]) => ({ label: l, value: n, color }))} lw={100} />}
              </div>
            ))}
          </div>
        )}
        {sub.sparse && <div className="an-note">{t('analysisSparseNote')}</div>}
        <div className="an-dim" style={{ marginTop: 14 }}>
          <p className="an-rsub">{t('analysisConditionMix')}</p>
          <Bars rows={sub.condition.map(([l, n]) => ({ label: l, value: n, color }))} lw={140} />
        </div>
      </div>
    </section>
  );
}
