// Allowlist + validators for per-user UI preferences.
// Adding a new preference is one entry here — no schema migration.
//
// The wire format is a flat, string-keyed map. Each key has a validator that
// accepts the parsed JSON value and returns `true` if it is acceptable. A
// `null` value always means "unset this key" and bypasses the validator.

type Validator = (v: unknown) => boolean;

const isOneOf = <T extends string>(...allowed: T[]): Validator =>
  (v) => typeof v === 'string' && (allowed as readonly string[]).includes(v);

const isStringArray: Validator = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

// Keys map to validators. Unknown keys are rejected.
const SCHEMA: Record<string, Validator> = {
  'language':                 isOneOf('en', 'zh'),
  'tweaks.density':           isOneOf('comfortable', 'compact'),
  'tweaks.rolePreview':       isOneOf('actual', 'as_purchaser'),
  'inventory.cols.manager':   isStringArray,
  'inventory.cols.purchaser': isStringArray,
  'orders.cols':              isStringArray,
};

export type PreferencePatchResult =
  | { ok: true; cleaned: Record<string, unknown> }
  | { ok: false; status: 400; error: string };

// Validates an incoming PATCH body. Returns the cleaned subset to merge
// (preserving the `null`-means-unset signal) or a 400 error describing the
// offending key.
export function validatePreferencePatch(body: unknown): PreferencePatchResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const validator = SCHEMA[key];
    if (!validator) {
      return { ok: false, status: 400, error: `unknown preference: ${key}` };
    }
    if (value === null) {
      cleaned[key] = null;
      continue;
    }
    if (!validator(value)) {
      return { ok: false, status: 400, error: `invalid value for ${key}` };
    }
    cleaned[key] = value;
  }
  return { ok: true, cleaned };
}

export function preferenceKeys(): string[] {
  return Object.keys(SCHEMA);
}
