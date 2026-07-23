import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentDisposition } from './xlsx';

// Brand logo shipped in the frontend's public assets. Read once and cached —
// the file is resolved off this module's location so CWD/workspace filter don't
// matter (same trick as scripts/load-env.mjs). Returns null if it's missing so
// the invoice falls back to the company wordmark.
let logoCache: Buffer | null | undefined;
export function loadInvoiceLogo(): Buffer | null {
  if (logoCache !== undefined) return logoCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));      // apps/backend/src/lib
    const logoPath = join(here, '..', '..', '..', 'frontend', 'public', 'recycle-servers-icon.png');
    logoCache = readFileSync(logoPath);
  } catch {
    logoCache = null;
  }
  return logoCache;
}

// Server-side PDF generation for the per-PO commercial invoice. Generation
// lives on the backend (like lib/xlsx.ts) so the document is built from
// authoritative, role-scoped data and streamed via api.download(). The layout
// mirrors a classic commercial-invoice template: colored header band, ship-to /
// bill-to blocks, a zebra line table, and a totals box with the amount in words.

async function renderPdfToBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  // pdfkit (with its embedded font data) is loaded lazily so its init cost is
  // paid on the first invoice render, not on every process boot / test fork.
  const { default: PDFDocument } = await import('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

const PDF_MIME = 'application/pdf';

export function pdfResponse(buf: Buffer, filename: string): Response {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': PDF_MIME,
      // Shared header-safe encoding — today's callers pass internal IDs, but a
      // user-derived name must never be able to inject header syntax here.
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(buf.length),
    },
  });
}

export type InvoiceLine = {
  label: string;
  partNumber: string;
  condition: string;
  qty: number;
  unitCost: number;
};

export type InvoicePayment = {
  method: string;          // 'Company pay' | 'Self pay'
  totalQty: number;
  subtotal: number;        // Σ qty × unit cost
  totalCost: number;       // order override, else subtotal
  commissionRate: number | null;
  commissionAmount: number | null;
};

export type InvoiceData = {
  company: string;
  companyDomain: string;
  poId: string;
  date: string;
  status: string;
  buyer: string;
  category: string;
  notes: string;
  warehouseName: string;
  warehouseAddress: string;
  warehouseRegion: string;
  lines: InvoiceLine[];
  payment: InvoicePayment;
  logoPng: Buffer | null;
  generatedAt: string;
};

// ── Palette (matches the reference commercial-invoice template) ──────────────
const PEACH = '#fbeee6';     // header band
const ORANGE = '#e8731c';    // logo / accents
const BURNT = '#bf531a';     // invoice title + total
const INK = '#1f2933';
const MUTED = '#7b8794';
const RULE = '#cbd2d9';
const ZEBRA = '#eef1f2';
const WHITE = '#ffffff';
const LINKBLUE = '#1a3fd0';

const usd = (n: number) =>
  '$ ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Amount in words (e.g. "Eight Hundred And Ninety-Four Dollars and …") ──────
const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below1000(n: number): string {
  let s = '';
  const h = Math.floor(n / 100), r = n % 100;
  if (h) s += `${ONES[h]} Hundred`;
  if (r) {
    if (h) s += ' And ';
    if (r < 20) s += ONES[r];
    else { s += TENS[Math.floor(r / 10)]; if (r % 10) s += `-${ONES[r % 10]}`; }
  }
  return s;
}
function numToWords(n: number): string {
  if (n === 0) return 'Zero';
  const scales: Array<[string, number]> = [['Billion', 1e9], ['Million', 1e6], ['Thousand', 1e3]];
  const parts: string[] = [];
  let rem = n;
  for (const [name, val] of scales) {
    const q = Math.floor(rem / val);
    if (q) { parts.push(`${below1000(q)} ${name}`); rem %= val; }
  }
  if (rem) parts.push(below1000(rem));
  return parts.join(' ');
}
function amountInWords(n: number): string {
  const dollars = Math.floor(n);
  const cents = Math.round((n - dollars) * 100);
  return `${numToWords(dollars)} Dollars and ${numToWords(cents)} Cents`;
}

// Line-items table — cell right-edges/widths chosen so headers never collide.
const T = {
  desc: { x: 40,  w: 240 },
  qty:  { x: 290, w: 60 },
  unit: { x: 358, w: 64 },
  tax:  { x: 430, w: 42 },
  amt:  { x: 480, w: 75 },
};

export function buildPoInvoicePdf(d: InvoiceData): Promise<Buffer> {
  return renderPdfToBuffer((doc) => {
    const PW = doc.page.width;
    const L = doc.page.margins.left;
    const R = PW - doc.page.margins.right;
    const W = R - L;
    const PAGE_BOTTOM = doc.page.height - 64;

    // ── Header band ──────────────────────────────────────────────────────────
    const bandH = 138;
    doc.rect(0, 0, PW, bandH).fill(PEACH);

    // Logo (PNG) when available, else fall back to the company wordmark. The
    // image is fit into a fixed box so any source size lands consistently.
    let logoBottom = 38;
    if (d.logoPng) {
      try {
        doc.image(d.logoPng, L, 30, { fit: [150, 64], valign: 'center' });
        logoBottom = 30 + 64;
      } catch {
        doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(28)
          .text(d.company || 'Invoice', L, 38, { width: W * 0.56 });
        logoBottom = doc.y;
      }
    } else {
      doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(28)
        .text(d.company || 'Invoice', L, 38, { width: W * 0.56 });
      logoBottom = doc.y;
    }
    doc.fillColor(BURNT).font('Helvetica-Bold').fontSize(10)
      .text(d.company || '', L, logoBottom + 4, { width: W * 0.56 });

    // Top-right company block.
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text(d.company || '', L, 40, { width: W, align: 'right' });
    if (d.companyDomain) {
      doc.fillColor(MUTED).text(d.companyDomain, L, 56, { width: W, align: 'right' });
    }

    // ── Invoice title (below band, right-aligned) ────────────────────────────
    doc.fillColor(BURNT).font('Helvetica-Bold').fontSize(23)
      .text(`Invoice ${d.poId}`, L, bandH + 14, { width: W, align: 'right' });

    // ── Address blocks: Shipping (left) + Bill To (right) ────────────────────
    let y = bandH + 56;
    const colR = L + W * 0.52;
    const colW = W * 0.48;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Shipping Address', L, y);
    const shipText = [d.warehouseName, d.warehouseAddress, d.warehouseRegion].filter(Boolean).join('\n') || '—';
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(shipText, L, y + 16, { width: W * 0.46 });
    const leftBottom = doc.y;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Bill To', colR, y);
    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text(d.buyer || '—', colR, y + 16, { width: colW })
      .fillColor(MUTED).text('Purchaser', colR, doc.y, { width: colW });
    const rightBottom = doc.y;

    y = Math.max(leftBottom, rightBottom) + 22;

    // ── Three-column meta row (orange labels) ────────────────────────────────
    const metaCols: Array<[string, string]> = [
      ['Invoice Date', d.date],
      ['Status', d.status],
      ['Category', d.category],
    ];
    const mcW = W / 3;
    metaCols.forEach(([label, value], i) => {
      const x = L + i * mcW;
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(BURNT).text(label, x, y);
      doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(value || '—', x, y + 15, { width: mcW - 10 });
    });
    y += 44;

    // ── Line-items table ─────────────────────────────────────────────────────
    const drawHead = (yy: number): number => {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED);
      doc.text('Description', T.desc.x, yy, { width: T.desc.w });
      doc.text('Quantity',  T.qty.x,  yy, { width: T.qty.w,  align: 'right' });
      doc.text('Unit Price', T.unit.x, yy, { width: T.unit.w, align: 'right' });
      doc.text('Taxes',     T.tax.x,  yy, { width: T.tax.w,  align: 'right' });
      doc.text('Amount',    T.amt.x,  yy, { width: T.amt.w,  align: 'right' });
      const ny = yy + 18;
      doc.moveTo(L, ny).lineTo(R, ny).lineWidth(1).strokeColor(RULE).stroke();
      return ny + 6;
    };
    y = drawHead(y);

    d.lines.forEach((l, i) => {
      const amount = l.qty * l.unitCost;
      const sub = [l.partNumber, l.condition].filter(Boolean).join('  ·  ');
      doc.font('Helvetica').fontSize(10);
      const descH = doc.heightOfString(l.label || '—', { width: T.desc.w });
      const subH = sub ? doc.heightOfString(sub, { width: T.desc.w }) + 1 : 0;
      const rowH = Math.max(descH + subH, 14) + 12;

      if (y + rowH > PAGE_BOTTOM) { doc.addPage(); y = drawHead(doc.page.margins.top); }

      if (i % 2 === 0) doc.rect(L, y - 4, W, rowH).fill(ZEBRA);

      const ty = y + 2;
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(l.label || '—', T.desc.x, ty, { width: T.desc.w });
      if (sub) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(sub, T.desc.x, doc.y + 1, { width: T.desc.w });
      doc.font('Helvetica').fontSize(10).fillColor(INK);
      doc.text(l.qty.toFixed(2), T.qty.x, ty, { width: T.qty.w, align: 'right' });
      doc.text(l.unitCost.toFixed(2), T.unit.x, ty, { width: T.unit.w, align: 'right' });
      doc.fillColor(MUTED).text('—', T.tax.x, ty, { width: T.tax.w, align: 'right' });
      doc.fillColor(INK).text(usd(amount), T.amt.x, ty, { width: T.amt.w, align: 'right' });
      y += rowH;
    });

    y += 10;

    // ── Payment terms (left) + totals box (right) ────────────────────────────
    const boxL = L + W * 0.5;
    const boxW = R - boxL;
    const labelX = boxL + 12;
    const valW = boxW - 24;

    doc.font('Helvetica').fontSize(10).fillColor(INK)
      .text(`Payment terms: ${d.payment.method}`, L, y + 4, { width: W * 0.48 });
    if (d.notes) {
      doc.fillColor(MUTED).fontSize(9).text(d.notes, L, doc.y + 6, { width: W * 0.48 });
    }

    let ty = y;
    // Untaxed Amount (zebra)
    doc.rect(boxL, ty, boxW, 24).fill(ZEBRA);
    doc.font('Helvetica').fontSize(10).fillColor(INK).text('Untaxed Amount', labelX, ty + 7, { width: valW * 0.55 });
    doc.text(usd(d.payment.subtotal), labelX, ty + 7, { width: valW, align: 'right' });
    ty += 24;

    // Optional override row when the order carries a manual total.
    if (Math.abs(d.payment.totalCost - d.payment.subtotal) >= 0.005) {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('Order total (override)', labelX, ty + 7, { width: valW * 0.6 });
      doc.fillColor(INK).text(usd(d.payment.totalCost), labelX, ty + 7, { width: valW, align: 'right' });
      ty += 22;
    }

    // Total (orange, top border)
    doc.moveTo(boxL, ty).lineTo(R, ty).lineWidth(1).strokeColor(RULE).stroke();
    doc.font('Helvetica-Bold').fontSize(12).fillColor(BURNT).text('Total', labelX, ty + 8, { width: valW * 0.5 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(BURNT).text(usd(d.payment.totalCost), labelX, ty + 8, { width: valW, align: 'right' });
    ty += 32;

    // Amount in words (right-aligned under the box)
    doc.moveTo(boxL, ty).lineTo(R, ty).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(10).fillColor(INK).text('Total amount in words:', boxL, ty + 6, { width: boxW, align: 'right' });
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED)
      .text(amountInWords(d.payment.totalCost), boxL, doc.y + 1, { width: boxW, align: 'right' });

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.moveTo(L, PAGE_BOTTOM + 8).lineTo(R, PAGE_BOTTOM + 8).lineWidth(1).strokeColor(INK).stroke();
    doc.font('Helvetica').fontSize(10).fillColor(LINKBLUE)
      .text(d.company || '', L, PAGE_BOTTOM + 14, { width: W * 0.6 });
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`Generated ${d.generatedAt}`, L, PAGE_BOTTOM + 14, { width: W, align: 'right' });
  });
}

