import {
  FB_CHAT_CONFIG_KEY,
  FB_CHAT_CONFIG_TYPES,
  FB_CHAT_CONFIG_VALUE_MAX,
  FB_CHAT_EVENT_KINDS,
  FB_CHAT_MAX_WAIT_SEC,
  FB_CHAT_REPLY_MAX_CHARS,
  type FbChatAccountRef,
  type FbChatBuyer,
  type FbChatBuyerPush,
  type FbChatClaimRequest,
  type FbChatConfigField,
  type FbChatConfigRequest,
  type FbChatConfigType,
  type FbChatEnrollRequest,
  type FbChatEventKind,
  type FbChatEventPush,
  type FbChatRow,
  type FbChatSendResult,
  type FbChatSyncPush,
} from '@recycle-erp/shared';

// Parsers for what the extensions push. The extension reads these values off a
// Facebook page, so every string is a stranger's text: bounded, never trusted
// for shape.

export class FbChatPushError extends Error {}

const MAX_ROWS = 2000;
const MAX_BODY = 8000;
const MAX_IMAGES = 10;
export const FB_CHAT_REPLY_MAX = FB_CHAT_REPLY_MAX_CHARS;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new FbChatPushError(`${what} must be an object`);
  return v;
}

function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(v)) throw new FbChatPushError(`${what} is not an id`);
  return v;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, max);
  return t || null;
}

function int(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function account(v: unknown): FbChatAccountRef {
  const a = obj(v, 'account');
  if (typeof a.fbUid !== 'string' || !/^\d{1,32}$/.test(a.fbUid)) throw new FbChatPushError('account.fbUid is not a Facebook uid');
  return { fbUid: a.fbUid, label: text(a.label, 80) ?? '', extVersion: text(a.extVersion, 32) ?? undefined };
}

function buyer(v: unknown): FbChatBuyer {
  const b = isObj(v) ? v : {};
  const rating = typeof b.rating === 'number' && b.rating >= 0 && b.rating <= 5 ? Math.round(b.rating * 10) / 10 : null;
  return {
    name: text(b.name, 120),
    profileId: typeof b.profileId === 'string' && /^\d{1,32}$/.test(b.profileId) ? b.profileId : null,
    location: text(b.location, 120),
    joinedYear: int(b.joinedYear, 2004, 2100),
    rating,
    ratingCount: int(b.ratingCount, 0, 10_000_000),
  };
}

function rows(v: unknown): FbChatRow[] {
  if (!Array.isArray(v) || v.length > MAX_ROWS) throw new FbChatPushError(`thread.rows must be an array of at most ${MAX_ROWS}`);
  return v.map((raw): FbChatRow => {
    const r = obj(raw, 'row');
    if (r.direction !== 'in' && r.direction !== 'out') throw new FbChatPushError('row.direction must be in or out');
    const images = Array.isArray(r.images)
      ? r.images.filter((u): u is string => typeof u === 'string' && /^https:\/\/[^\s]{1,2000}$/.test(u)).slice(0, MAX_IMAGES)
      : [];
    return {
      direction: r.direction, text: typeof r.text === 'string' ? r.text.slice(0, MAX_BODY) : '', images,
      at: text(r.at, 80) ?? undefined,
    };
  }).filter((r) => r.text.trim() || r.images.length);
}

export function parseSyncPush(v: unknown): FbChatSyncPush {
  const p = obj(v, 'body');
  const t = obj(p.thread, 'thread');
  const listing = isObj(t.listing) ? t.listing : {};
  return {
    account: account(p.account),
    thread: {
      fbThreadId: id(t.fbThreadId, 'thread.fbThreadId'),
      buyer: buyer(t.buyer),
      listing: {
        id: typeof listing.id === 'string' && /^\d{1,32}$/.test(listing.id) ? listing.id : null,
        title: text(listing.title, 200),
      },
      rows: rows(t.rows),
      full: t.full === true,
      complete: t.complete === true,
    },
  };
}

export function parseBuyerPush(v: unknown): FbChatBuyerPush {
  const p = obj(v, 'body');
  return { account: account(p.account), fbThreadId: id(p.fbThreadId, 'fbThreadId'), buyer: buyer(p.buyer) };
}

export function parseClaim(v: unknown): Required<Pick<FbChatClaimRequest, 'account' | 'wait'>> {
  const p = obj(v, 'body');
  return { account: account(p.account), wait: int(p.wait, 0, FB_CHAT_MAX_WAIT_SEC) ?? 0 };
}

export function parseSendResult(v: unknown): FbChatSendResult {
  const p = obj(v, 'body');
  if (p.outcome !== 'sent' && p.outcome !== 'failed' && p.outcome !== 'uncertain') {
    throw new FbChatPushError('outcome must be sent, failed or uncertain');
  }
  return {
    account: account(p.account),
    outcome: p.outcome,
    error: text(p.error, 300) ?? undefined,
    typingMs: int(p.typingMs, 0, 3_600_000) ?? undefined,
  };
}

export function parseEventPush(v: unknown): FbChatEventPush {
  const p = obj(v, 'body');
  if (!FB_CHAT_EVENT_KINDS.includes(p.kind as FbChatEventKind)) throw new FbChatPushError('unknown event kind');
  const detail = isObj(p.detail) ? p.detail : {};
  if (JSON.stringify(detail).length > 4000) throw new FbChatPushError('detail is too large');
  return {
    account: account(p.account),
    kind: p.kind as FbChatEventKind,
    fbThreadId: p.fbThreadId === undefined ? undefined : id(p.fbThreadId, 'fbThreadId'),
    detail,
  };
}

const MAX_CONFIG_FIELDS = 200;

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** A JSON value small enough to keep, or the reason it is not. */
export function fbChatConfigValueProblem(value: unknown): string | null {
  if (value === undefined) return 'is missing';
  const json = JSON.stringify(value);
  if (json === undefined) return 'is not JSON';
  return json.length > FB_CHAT_CONFIG_VALUE_MAX ? `is longer than ${FB_CHAT_CONFIG_VALUE_MAX} characters as JSON` : null;
}

function configField(v: unknown): FbChatConfigField {
  const f = obj(v, 'field');
  if (typeof f.key !== 'string' || !FB_CHAT_CONFIG_KEY.test(f.key)) throw new FbChatPushError('field.key is not a setting key');
  if (!FB_CHAT_CONFIG_TYPES.includes(f.type as FbChatConfigType)) throw new FbChatPushError(`field ${f.key}: unknown type`);
  const problem = fbChatConfigValueProblem(f.default);
  if (problem) throw new FbChatPushError(`field ${f.key}: default ${problem}`);
  const options = Array.isArray(f.options)
    ? f.options.filter((o): o is string => typeof o === 'string').map((o) => o.slice(0, 80)).slice(0, 50)
    : undefined;
  return {
    key: f.key,
    label: text(f.label, 80) ?? f.key,
    help: text(f.help, 400) ?? undefined,
    type: f.type as FbChatConfigType,
    default: f.default,
    min: finite(f.min),
    max: finite(f.max),
    unit: text(f.unit, 16) ?? undefined,
    options: options?.length ? options : undefined,
  };
}

export function parseConfigRequest(v: unknown): FbChatConfigRequest {
  const p = obj(v, 'body');
  if (!Array.isArray(p.fields) || p.fields.length > MAX_CONFIG_FIELDS) {
    throw new FbChatPushError(`fields must be an array of at most ${MAX_CONFIG_FIELDS}`);
  }
  const fields = p.fields.map(configField);
  if (new Set(fields.map((f) => f.key)).size !== fields.length) throw new FbChatPushError('fields repeat a key');
  const extVersion = text(p.extVersion, 32);
  if (!extVersion) throw new FbChatPushError('extVersion is missing');
  return { account: p.account === undefined ? undefined : account(p.account), extVersion, fields };
}

/** `<buyer> · <location>`, within Telegram's 128-character topic name. */
export function fbChatTopicName(buyerName: string | null, location: string | null, fbThreadId: string): string {
  const who = buyerName?.trim() || `Buyer ${fbThreadId}`;
  const where = location?.trim();
  return (where ? `${who} · ${where}` : who).slice(0, 128);
}

/** Cuts text into pieces Telegram accepts, on line breaks where it can. */
export function chunkForTelegram(textToSend: string, max = 4000): string[] {
  const chunks: string[] = [];
  let rest = textToSend;
  while (rest.length > max) {
    const cut = rest.lastIndexOf('\n', max);
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * `POST /enroll` and `/push/device`. Nothing here is trusted, so a field that
 * does not fit is dropped rather than refused: the approver sees less.
 */
export function parseEnrollRequest(v: unknown): Required<{ [K in keyof FbChatEnrollRequest]: string | null }> {
  const r = isObj(v) ? v : {};
  const uid = typeof r.fbUid === 'string' && /^\d{1,32}$/.test(r.fbUid) ? r.fbUid : null;
  return { label: text(r.label, 80), extVersion: text(r.extVersion, 32), fbUid: uid };
}
