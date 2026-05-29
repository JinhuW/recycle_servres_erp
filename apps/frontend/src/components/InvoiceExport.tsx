import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import type { Order, OrderSummary, OrderLine } from '../lib/types';

// Map a PO's lifecycle slug onto a stamp colour + label. The stamp is the
// only piece of the invoice that flexes — everything else is identical
// across states so the document reads as a fixed legal record.
type StampSpec = { label: string; tone: 'muted' | 'info' | 'warn' | 'pos' | 'neg' };
function lifecycleStamp(o: OrderSummary, t: (k: string) => string): StampSpec {
  if (o.archivedAt) return { label: t('invStampArchived'), tone: 'muted' };
  switch (o.lifecycle) {
    case 'draft':      return { label: t('invStampDraft'),    tone: 'warn' };
    case 'in_transit': return { label: t('invStampTransit'),  tone: 'info' };
    case 'reviewing':  return { label: t('invStampReview'),   tone: 'warn' };
    case 'done':       return { label: t('invStampReceived'), tone: 'pos' };
    default:           return { label: o.status.toUpperCase(), tone: 'muted' };
  }
}

// Compose a human line label out of the category-specific spec fields. Mirrors
// the inline composition in DesktopOrders' expanded row — kept local so the
// invoice document is self-contained.
function lineName(l: OrderLine): string {
  if (l.category === 'RAM') return [l.brand, l.capacity, l.generation].filter(Boolean).join(' ').trim();
  if (l.category === 'SSD') return [l.brand, l.capacity, l.interface].filter(Boolean).join(' ').trim();
  if (l.category === 'HDD') return [l.brand, l.capacity, l.rpm ? l.rpm + 'rpm' : null].filter(Boolean).join(' ').trim();
  return l.description ?? '';
}
function lineSpec(l: OrderLine): string {
  if (l.category === 'RAM') return [l.classification, l.rank, l.speed && l.speed + 'MHz'].filter(Boolean).join(' · ');
  if (l.category === 'SSD') return [l.formFactor, l.health != null && l.health + '%', l.condition].filter(Boolean).join(' · ');
  if (l.category === 'HDD') return [l.interface, l.formFactor, l.health != null && l.health + '%', l.condition].filter(Boolean).join(' · ');
  return l.condition ?? '';
}

type Props = {
  order: OrderSummary;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

// Compact icon button that lives in the Actions column of the PO table. Owns
// its own modal state and lazy-fetches the full order with lines when opened
// — the table only carries summaries, so we don't pay the lines fetch on rows
// that are never exported.
export function InvoiceExportButton({ order, onToast }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="btn icon sm invoice-trigger"
        title={t('exportInvoice')}
        aria-label={t('exportInvoice')}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        <Icon name="invoice" size={12} />
      </button>
      {open && <InvoiceModal order={order} onClose={() => setOpen(false)} onToast={onToast} />}
    </>
  );
}

function InvoiceModal({ order, onClose, onToast }: { order: OrderSummary; onClose: () => void; onToast?: Props['onToast'] }) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [full, setFull] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);

  // Lazy-load the full order so the summary row doesn't have to carry lines
  // upfront. Aborts cleanly if the modal is closed mid-flight.
  useEffect(() => {
    let alive = true;
    api.get<{ order: Order }>(`/api/orders/${order.id}`)
      .then(r => { if (alive) setFull(r.order); })
      .catch(handleFetchError)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [order.id]);

  // Escape to close. Native form, no helper — this modal is the whole UI.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Add a print-only stylesheet for the lifetime of the modal that hides every
  // sibling chrome and lets only the paper render. Cleaning up on close
  // restores normal viewport printing.
  useEffect(() => {
    const id = 'invoice-print-style';
    if (document.getElementById(id)) return;
    const el = document.createElement('style');
    el.id = id;
    el.media = 'print';
    el.textContent = `
      @page { size: auto; margin: 14mm; }
      html, body { background: #ffffff !important; }
      body * { visibility: hidden !important; }
      [data-invoice-paper], [data-invoice-paper] * { visibility: visible !important; }
      /* Demote backdrop + stage to static so the paper flows from page 1.
         Leaving them fixed makes most print engines clip the document. */
      .invoice-backdrop, .invoice-stage {
        position: static !important;
        background: none !important;
        padding: 0 !important;
        margin: 0 !important;
        max-width: none !important;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        overflow: visible !important;
        animation: none !important;
        height: auto !important;
      }
      [data-invoice-paper] {
        position: static !important;
        width: 100% !important; max-width: none !important;
        margin: 0 !important;
        box-shadow: none !important;
        background:
          radial-gradient(circle, rgba(0,0,0,0.06) 0.5px, transparent 0.6px) 8px 8px/9px 9px,
          #ffffff !important;
      }
      [data-invoice-paper]::after { display: none !important; }
      [data-invoice-noprint] { display: none !important; }
      .invoice-perf { display: none !important; }
      /* Keep the stamp readable on plain paper */
      .invoice-stamp { opacity: 0.85 !important; mix-blend-mode: normal !important; }
    `;
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, []);

  const stamp = lifecycleStamp(order, (k) => t(k));

  // Aggregate the financial bottom line. We treat unitCost × qty as the
  // billable subtotal — the document represents the purchase invoice, so the
  // "amount" is what the company paid, not its onward sell price.
  const subtotal = useMemo(() => {
    if (!full) return order.totalCost ?? 0;
    return full.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
  }, [full, order.totalCost]);

  const issued = new Date(order.createdAt);
  const issuedHuman = issued.toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' });
  const issuedMono = issued.toISOString().slice(0, 10);

  const handlePrint = () => {
    window.print();
    onToast?.(t('invoiceSentToPrint'), 'success');
  };

  return (
    <div
      className="invoice-backdrop"
      data-invoice-noprint
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={t('exportInvoice')}
    >
      <InvoiceStyles />

      <div className="invoice-stage">
        <article className="invoice-paper" data-invoice-paper>
          {/* Perforated tear strip — purely decorative, hidden in print */}
          <span className="invoice-perf" aria-hidden="true" data-invoice-noprint />

          {/* Diagonal lifecycle stamp */}
          <div className={`invoice-stamp tone-${stamp.tone}`} aria-hidden="true">
            <span className="invoice-stamp-inner">{stamp.label}</span>
          </div>

          {/* Masthead */}
          <header className="invoice-masthead">
            <div className="invoice-mast-left">
              <div className="invoice-eyebrow">{t('invoiceEyebrow')}</div>
              <h1 className="invoice-title">
                <span>Invoice</span>
                <em>&amp; bill of sale</em>
              </h1>
            </div>
            <div className="invoice-mast-rule" aria-hidden="true" />
            <dl className="invoice-mast-meta">
              <div>
                <dt>{t('invoiceNo')}</dt>
                <dd className="mono">{order.id}</dd>
              </div>
              <div>
                <dt>{t('invoiceIssued')}</dt>
                <dd>{issuedHuman}</dd>
              </div>
              <div>
                <dt>{t('invoiceCategory')}</dt>
                <dd>{order.category}</dd>
              </div>
            </dl>
          </header>

          {/* Parties */}
          <section className="invoice-parties">
            <PartyBlock
              label={t('invoiceFrom')}
              name={t('appBrand')}
              line2={t('invoiceFromTagline')}
              line3={`Ledger ref. ${order.id}`}
            />
            <PartyBlock
              label={t('invoiceShipTo')}
              name={order.warehouse?.name ?? order.warehouse?.short ?? '—'}
              line2={order.warehouse?.region ?? ''}
              line3={order.warehouse?.address ?? ''}
            />
            <PartyBlock
              label={t('invoicePreparedBy')}
              name={order.userName}
              line2={`${t('payment')}: ${order.payment === 'company' ? t('payCompany') : t('paySelf')}`}
              line3={t('invoicePreparedSub')}
            />
          </section>

          {/* Itemized ledger */}
          <section className="invoice-ledger">
            <div className="invoice-section-head">
              <span className="invoice-section-label">{t('invoiceItemized')}</span>
              <span className="invoice-rule-fill" aria-hidden="true" />
              <span className="invoice-section-meta mono">
                {full ? full.lines.length : order.lineCount} {t('invoiceItemsAbbr')}
              </span>
            </div>

            <div className="invoice-ledger-table-wrap">
              <table className="invoice-ledger-table">
                <thead>
                  <tr>
                    <th className="col-num">№</th>
                    <th className="col-item">{t('item')}</th>
                    <th className="col-pn">{t('partNumber')}</th>
                    <th className="col-qty">{t('qty')}</th>
                    <th className="col-unit">{t('unitCost')}</th>
                    <th className="col-line">{t('invoiceLineTotal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr><td colSpan={6} className="invoice-ledger-loading">{t('loadingLines')}</td></tr>
                  )}
                  {!loading && full && full.lines.length === 0 && (
                    <tr><td colSpan={6} className="invoice-ledger-loading">{t('invoiceNoLines')}</td></tr>
                  )}
                  {!loading && full && full.lines.map((l, i) => {
                    const total = l.qty * l.unitCost;
                    return (
                      <tr key={l.id}>
                        <td className="col-num mono">{String(i + 1).padStart(2, '0')}</td>
                        <td className="col-item">
                          <div className="invoice-item-name">{lineName(l) || '—'}</div>
                          {lineSpec(l) && <div className="invoice-item-spec">{lineSpec(l)}</div>}
                        </td>
                        <td className="col-pn mono">{l.partNumber || '—'}</td>
                        <td className="col-qty mono">{l.qty}</td>
                        <td className="col-unit mono">{fmtUSD(l.unitCost, locale)}</td>
                        <td className="col-line mono">{fmtUSD(total, locale)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Totals + seal */}
          <section className="invoice-foot">
            <div className="invoice-seal" aria-hidden="true">
              <svg viewBox="0 0 120 120" width="92" height="92">
                <defs>
                  <path id={`seal-${order.id}`} d="M60,60 m-42,0 a42,42 0 1,1 84,0 a42,42 0 1,1 -84,0" />
                </defs>
                <circle cx="60" cy="60" r="50" className="invoice-seal-ring" />
                <circle cx="60" cy="60" r="42" className="invoice-seal-ring-inner" />
                <circle cx="60" cy="60" r="6" className="invoice-seal-dot" />
                <text className="invoice-seal-text">
                  <textPath href={`#seal-${order.id}`} startOffset="0">
                    {`· ${order.id} · ${issuedMono} · ${t('appBrand').toUpperCase()} ·`}
                  </textPath>
                </text>
              </svg>
            </div>

            <dl className="invoice-totals">
              <div className="invoice-total-row">
                <dt>{t('invoiceSubtotal')}</dt>
                <dd className="mono">{fmtUSD(subtotal, locale)}</dd>
              </div>
              <div className="invoice-total-row">
                <dt>{t('invoiceHandling')}</dt>
                <dd className="mono muted">{fmtUSD0(0, locale)}</dd>
              </div>
              <div className="invoice-total-row">
                <dt>{t('invoiceTaxNa')}</dt>
                <dd className="mono muted">—</dd>
              </div>
              <div className="invoice-rule-double" aria-hidden="true" />
              <div className="invoice-total-row invoice-total-amount">
                <dt>{t('invoiceAmount')}</dt>
                <dd className="mono">{fmtUSD(subtotal, locale)}</dd>
              </div>
            </dl>
          </section>

          {/* Signature + colophon */}
          <footer className="invoice-colophon">
            <div className="invoice-sig-block">
              <div className="invoice-sig-line" />
              <div className="invoice-sig-label">{t('invoiceReceivedBy')}</div>
            </div>
            <div className="invoice-colophon-meta">
              <div>{t('invoiceColophon')}</div>
              <div className="mono">
                {new Date().toISOString().slice(0, 19).replace('T', ' ')} · {t('appBrand')} ERP
              </div>
            </div>
          </footer>
        </article>

        {/* Action bar — sits outside the paper, screen-only */}
        <div className="invoice-actionbar" data-invoice-noprint>
          <button type="button" className="btn ghost" onClick={onClose}>
            <Icon name="x" size={13} />
            {t('close')}
          </button>
          <div className="invoice-actionbar-meta">
            <span className="invoice-actionbar-dot" />
            <span>{loading ? t('invoiceLoading') : t('invoiceReady')}</span>
          </div>
          <button
            type="button"
            className="btn primary invoice-download"
            onClick={handlePrint}
            disabled={loading}
          >
            <Icon name="download" size={13} />
            {t('downloadInvoice')}
          </button>
        </div>
      </div>
    </div>
  );
}

function PartyBlock({ label, name, line2, line3 }: { label: string; name: string; line2?: string; line3?: string }) {
  return (
    <div className="invoice-party">
      <div className="invoice-party-label">{label}</div>
      <div className="invoice-party-name">{name || '—'}</div>
      {line2 && <div className="invoice-party-line">{line2}</div>}
      {line3 && <div className="invoice-party-line muted">{line3}</div>}
    </div>
  );
}

// Styles are colocated with the component so the editorial paper aesthetic
// stays scoped to the invoice surface and doesn't leak into the rest of the
// desktop UI. Rendered once per modal mount; the browser dedupes identical
// stylesheets so multiple invoices opened in sequence are cheap.
function InvoiceStyles() {
  return (
    <style>{`
      .invoice-backdrop {
        position: fixed; inset: 0; z-index: 200;
        background:
          radial-gradient(circle at 30% 20%, oklch(0.32 0.025 270 / 0.45), transparent 60%),
          radial-gradient(circle at 75% 80%, oklch(0.30 0.030 30 / 0.40), transparent 55%),
          oklch(0.18 0.015 270 / 0.78);
        backdrop-filter: blur(4px) saturate(0.85);
        -webkit-backdrop-filter: blur(4px) saturate(0.85);
        display: grid; place-items: start center;
        padding: 32px 24px 120px;
        overflow-y: auto;
        animation: inv-bd-in 0.22s ease;
      }
      @keyframes inv-bd-in { from { opacity: 0; } to { opacity: 1; } }

      .invoice-stage {
        position: relative;
        width: 100%;
        max-width: 820px;
        animation: inv-paper-in 0.32s cubic-bezier(0.2, 0.7, 0.2, 1);
      }
      @keyframes inv-paper-in {
        from { opacity: 0; transform: translateY(18px) rotate(-0.4deg); }
        to   { opacity: 1; transform: translateY(0) rotate(0); }
      }

      .invoice-paper {
        position: relative;
        background:
          /* faint ledger dot grid */
          radial-gradient(circle, oklch(0.78 0.018 75) 0.5px, transparent 0.6px),
          /* warm cream paper */
          linear-gradient(180deg, oklch(0.975 0.014 82) 0%, oklch(0.962 0.018 82) 100%);
        background-size: 9px 9px, 100% 100%;
        background-position: 8px 8px, 0 0;
        color: oklch(0.18 0.012 280);
        padding: 56px 64px 48px;
        margin-top: 14px;
        font-family: 'Inter', system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.55;
        box-shadow:
          0 1px 0 oklch(0.92 0.014 80),
          0 28px 60px oklch(0.10 0.02 270 / 0.42),
          0 6px 18px oklch(0.10 0.02 270 / 0.20);
        overflow: hidden;
      }

      .invoice-paper::after {
        /* very faint paper-grain mottle via layered radials, multiply blend */
        content: '';
        position: absolute; inset: 0;
        background:
          radial-gradient(circle at 22% 18%, oklch(0.94 0.022 70 / 0.55), transparent 26%),
          radial-gradient(circle at 78% 64%, oklch(0.96 0.020 80 / 0.45), transparent 30%),
          radial-gradient(circle at 50% 92%, oklch(0.93 0.024 60 / 0.40), transparent 22%);
        mix-blend-mode: multiply;
        pointer-events: none;
      }

      .invoice-perf {
        position: absolute; top: 0; left: 0; right: 0; height: 14px;
        background:
          radial-gradient(circle at 9px 9px, oklch(0.18 0.02 270 / 0.85) 0 4px, transparent 4.5px);
        background-size: 22px 14px;
        background-repeat: repeat-x;
        background-color: transparent;
        filter: drop-shadow(0 1px 0 oklch(0.88 0.014 80));
        pointer-events: none;
        z-index: 2;
      }

      /* === Stamp === */
      .invoice-stamp {
        position: absolute;
        top: 118px; right: 56px;
        transform: rotate(-9deg);
        padding: 10px 22px;
        border: 3px double currentColor;
        border-radius: 4px;
        font-family: 'Fraunces', 'Times New Roman', serif;
        font-weight: 700;
        font-size: 28px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        opacity: 0.78;
        mix-blend-mode: multiply;
        pointer-events: none;
        z-index: 5;
        font-variation-settings: 'opsz' 144;
      }
      .invoice-stamp-inner {
        display: block;
        text-shadow:
          0.5px 0 0 currentColor, -0.5px 0 0 currentColor,
          0 0.5px 0 currentColor, 0 -0.5px 0 currentColor;
        /* faux ink grain */
        background-image:
          radial-gradient(circle, transparent 0.4px, oklch(0.99 0.01 80 / 0.3) 0.5px);
        background-size: 2px 2px;
        background-blend-mode: lighten;
        -webkit-background-clip: text;
        background-clip: text;
      }
      .invoice-stamp.tone-pos    { color: oklch(0.42 0.13 165); }
      .invoice-stamp.tone-info   { color: oklch(0.40 0.16 250); }
      .invoice-stamp.tone-warn   { color: oklch(0.42 0.18 22); }
      .invoice-stamp.tone-neg    { color: oklch(0.42 0.18 22); }
      .invoice-stamp.tone-muted  { color: oklch(0.42 0.012 270); }

      /* === Masthead === */
      .invoice-masthead {
        position: relative;
        display: grid;
        grid-template-columns: 1fr 1px auto;
        gap: 28px;
        align-items: stretch;
        padding-bottom: 26px;
        border-bottom: 1px solid oklch(0.20 0.01 270);
      }
      .invoice-mast-left { display: flex; flex-direction: column; gap: 6px; }
      .invoice-eyebrow {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10.5px;
        letter-spacing: 0.32em;
        text-transform: uppercase;
        color: oklch(0.40 0.012 280);
      }
      .invoice-title {
        margin: 0;
        font-family: 'Fraunces', 'Times New Roman', serif;
        font-weight: 600;
        font-size: 56px;
        line-height: 0.96;
        letter-spacing: -0.025em;
        color: oklch(0.16 0.012 270);
        font-variation-settings: 'opsz' 144;
      }
      .invoice-title em {
        display: block;
        margin-top: 8px;
        font-family: 'Fraunces', serif;
        font-style: italic;
        font-weight: 400;
        font-size: 17px;
        letter-spacing: 0.005em;
        color: oklch(0.36 0.018 270);
        font-variation-settings: 'opsz' 24;
      }
      .invoice-mast-rule {
        background: oklch(0.22 0.012 280);
        width: 1px;
        align-self: stretch;
      }
      .invoice-mast-meta {
        margin: 0;
        display: grid;
        grid-auto-rows: min-content;
        gap: 14px;
        align-content: end;
        min-width: 210px;
      }
      .invoice-mast-meta > div { display: flex; flex-direction: column; gap: 2px; }
      .invoice-mast-meta dt {
        font-family: 'JetBrains Mono', monospace;
        font-size: 9.5px;
        letter-spacing: 0.28em;
        text-transform: uppercase;
        color: oklch(0.46 0.012 280);
      }
      .invoice-mast-meta dd {
        margin: 0;
        font-family: 'Fraunces', serif;
        font-size: 16px;
        font-weight: 500;
        color: oklch(0.18 0.012 270);
        font-variation-settings: 'opsz' 24;
      }
      .invoice-mast-meta dd.mono {
        font-family: 'JetBrains Mono', monospace;
        font-size: 14px;
        font-weight: 500;
      }

      /* === Party blocks === */
      .invoice-parties {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 28px;
        margin: 32px 0;
        position: relative;
      }
      .invoice-parties::after {
        /* vertical hairlines between columns */
        content: '';
        position: absolute;
        top: 6px; bottom: 6px; left: 33.333%;
        width: 1px;
        background: repeating-linear-gradient(180deg,
          oklch(0.32 0.012 270) 0 2px, transparent 2px 5px);
      }
      .invoice-parties > .invoice-party:nth-child(2)::before {
        /* second separator */
        content: '';
        position: absolute;
        top: 6px; bottom: 6px;
        right: -14px;
        width: 1px;
        background: repeating-linear-gradient(180deg,
          oklch(0.32 0.012 270) 0 2px, transparent 2px 5px);
      }
      .invoice-party { position: relative; min-width: 0; }
      .invoice-party-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 9.5px;
        letter-spacing: 0.28em;
        text-transform: uppercase;
        color: oklch(0.42 0.012 280);
        margin-bottom: 8px;
      }
      .invoice-party-name {
        font-family: 'Fraunces', serif;
        font-size: 18px;
        font-weight: 600;
        color: oklch(0.16 0.012 270);
        margin-bottom: 4px;
        letter-spacing: -0.005em;
        font-variation-settings: 'opsz' 32;
        word-break: break-word;
      }
      .invoice-party-line {
        font-size: 12.5px;
        color: oklch(0.30 0.012 270);
        line-height: 1.45;
      }
      .invoice-party-line.muted { color: oklch(0.50 0.012 280); }

      /* === Section header (small caps rule) === */
      .invoice-section-head {
        display: flex; align-items: center; gap: 14px;
        margin-bottom: 14px;
      }
      .invoice-section-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.32em;
        text-transform: uppercase;
        color: oklch(0.28 0.012 270);
        white-space: nowrap;
      }
      .invoice-rule-fill {
        flex: 1; height: 1px;
        background: oklch(0.30 0.012 270);
      }
      .invoice-section-meta {
        font-size: 10.5px;
        letter-spacing: 0.10em;
        color: oklch(0.40 0.012 280);
        white-space: nowrap;
      }

      /* === Ledger table === */
      .invoice-ledger { margin-top: 8px; }
      .invoice-ledger-table-wrap {
        position: relative;
        margin-top: 2px;
      }
      .invoice-ledger-table {
        width: 100%;
        border-collapse: collapse;
        font-feature-settings: 'tnum';
      }
      .invoice-ledger-table thead th {
        font-family: 'JetBrains Mono', monospace;
        font-size: 9.5px;
        letter-spacing: 0.20em;
        text-transform: uppercase;
        color: oklch(0.44 0.012 280);
        text-align: left;
        padding: 8px 8px 10px;
        border-bottom: 1px solid oklch(0.32 0.012 270);
        font-weight: 500;
      }
      .invoice-ledger-table thead .col-qty,
      .invoice-ledger-table thead .col-unit,
      .invoice-ledger-table thead .col-line { text-align: right; }
      .invoice-ledger-table tbody td {
        padding: 11px 8px;
        border-bottom: 1px dashed oklch(0.66 0.012 280);
        vertical-align: top;
        font-size: 13px;
      }
      .invoice-ledger-table tbody tr:last-child td { border-bottom: 1.5px solid oklch(0.22 0.012 270); }
      .invoice-ledger-table .col-num { color: oklch(0.46 0.012 280); width: 36px; }
      .invoice-ledger-table .col-pn { color: oklch(0.30 0.012 280); white-space: nowrap; }
      .invoice-ledger-table .col-qty,
      .invoice-ledger-table .col-unit,
      .invoice-ledger-table .col-line { text-align: right; white-space: nowrap; }
      .invoice-ledger-table .col-line {
        font-weight: 600;
        color: oklch(0.16 0.012 270);
      }
      .invoice-item-name {
        font-family: 'Fraunces', serif;
        font-size: 14.5px;
        font-weight: 500;
        line-height: 1.3;
        letter-spacing: -0.005em;
        color: oklch(0.16 0.012 270);
        font-variation-settings: 'opsz' 24;
      }
      .invoice-item-spec {
        margin-top: 2px;
        font-size: 11.5px;
        color: oklch(0.44 0.012 280);
        letter-spacing: 0.01em;
      }
      .invoice-ledger-loading {
        text-align: center;
        padding: 32px !important;
        font-style: italic;
        color: oklch(0.50 0.012 280);
        font-family: 'Fraunces', serif;
        font-variation-settings: 'opsz' 24;
      }

      /* === Foot: seal + totals === */
      .invoice-foot {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 28px;
        margin-top: 28px;
        align-items: start;
      }
      .invoice-seal {
        align-self: start;
        margin-top: 12px;
        opacity: 0.92;
        filter:
          drop-shadow(0 0 0.4px oklch(0.32 0.013 270))
          drop-shadow(0.5px 0.4px 0 oklch(0.32 0.013 270 / 0.4));
      }
      .invoice-seal-ring,
      .invoice-seal-ring-inner {
        fill: none;
        stroke: oklch(0.32 0.013 270);
        stroke-width: 1;
      }
      .invoice-seal-ring-inner { stroke-dasharray: 2 3; }
      .invoice-seal-dot { fill: oklch(0.30 0.013 270); }
      .invoice-seal-text {
        font-family: 'JetBrains Mono', monospace;
        font-size: 8.2px;
        letter-spacing: 0.18em;
        fill: oklch(0.28 0.013 270);
        text-transform: uppercase;
      }

      .invoice-totals {
        margin: 0;
        max-width: 360px;
        margin-left: auto;
        display: flex; flex-direction: column;
        gap: 8px;
      }
      .invoice-total-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 16px;
      }
      .invoice-total-row dt {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: oklch(0.40 0.012 280);
      }
      .invoice-total-row dd {
        margin: 0;
        font-family: 'JetBrains Mono', monospace;
        font-size: 14px;
        color: oklch(0.18 0.012 270);
      }
      .invoice-total-row dd.muted { color: oklch(0.55 0.012 280); }
      .invoice-rule-double {
        height: 4px;
        border-top: 1px solid oklch(0.20 0.012 270);
        border-bottom: 1px solid oklch(0.20 0.012 270);
        margin: 6px 0 2px;
      }
      .invoice-total-amount dt {
        font-family: 'Fraunces', serif !important;
        font-size: 13px !important;
        font-weight: 600 !important;
        letter-spacing: 0.18em !important;
        color: oklch(0.16 0.012 270) !important;
        font-style: italic;
        font-variation-settings: 'opsz' 24;
      }
      .invoice-total-amount dd {
        font-family: 'Fraunces', serif !important;
        font-size: 30px !important;
        font-weight: 600 !important;
        font-variation-settings: 'opsz' 144;
        letter-spacing: -0.015em;
        color: oklch(0.18 0.13 165);
      }

      /* === Colophon === */
      .invoice-colophon {
        margin-top: 44px;
        padding-top: 20px;
        border-top: 1px solid oklch(0.30 0.012 270);
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 24px;
        align-items: end;
      }
      .invoice-sig-block { max-width: 260px; }
      .invoice-sig-line {
        height: 1px;
        background: oklch(0.22 0.012 270);
        margin-bottom: 6px;
      }
      .invoice-sig-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 9.5px;
        letter-spacing: 0.26em;
        text-transform: uppercase;
        color: oklch(0.42 0.012 280);
      }
      .invoice-colophon-meta {
        text-align: right;
        font-size: 10.5px;
        color: oklch(0.42 0.012 280);
        line-height: 1.65;
        font-style: italic;
        font-family: 'Fraunces', serif;
        font-variation-settings: 'opsz' 14;
      }
      .invoice-colophon-meta .mono {
        display: block;
        font-family: 'JetBrains Mono', monospace;
        font-style: normal;
        font-size: 9.5px;
        color: oklch(0.50 0.012 280);
        letter-spacing: 0.08em;
        margin-top: 2px;
      }

      /* === Action bar === */
      .invoice-actionbar {
        margin-top: 22px;
        padding: 14px 18px;
        background: oklch(0.20 0.015 270 / 0.86);
        backdrop-filter: blur(8px);
        border: 1px solid oklch(0.32 0.012 270 / 0.6);
        border-radius: 12px;
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 16px;
        align-items: center;
        box-shadow: 0 14px 40px oklch(0.10 0.02 270 / 0.45);
      }
      .invoice-actionbar .btn {
        background: oklch(0.98 0.01 80);
        border-color: oklch(0.84 0.012 270);
        color: oklch(0.20 0.012 270);
      }
      .invoice-actionbar .btn.ghost {
        background: transparent;
        border-color: oklch(0.50 0.012 270 / 0.5);
        color: oklch(0.94 0.01 80);
      }
      .invoice-actionbar .btn.ghost:hover {
        background: oklch(0.30 0.015 270 / 0.6);
      }
      .invoice-actionbar .btn.primary {
        background: oklch(0.62 0.13 165);
        border-color: oklch(0.52 0.14 165);
        color: oklch(0.99 0.005 100);
        font-weight: 600;
      }
      .invoice-actionbar .btn.primary:hover { background: oklch(0.56 0.14 165); }
      .invoice-actionbar .btn.primary:disabled { opacity: 0.55; cursor: progress; }
      .invoice-actionbar-meta {
        display: flex; align-items: center; gap: 10px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10.5px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: oklch(0.78 0.015 80);
        justify-content: center;
      }
      .invoice-actionbar-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: oklch(0.62 0.13 165);
        box-shadow: 0 0 12px oklch(0.62 0.13 165 / 0.7);
        animation: inv-dot 2s ease-in-out infinite;
      }
      @keyframes inv-dot {
        0%, 100% { opacity: 0.5; transform: scale(0.85); }
        50%      { opacity: 1;   transform: scale(1.1); }
      }

      /* === Tiny screens / responsiveness === */
      @media (max-width: 720px) {
        .invoice-paper { padding: 44px 26px 36px; }
        .invoice-title { font-size: 40px; }
        .invoice-stamp { top: 90px; right: 22px; font-size: 22px; padding: 7px 16px; }
        .invoice-masthead { grid-template-columns: 1fr; gap: 18px; }
        .invoice-mast-rule { display: none; }
        .invoice-parties { grid-template-columns: 1fr; }
        .invoice-parties::after, .invoice-parties > .invoice-party:nth-child(2)::before { display: none; }
        .invoice-foot { grid-template-columns: 1fr; }
        .invoice-seal { margin: 0 auto; }
        .invoice-totals { margin-left: 0; max-width: 100%; }
        .invoice-actionbar { grid-template-columns: 1fr 1fr; }
        .invoice-actionbar-meta { display: none; }
      }

      /* === Trigger button glow — applies to the icon button in the row === */
      .invoice-trigger { color: var(--fg-muted); transition: color 0.14s, background 0.14s, border-color 0.14s; }
      .invoice-trigger:hover {
        color: var(--accent-strong);
        border-color: var(--accent);
        background: color-mix(in oklch, var(--accent-soft) 60%, var(--bg-elev));
      }

      @media (prefers-reduced-motion: reduce) {
        .invoice-backdrop, .invoice-stage, .invoice-actionbar-dot { animation: none !important; }
      }
    `}</style>
  );
}
