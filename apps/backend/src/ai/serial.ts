// Printed-serial OCR for the phone serial scanner's AI mode — the fallback for
// a module whose QR/DataMatrix is too damaged to decode. Same contract as the
// PayPal read: stub provider when no key, throw on a failed real call (the
// route answers 502 and the user retakes). The user confirms every read
// before it becomes a chip, so no confidence is carried.
import type { Env } from '../types';
import type { OcrProvider } from './types';
import { pickProvider } from './index';
import { openRouterImageJson } from './openrouter';
import { ocrCallsTotal } from '../metrics';

const SERIAL_PROMPT = `You are reading the label on a computer hardware part (a memory module, drive or similar). Extract its SERIAL NUMBER — usually printed next to "SN", "S/N", "Serial" or "Serial No.".
Do NOT return the part number, model number, product number, manufacturing date, capacity, or the text printed under a barcode unless it is labeled as the serial.
If several serial numbers are visible, return the one nearest the center of the image.
Copy the serial exactly as printed, without the "SN:" label.
Respond with a single minified JSON object and nothing else — no markdown, no code fences, no prose:
{"serial":"S3Z8NX0K123456"}
If no serial number is legible, respond {"serial":null}.`;

// Letters/digits plus the separators drive serials carry (WD-WCC4N…). `/` and
// `.` are safe: the serial list splits on newline, comma and semicolon only.
const SERIAL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9\-_./]{3,63}$/;
// The label is stripped only when a separator follows it, so a serial that
// itself begins with "SN" keeps its letters.
const SERIAL_LABEL = /^(?:s\/?n|serial(?:\s*no\.?)?)\s*[:#]\s*|^(?:s\/?n|serial(?:\s*no\.?)?)\s+/i;

// Backstop for model non-compliance: only a plausible serial reaches the
// scanner's confirm card. Case is kept as printed.
export function normalizeSerial(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(SERIAL_LABEL, '').replace(/\s+/g, '');
  return SERIAL_SHAPE.test(cleaned) ? cleaned : null;
}

export type SerialScan = { serial: string | null; provider: OcrProvider };

export async function extractSerial(env: Env, imageBytes: ArrayBuffer): Promise<SerialScan> {
  const provider = pickProvider(env);
  if (provider === 'stub') {
    ocrCallsTotal.inc({ provider, outcome: 'stub' });
    return { serial: 'SN-STUB-0001', provider };
  }
  let json: Record<string, unknown>;
  try {
    json = await openRouterImageJson(env, SERIAL_PROMPT, imageBytes);
    ocrCallsTotal.inc({ provider, outcome: 'ok' });
  } catch (e) {
    ocrCallsTotal.inc({ provider, outcome: 'error' });
    throw e;
  }
  return { serial: normalizeSerial(json.serial), provider };
}
