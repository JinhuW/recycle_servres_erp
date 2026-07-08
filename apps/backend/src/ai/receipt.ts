// Payment-receipt OCR for status-note attachments. Reads the uploaded
// screenshot and renames it `<upload date>-<method>-<amount>.<ext>` so the
// attachment list is scannable. Rename is strictly best-effort: any OCR
// problem (no key, timeout, bad JSON, unreadable receipt) keeps the original
// filename — an upload must never fail, and a canned stub name would be
// worse than no rename, so unlike scanLabel there is no stub provider here.
import type { Env } from '../types';
import { openRouterImageJson } from './openrouter';
import { ocrCallsTotal } from '../metrics';

export const RECEIPT_METHODS = [
  'alipay', 'weixinpay', 'bank', 'zelle', 'paypal', 'venmo', 'cash', 'other',
] as const;
export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];

const RECEIPT_PROMPT = `You are reading a payment receipt or payment-confirmation screenshot. It may be a Chinese Alipay (支付宝) or WeChat Pay (微信支付) screenshot, or an English bank transfer / Zelle / PayPal / Venmo confirmation. Respond with a single minified JSON object and nothing else — no markdown, no code fences, no prose:
{"method":"alipay|weixinpay|bank|zelle|paypal|venmo|cash|other","amount":"1250.00"}
METHOD — pick exactly one:
  alipay — Alipay / 支付宝 UI.
  weixinpay — WeChat Pay / 微信支付 UI.
  zelle — Zelle transfers; a bank-app screenshot with Zelle branding is zelle, not bank.
  bank — wire / ACH / bank-transfer confirmations without Zelle branding.
  paypal, venmo, cash — accordingly.
  other — clearly a payment receipt but the method is unclassifiable.
AMOUNT — the main payment amount as a plain decimal with exactly 2 decimal places. Strip currency symbols (¥, ￥, $, 元) and thousands separators; convert full-width digits to ASCII: "¥1,250.00" → "1250.00", "$980" → "980.00", "１２５０元" → "1250.00". If several amounts appear, choose the amount actually paid/transferred (the prominent figure), not fees, balances, or totals-before-discount.
If the image is not a payment receipt, or you cannot read the amount or method, respond {"method":null,"amount":null}.`;

// Full-width digits/punctuation → ASCII, so 「１，２５０」 parses like "1,250".
function toAsciiDigits(s: string): string {
  return s
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/．/g, '.')
    .replace(/，/g, ',');
}

// Backstop for model non-compliance: whatever comes back, only a clean
// positive decimal renames. Result matches ^\d+\.\d{2}$ — filename-safe by
// construction.
export function normalizeAmount(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  // A negative figure is a refund/reversal, not a payment — and the symbol
  // strip below would silently drop the sign.
  if (String(raw).includes('-')) return null;
  const cleaned = toAsciiDigits(String(raw))
    .replace(/[^0-9.,]/g, '')
    .replace(/,/g, '');
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(2);
}

// MIME is allowlist-validated upstream (SAFE_UPLOAD_MIME), so the map is
// exhaustive for anything that reaches us.
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function buildReceiptName(
  method: ReceiptMethod,
  amount: string,
  originalName: string,
  mime: string,
  now: Date = new Date(),
): string {
  const date = now.toISOString().slice(0, 10);
  const extMatch = originalName.match(/\.([A-Za-z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : EXT_BY_MIME[mime];
  // Currency is intentionally absent — the requested format is
  // date-method-amount; the order's own currency context disambiguates.
  return `${date}-${method}-${amount}.${ext}`;
}

export async function maybeRenameReceipt(env: Env, file: File): Promise<File> {
  if (!env.OPENROUTER_API_KEY) return file;
  // Images only: receipts here are app screenshots; PDF input needs a
  // different OpenRouter content shape + parser plugin for marginal gain.
  if (file.type === 'application/pdf') return file;

  const bytes = await file.arrayBuffer();
  let json: Record<string, unknown>;
  try {
    json = await openRouterImageJson(env, RECEIPT_PROMPT, bytes);
    ocrCallsTotal.inc({ provider: 'openrouter', outcome: 'ok' });
  } catch {
    ocrCallsTotal.inc({ provider: 'openrouter', outcome: 'error' });
    return file;
  }

  const method = typeof json.method === 'string' && (RECEIPT_METHODS as readonly string[]).includes(json.method)
    ? (json.method as ReceiptMethod)
    : null;
  const amount = normalizeAmount(json.amount);
  if (!method || !amount) return file;

  return new File([bytes], buildReceiptName(method, amount, file.name, file.type), { type: file.type });
}
